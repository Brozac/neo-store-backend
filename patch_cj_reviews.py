#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_cj_reviews.py — كيت 34 [cj-reviews]
دمج ريفيوزات CJ الحقيقية في /api/reviews/:productId (قراءة فقط — بلا كتابة DB)
+ راوت مباشر GET /api/cj-live/reviews/:pid في البريدج.

الأهداف (backend فقط — الفرونت صفر تعديل):
  1. routes/cjLiveBridge.js  ← v3.4 [cj-reviews]: كاش 6h + precision-fix + normalize + route
  2. server.js               ← getCjMergedReviews() + سطر الدمج

المنهجية (نفس كيتات 31/32/33):
  · fail-closed: أي أنكور ≠ 1 → لا كتابة إطلاقاً + diag بامتداد .txt (درس كيت 30)
  · backup .bak-kit34 — أول نسخة فقط، ما تتخطاش أبداً
  · idempotent: ماركر [cj-reviews] موجود → NOTHING TO DO
  · --check: RAW / PATCHED / MISSING / UNKNOWN لكل هدف
  · CRLF محفوظ بالبايتات
"""
import sys
import os
import shutil

MARKER = "[cj-reviews]"

# ══════════════════════════════════════════════════════════════════
# الهدف 1 — routes/cjLiveBridge.js
# ══════════════════════════════════════════════════════════════════

BRIDGE_ANCHOR_CACHE = 'const freightCache = new Map();       // "pid|vid|src|dest" → { data, ts }'

BRIDGE_BLOCK_A = '''
// ── ⭐ ريفيوزات CJ [cj-reviews] — productComments GET — كاش 6 ساعات ──
//    (الريفيوزات كتبدل بالأيام — 6h كافية وحيانية مع النقاط)
const REVIEWS_TTL = 6 * 60 * 60 * 1000;
const reviewsCache = new Map();       // "pid|page|size|score" → { data, ts }

// 🛡️ درس الوثيقة: commentId = long 19 خانة (1536993287524069376) أكبر من
//    Number.MAX_SAFE_INTEGER (16 خانة) — JSON.parse كيقصّو بصمت.
//    الحل: الجواب كيتقري كنص وكنقتبسو الأرقام الطوال قبل JSON.parse.
function parseCjCommentsText(txt) {
  const safe = String(txt).replace(/("[A-Za-z_]*[Ii]d"\\s*:\\s*)(\\d{15,})/g, '$1"$2"');
  return JSON.parse(safe);
}

// ⭐ جيب ريفيوزات CJ مطبّعين — كيستهلكو server.js (الدمج في /api/reviews/:id)
//    والراوت GET /reviews/:pid مباشرة. الاستجابة:
//    { total, page, size, reviews: [{ id, name, score, date, text, images, country, flag }] }
async function fetchCjReviews(pid, opts = {}) {
  const page = Math.max(parseInt(opts.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(opts.size, 10) || 20, 1), 50);
  const scoreN = parseInt(opts.score, 10) || 0;
  const score = scoreN >= 1 && scoreN <= 5 ? scoreN : null;
  const key = `${pid}|${page}|${size}|${score || ''}`;
  const hit = cacheGet(reviewsCache, key, REVIEWS_TTL);
  if (hit) return hit;

  const params = { pid, pageNum: page, pageSize: size };
  if (score) params.score = score;
  const r = await cjRequest((token, config) =>
    axios.get(`${CJ_API}/product/productComments`, {
      ...config,
      headers: { 'CJ-Access-Token': token },
      params,
      timeout: 15000,
      responseType: 'text',            // 🛡️ precision-safe — كنحللو بيدينا
      transformResponse: [(x) => x],   // axios ما يلمسش الجواب
    })
  );

  // 🔍 envelope ديال CJ — ⚠️ الوثيقة: النجاح success:true والخطأ result:false!
  //    الثابت الوحيد الموثوق: code===0 (وكنقبلو 200 للتوافقية مع ES-backed)
  let env = null;
  try { env = parseCjCommentsText(r?.data); } catch (pe) {
    console.error('[cj-live/reviews][parse]', pe.message);
  }
  const envCode = env?.code ?? null;
  if (!env || (envCode !== 0 && envCode !== 200) || env.result === false) {
    console.error('[cj-live/reviews][cj-envelope]', envCode, env?.message || '');
    const err = new Error(`CJ envelope ${envCode}: ${String(env?.message || 'unknown')}`);
    err.cjCode = envCode;
    throw err;
  }

  const d = env?.data || {};
  const list = Array.isArray(d.list) ? d.list : [];
  const reviews = list
    .map(c => ({
      id: String(c.commentId ?? ''),
      name: String(c.commentUser || 'CJ Buyer').slice(0, 60),
      score: Math.min(Math.max(parseInt(c.score, 10) || 0, 1), 5),
      date: String(c.commentDate || ''),
      text: String(c.comment || '').slice(0, 1000),
      images: (Array.isArray(c.commentUrls) ? c.commentUrls : [])
        .filter(u => typeof u === 'string' && u.startsWith('http')).slice(0, 6),
      country: c.countryCode ? (geo.countryName(String(c.countryCode)) || String(c.countryCode)) : '',
      flag: typeof c.flagIconUrl === 'string' ? c.flagIconUrl : '',
    }))
    .filter(x => x.id && x.date && x.score >= 1);

  const out = { total: parseInt(d.total, 10) || reviews.length, page, size, reviews };
  cacheSet(reviewsCache, key, out);
  return out;
}
'''

BRIDGE_ANCHOR_TAIL = 'module.exports = router;'

BRIDGE_BLOCK_B = '''// ════════════════════════════════════════════════════════════
// ⭐ GET /api/cj-live/reviews/:pid?page=&size=&score=   [cj-reviews]
//    وكيل ريفيوزات CJ مباشر (تشخيص + استهلاك مستقبلي للفرونت)
// ════════════════════════════════════════════════════════════
router.get('/reviews/:pid', async (req, res) => {
  try {
    const pid = String(req.params.pid || '').trim();
    if (!pid || pid.length < 5) return res.status(400).json({ error: 'Bad pid' });
    const data = await fetchCjReviews(pid, {
      page: req.query.page, size: req.query.size, score: req.query.score,
    });
    return res.json(data);
  } catch (e) {
    console.error('[cj-live/reviews]', e.message);
    return res.status(502).json({ error: 'CJ unavailable', cjCode: e.cjCode ?? null });
  }
});

module.exports = router;
module.exports.fetchCjReviews = fetchCjReviews; // ⭐ [cj-reviews] — server.js كيستهلكو للدمج'''

# ══════════════════════════════════════════════════════════════════
# الهدف 2 — server.js
# ══════════════════════════════════════════════════════════════════

SERVER_ANCHOR_EP = "app.get('/api/reviews/:productId', async (req, res) => {"

SERVER_BLOCK_C = '''// ─── ⭐ [cj-reviews] دمج ريفيوزات CJ الحقيقية — قراءة فقط، بلا كتابة في الـ DB ───
// الفرونت (Customer Reviews في PDP) كتقرا نفس هذا الـ endpoint — صفر تعديل فرونت.
// الحقول مطبّعين على شكل صفوف الجدول: id/author/rating/content/country/images/created_at
async function getCjMergedReviews(productId) {
  try {
    const { fetchCjReviews } = require('./routes/cjLiveBridge');
    const q = await pool.query('SELECT cj_product_id FROM products WHERE id = $1 LIMIT 1', [productId]);
    const cjPid = q.rows && q.rows[0] && q.rows[0].cj_product_id ? String(q.rows[0].cj_product_id) : null;
    if (!cjPid) return []; // منتج بلا ربط CJ → ريفيوزات محلية فقط
    const cj = await fetchCjReviews(cjPid, { size: 20 });
    return (cj.reviews || []).map(r => ({
      id: `cj-${r.id}`,
      product_id: Number(productId) || 0,
      author: r.name,
      rating: r.score,
      content: r.text,
      country: r.country,
      images: r.images,
      created_at: r.date,
      source: 'cj',
    }));
  } catch (e) {
    console.warn('[cj-reviews] merge skipped:', e.message);
    return []; // 🛟 تدهور صامت — الريفيوزات المحلية باقة تخدم
  }
}

'''

SERVER_ANCHOR_MERGE = (
    "    const result = await pool.query('SELECT id, product_id, author, rating, content, "
    "country, images, created_at FROM reviews WHERE product_id = $1 ORDER BY created_at DESC', "
    "[productId]);\n    res.json(result.rows);"
)

SERVER_BLOCK_D = (
    "    const result = await pool.query('SELECT id, product_id, author, rating, content, "
    "country, images, created_at FROM reviews WHERE product_id = $1 ORDER BY created_at DESC', "
    "[productId]);\n"
    "    // ⭐ [cj-reviews] — المحليون أولاً (زبائن حقيقيون) ثم ريفيوزات CJ (كاش 6 ساعات)\n"
    "    const cjRows = await getCjMergedReviews(productId);\n"
    "    res.json([...result.rows, ...cjRows]);"
)


# ══════════════════════════════════════════════════════════════════
# محرك الرقعة
# ══════════════════════════════════════════════════════════════════

class Diag:
    def __init__(self, root):
        self.dir = os.path.join(root, "kit34-diag")
        self.lines = []
        self.root = root

    def note(self, msg):
        self.lines.append(msg)
        print(msg)

    def dump(self, relpath, content_bytes, why):
        try:
            os.makedirs(self.dir, exist_ok=True)
            base = os.path.basename(relpath).replace(".", "_")
            out = os.path.join(self.dir, base + ".kit34-diag.txt")
            with open(out, "wb") as f:
                f.write(content_bytes)
            self.note(f"  📋 diag: {os.path.relpath(out, self.root)} ({why})")
        except OSError as e:
            self.note(f"  ⚠️ diag write failed: {e}")

    def summary(self):
        try:
            os.makedirs(self.dir, exist_ok=True)
            out = os.path.join(self.dir, "REPORT.txt")
            with open(out, "w", encoding="utf-8") as f:
                f.write("\n".join(self.lines) + "\n")
        except OSError:
            pass


def detect_root():
    """لقاء جذر الـ backend: cwd + طلاعة للفوق (سكناريو Extract All تاع Windows
    كينشئ مجلد باسم الزيب داخل الجذر) + ./backend / ./neo-store-backend*"""
    cwd = os.getcwd()
    chain = [cwd, os.path.dirname(cwd), os.path.dirname(os.path.dirname(cwd))]
    cands = []
    for c in chain:
        cands.append(c)
        cands.append(os.path.join(c, "backend"))
    try:
        for name in sorted(os.listdir(cwd)):
            if name.startswith("neo-store-backend") and os.path.isdir(os.path.join(cwd, name)):
                cands.append(os.path.join(cwd, name))
    except OSError:
        pass
    for c in cands:
        if (os.path.isfile(os.path.join(c, "server.js"))
                and os.path.isfile(os.path.join(c, "routes", "cjLiveBridge.js"))):
            return c
    return None


def load(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8")
    crlf = "\r\n" in text
    return raw, text, crlf


def adapt(s, crlf):
    """حوّل البلوك/الأنكور لـ CRLF إلا الملف CRLF"""
    return s.replace("\n", "\r\n") if crlf else s


def backup_once(path, rel):
    bak = path + ".bak-kit34"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print(f"  💾 backup: {rel}.bak-kit34 (الأصل محفوظ — أول مرة)")
    else:
        print(f"  💾 backup موجود مسبقاً — ما تخطاش: {rel}.bak-kit34")


def count_occurrences(hay, needle):
    if not needle:
        return 0
    n = 0
    i = hay.find(needle)
    while i != -1:
        n += 1
        i = hay.find(needle, i + 1)
    return n


def main():
    args = [a for a in sys.argv[1:]]
    check_only = "--check" in args
    root_arg = None
    if "--root" in args:
        i = args.index("--root")
        if i + 1 < len(args):
            root_arg = args[i + 1]

    root = root_arg or detect_root()
    if not root:
        print("❌ ما لقيتش جذر الـ backend (server.js + routes/cjLiveBridge.js)")
        print("   حلّ الـ zip داخل جذر الـ backend ولا استعمل --root <path>")
        return 1

    bridge_rel = os.path.join("routes", "cjLiveBridge.js")
    server_rel = "server.js"
    bridge_path = os.path.join(root, bridge_rel)
    server_path = os.path.join(root, server_rel)

    print("═══════════════════════════════════════════════════")
    print("  كيت 34 [cj-reviews] — دمج ريفيوزات CJ (backend)")
    print(f"  root: {root}")
    print("═══════════════════════════════════════════════════")

    if not os.path.isfile(bridge_path):
        print(f"❌ MISSING: {bridge_rel}")
        return 1
    if not os.path.isfile(server_path):
        print(f"❌ MISSING: {server_rel}")
        return 1

    diag = Diag(root)
    b_raw, b_text, b_crlf = load(bridge_path)
    s_raw, s_text, s_crlf = load(server_path)

    # ── فحص الحالة ──
    b_patched = MARKER in b_text
    s_patched = MARKER in s_text

    b_state = "PATCHED" if b_patched else (
        "RAW" if (count_occurrences(b_text, adapt(BRIDGE_ANCHOR_CACHE, b_crlf)) == 1
                  and count_occurrences(b_text, adapt(BRIDGE_ANCHOR_TAIL, b_crlf)) == 1) else "UNKNOWN")
    s_state = "PATCHED" if s_patched else (
        "RAW" if (count_occurrences(s_text, adapt(SERVER_ANCHOR_EP, s_crlf)) == 1
                  and count_occurrences(s_text, adapt(SERVER_ANCHOR_MERGE, s_crlf)) == 1) else "UNKNOWN")

    print(f"  bridge : {b_state}{' (CRLF)' if b_crlf else ''}")
    print(f"  server : {s_state}{' (CRLF)' if s_crlf else ''}")

    if check_only:
        return 0

    if b_state == "UNKNOWN" or s_state == "UNKNOWN":
        print("❌ FAIL-CLOSED: أنكور مفقود أو مكرر — صفر كتابة.")
        if b_state == "UNKNOWN":
            diag.note(f"bridge UNKNOWN — anchors: cache×{count_occurrences(b_text, BRIDGE_ANCHOR_CACHE)} "
                      f"tail×{count_occurrences(b_text, BRIDGE_ANCHOR_TAIL)}")
            diag.dump(bridge_rel, b_raw, "anchors failed")
        if s_state == "UNKNOWN":
            diag.note(f"server UNKNOWN — anchors: ep×{count_occurrences(s_text, SERVER_ANCHOR_EP)} "
                      f"merge×{count_occurrences(s_text, SERVER_ANCHOR_MERGE)}")
            diag.dump(server_rel, s_raw, "anchors failed")
        diag.summary()
        print(f"   📨 صيفط مجلد {diag.dir} للمطوّر — رقعة مخصصة بلا تخمين.")
        return 1

    if b_state == "PATCHED" and s_state == "PATCHED":
        print("✅ NOTHING TO DO — [cj-reviews] مركب من قبل (idempotent)")
        return 0

    # ── تطبيق ──
    new_b, new_s = b_text, s_text

    if b_state == "RAW":
        backup_once(bridge_path, bridge_rel)
        new_b = b_text.replace(adapt(BRIDGE_ANCHOR_CACHE, b_crlf),
                               adapt(BRIDGE_ANCHOR_CACHE, b_crlf) + adapt(BRIDGE_BLOCK_A, b_crlf), 1)
        new_b = new_b.replace(adapt(BRIDGE_ANCHOR_TAIL, b_crlf), adapt(BRIDGE_BLOCK_B, b_crlf), 1)
        if MARKER not in new_b:
            print("❌ حماية داخلية: الماركر ما دخلش للـ bridge — إلغاء")
            return 1
        with open(bridge_path, "wb") as f:
            f.write(new_b.encode("utf-8"))
        print("  ✚ bridge: كاش 6h + precision-fix + fetchCjReviews + راوت /reviews/:pid + export")

    if s_state == "RAW":
        backup_once(server_path, server_rel)
        new_s = s_text.replace(adapt(SERVER_ANCHOR_EP, s_crlf),
                               adapt(SERVER_BLOCK_C, s_crlf) + adapt(SERVER_ANCHOR_EP, s_crlf), 1)
        new_s = new_s.replace(adapt(SERVER_ANCHOR_MERGE, s_crlf), adapt(SERVER_BLOCK_D, s_crlf), 1)
        if MARKER not in new_s:
            print("❌ حماية داخلية: الماركر ما دخلش لـ server.js — إلغاء")
            # تراجع فوري للـ bridge إلا كتب
            if b_state == "RAW" and new_b != b_text:
                with open(bridge_path, "wb") as f:
                    f.write(b_raw)
                print("   ↩️ bridge رجع للأصل")
            return 1
        with open(server_path, "wb") as f:
            f.write(new_s.encode("utf-8"))
        print("  ✚ server: getCjMergedReviews() + سطر الدمج (المحليون أولاً)")

    print("═══════════════════════════════════════════════════")
    print("✅ ركب [cj-reviews] بنجاح")
    print("   الخطوات: node --check server.js routes/cjLiveBridge.js")
    print("            → git add . → push → Render redeploy")
    print("            → python verify_cj_reviews.py")
    print("   التراجع: انسخ .bak-kit34 فوق الملف الأصلي (ملفين)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
