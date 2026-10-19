#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
direct_patch_s4_hub.py — Laclarc Section 4: GET /api/categories/hub (backend server.js)

الواجد:
  كيزيد endpoint واحد جديد /api/categories/hub قبل /api/admin/backfill-categories.
  • الشجرة الكاملة (getCategoryTree) + slugPath كامل لكل عقدة (l1/l2/l3)
  • counts حقيقية من DB — نفس سيمانتيك العدّاد الحي ديال PLP (prefix match)
  • صور تمثيلية للجذور (L1) — نفس نمط /api/categories
  • كاش ذاكرة 6 سوايع + Cache-Control s-maxage=21600 SWR 86400
  • فشل counts ولا images = غير fatal — الشجرة كترجع ديما (counts:false)

الاستعمال (من جذر الباكند، فين كاين server.js):
  python direct_patch_s4_hub.py             ← dry-run (PLAN بلا كتابة)
  python direct_patch_s4_hub.py --apply     ← تطبيق حقيقي + backup
  python direct_patch_s4_hub.py --path DIR  ← مسار بديل (default: المجلد الحالي)

الضمانات:
  • idempotent — التطبيق الثاني = SKIP بلا كتابة
  • backup تلقائي server.js.bak-s4hub (غير فأول تطبيق)
  • all-or-nothing — أي خطأ = صفر كتابة + exit 2
  • CRLF/LF + BOM محفوظين كما هم
  • توازن الأقواس كيتحقق قبل الكتابة

Exit codes: 0 نجاح/idempotent · 1 I/O · 2 guard
"""

import sys
import os
import shutil

MARKER = "S4 — CATEGORIES HUB ENDPOINT"
ANCHOR = "app.post('/api/admin/backfill-categories', async (req, res) => {"
HUB_ROUTE_TAG = "/api/categories/hub"
BACKUP_SUFFIX = ".bak-s4hub"

# ─────────────────────────────────────────────────────────────────────────────
# الكتلة الجديدة — مبنية بـ LF ثم كتتحول لـ EOL ديال الملف
# ─────────────────────────────────────────────────────────────────────────────
BLOCK_JS = """
// ═══════════════════════════════════════════════════════════════════
// S4 — CATEGORIES HUB ENDPOINT (Section 4 — /categories hub)
// GET /api/categories/hub
//  • الشجرة الكاملة + slugPath كامل لكل عقدة (l1/l2/l3)
//  • counts حقيقية من DB — نفس سيمانتيك العدّاد الحي (prefix match على category)
//    استعلام واحد GROUP BY على distinct categories ثم prefix-sum فالذاكرة
//  • صور تمثيلية للجذور (L1) — نفس نمط /api/categories (LATERAL)
//  • كاش ذاكرة 6 سوايع + s-maxage=21600, SWR 86400
//  • فشل counts/images = غير fatal — الشجرة كترجع ديما (counts:false)
// ═══════════════════════════════════════════════════════════════════
let hubS4Cache = null;
let hubS4CacheTime = 0;
const HUB_S4_CACHE_TTL = 6 * 60 * 60 * 1000;

app.get('/api/categories/hub', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    if (hubS4Cache && (Date.now() - hubS4CacheTime < HUB_S4_CACHE_TTL)) {
      return res.json(hubS4Cache);
    }

    const tree = await getCategoryTree();

    // 1) counts — استعلام واحد: distinct category + عدد المنتجات لكل واحد
    //    (lower() على الجنبين = نفس معنى ILIKE الحي)
    let countsMap = null;
    let totalProducts = 0;
    try {
      const { rows } = await pool.query(
        "SELECT lower(category) AS cat, COUNT(*)::int AS n " +
        "FROM products " +
        "WHERE stock_status = true AND category IS NOT NULL AND category <> '' " +
        "GROUP BY lower(category)"
      );
      countsMap = new Map();
      for (const r of rows) countsMap.set(r.cat, r.n);
      totalProducts = rows.reduce((s, r) => s + r.n, 0);
    } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
      console.warn('hub counts query failed (non-fatal):', e.message);
      countsMap = null;
    }

    // 2) صور تمثيلية للجذور فقط (L1) — نفس نمط /api/categories
    const imgMap = new Map();
    try {
      const { rows: imgs } = await pool.query(
        "SELECT c.slug, img.image_url " +
        "FROM categories c " +
        "LEFT JOIN LATERAL ( " +
        "  SELECT p.image_url FROM products p " +
        "  WHERE p.stock_status = true " +
        "    AND p.image_url IS NOT NULL AND p.image_url <> '' " +
        "    AND (p.category = c.slug OR p.category LIKE c.slug || '-%' OR p.category LIKE c.slug || '/%') " +
        "  ORDER BY p.sort_order DESC NULLS LAST, p.is_sourced DESC, " +
        "    (p.video_url IS NOT NULL AND p.video_url <> '') DESC, " +
        "    COALESCE(array_length(p.images, 1), 0) DESC, p.id DESC " +
        "  LIMIT 1 " +
        ") img ON true " +
        "WHERE c.level = 1"
      );
      for (const r of imgs) imgMap.set(r.slug, r.image_url);
    } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
      console.warn('hub images query failed (non-fatal):', e.message);
    }

    // 3) بناء الشجرة: slugPath كامل + count لكل عقدة
    //    prefix raw (بلا boundary) — مطابق 1:1 للعدّاد الحي ILIKE 'path%'
    let totalCategories = 0;
    const attachS4 = (nodes, prefix) => {
      for (const n of nodes || []) {
        if (!n || !n.slug) continue;
        totalCategories++;
        n.slugPath = prefix ? (prefix + '/' + n.slug) : n.slug;
        if (countsMap) {
          let c = 0;
          const p = n.slugPath.toLowerCase();
          for (const [cat, cnt] of countsMap) {
            if (cat.startsWith(p)) c += cnt;
          }
          n.count = c;
        } else {
          n.count = null;
        }
        if (imgMap.has(n.slug)) n.image_url = imgMap.get(n.slug);
        if (Array.isArray(n.children) && n.children.length) {
          attachS4(n.children, n.slugPath);
        }
      }
    };
    attachS4(Array.isArray(tree) ? tree : [], '');

    hubS4Cache = {
      nodes: Array.isArray(tree) ? tree : [],
      counts: !!countsMap,
      totals: countsMap ? { categories: totalCategories, products: totalProducts } : null,
    };
    hubS4CacheTime = Date.now();
    return res.json(hubS4Cache);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════ END S4 CATEGORIES HUB ═══════════════
"""


def fail(msg, code=2):
    print(f"[ERROR] {msg}")
    print("[ABORTED] — ما تبدل حتى حرف. الملف الأصلي سليم.")
    return code


def load_text(path):
    raw = open(path, "rb").read()
    had_bom = raw.startswith(b"\xef\xbb\xbf")
    if had_bom:
        raw = raw[3:]
    text = raw.decode("utf-8")
    return text, had_bom


def brace_delta(js):
    """توازن الأقواس خارج النصوص والتعليقات — للكتلة الجديدة برك وللمقارنة قبل/بعد."""
    depth = 0
    i, n = 0, len(js)
    in_s = None  # ' " `
    while i < n:
        ch = js[i]
        if in_s:
            if ch == "\\":
                i += 2
                continue
            if ch == in_s:
                in_s = None
            i += 1
            continue
        if ch in "'\"`":
            in_s = ch
            i += 1
            continue
        if ch == "/" and i + 1 < n and js[i + 1] == "/":
            j = js.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if ch == "/" and i + 1 < n and js[i + 1] == "*":
            j = js.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                return -1
        i += 1
    return depth


def main():
    args = sys.argv[1:]
    apply = "--apply" in args
    base = "."
    if "--path" in args:
        i = args.index("--path")
        if i + 1 >= len(args):
            print("[ERROR] --path خاصو قيمة")
            return 2
        base = args[i + 1]

    src = os.path.join(base, "server.js")
    print(f"[TARGET] {os.path.abspath(src)}")
    if not os.path.isfile(src):
        return fail(f"server.js ما كاينش فـ {os.path.abspath(base)} — خدم من جذر الباكند", 1)

    try:
        text, had_bom = load_text(src)
    except OSError as e:
        return fail(f"قراءة فاشلة: {e}", 1)

    # ── idempotence ───────────────────────────────────────────────────
    if MARKER in text:
        print("[SKIP] الباتش مطبق من قبل (S4 marker موجود) — والو ما يتبدل.")
        print(f"[OK] {HUB_ROUTE_TAG} راه موجود فـ server.js")
        return 0

    if HUB_ROUTE_TAG in text:
        return fail(
            HUB_ROUTE_TAG + " كاين فالملف بلا marker S4 — حالة غير معروفة. "
            "صيفط محتوى server.js حول هاد السطر قبل أي تطبيق."
        )

    # ── anchor ────────────────────────────────────────────────────────
    count = text.count(ANCHOR)
    if count == 0:
        return fail("الـ anchor (app.post('/api/admin/backfill-categories'...) ما تلقاش — "
                    "server.js تبدل من النسخة المعروفة. صيفط السطور 950-990 ديال الملف.")
    if count > 1:
        return fail(f"الـ anchor تلقا {count} مرات — خاصو يكون مرة وحدة بالضبط.")

    idx = text.index(ANCHOR)
    line_start = text.rfind("\n", 0, idx) + 1  # بداية سطر الـ anchor

    eol = "\r\n" if "\r\n" in text else "\n"
    block = BLOCK_JS
    if eol == "\r\n":
        block = block.replace("\n", eol)

    # ── validation قبل الكتابة ────────────────────────────────────────
    d = brace_delta(BLOCK_JS)
    if d != 0:
        return fail(f"الكتلة الجديدة ماشي متوازنة (brace delta = {d}) — باغ مشكل داخلي.")
    d_orig = brace_delta(text)

    new_text = text[:line_start] + block.lstrip("\r\n").lstrip("\n") + text[line_start:]
    # BLOCK_JS كيسالي بـ newline — الـ anchor كيبقى مفصول بسطر واحد نظيف

    # تحقق نهائي: marker راجع + anchor باقي مرة وحدة
    if MARKER not in new_text or new_text.count(ANCHOR) != 1:
        return fail("التحقق النهائي فاشل — التحويل ما جاش نظيف.")
    d2 = brace_delta(new_text)
    if d2 != d_orig:
        return fail(f"توازن الأقواس ديال الملف تبدل (قبل={d_orig} بعد={d2}).")

    added = len(new_text) - len(text)
    print(f"[PLAN] كيتزاد endpoint {HUB_ROUTE_TAG} قبل backfill-categories")
    print(f"[PLAN] EOL={'CRLF' if eol == chr(13)+chr(10) else 'LF'} · BOM={'نعم' if had_bom else 'لا'} · +{added} حرف · +63 سطر تقريباً")
    print(f"[PLAN] backup: server.js{BACKUP_SUFFIX} (غير فأول تطبيق)")

    if not apply:
        print("[DRY-RUN] والو ما تكتب — شغّل بـ --apply باش يطبق.")
        return 0

    backup = src + BACKUP_SUFFIX
    if not os.path.exists(backup):
        shutil.copy2(src, backup)
        print(f"[BACKUP] {backup}")
    else:
        print(f"[BACKUP] كاين من قبل — ما تبدلش: {backup}")

    try:
        data = new_text.encode("utf-8")
        if had_bom:
            data = b"\xef\xbb\xbf" + data
        with open(src, "wb") as f:
            f.write(data)
    except OSError as e:
        return fail(f"كتابة فاشلة: {e} — backup كاين فـ {backup}", 1)

    print("[APPLIED] ✓ endpoint " + HUB_ROUTE_TAG + " تزاد فـ server.js")
    print("[NEXT] node --check server.js  ← تأكد قبل الـ commit")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
