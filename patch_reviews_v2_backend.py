#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_reviews_v2_backend.py — كيت 36 [cj-reviews-v2] — هدف واحد: server.js
meta الإجمالي الحقيقي + size 50 — فوق كيت 34 بالضبط.

واش كيبدل (هونكات جراحية على server.js فقط — البريدج ما كيتلمسش):
  1. getCjMergedReviews() ← size 20→50 (نفس نداء CJ الواحد، نفس الكاش 6h)
                          ← كترجع { rows, total } بدل array — total = الإجمالي الحقيقي من CJ
  2. GET /api/reviews/:productId
     · بلا ?v2 → res.json(merged) — **نفس الشكل القديم array حرفياً** (توافق رجعي 100%)
     · مع ?v2=1 → { reviews, meta } — meta.total = المحليون + CJ total · counts للنجوم
                  · hasMore صادق إلا CJ عندها أكثر من اللي تحمّل

علاش آمن:
  · الفرونت القديم (v1) يبقى خدّام بلا حتى حرف — الشكل الافتراضي ما تبداش
  · الفرونت الجديد (v2) كيفهم الشكلين (array قديم / {reviews,meta}) → أي ترتيب deploy يمر
  · fail-closed + backup .bak-kit36 + idempotent + --check + diag .txt (درس كيت 30)

المنهجية (نفس كيتات 34/33/32/31):
  · pure-stdlib · أنكور ≠ 1 → صفر كتابة · CRLF محفوظ بالبايتات
"""
import sys
import os
import shutil

MARKER = "[cj-reviews v2]"

# ══════════════════════════════════════════════════════════════════
# الهونكات — كل واحد: (الاسم، القديم، الجديد)
# ══════════════════════════════════════════════════════════════════

HUNKS = [
    # ── H1: منتج بلا ربط CJ → شكل {rows,total} ──
    (
        "H1-no-cjpid",
        "  if (!cjPid) return []; // منتج بلا ربط CJ → ريفيوزات محلية فقط",
        "  if (!cjPid) return { rows: [], total: 0 }; // منتج بلا ربط CJ → ريفيوزات محلية فقط [cj-reviews v2]",
    ),
    # ── H2: size 20 → 50 (نفس نداء CJ الواحد — الكاش نفسو 6h) ──
    (
        "H2-size50",
        "    const cj = await fetchCjReviews(cjPid, { size: 20 });",
        "    const cj = await fetchCjReviews(cjPid, { size: 50 }); // [cj-reviews v2] 50 بدل 20 — تغطية أوسع بنفس نداء CJ الواحد (الكاش 6h نفسو)",
    ),
    # ── H3: بداية البناء — rows متغير ──
    (
        "H3-rows-var",
        "    return (cj.reviews || []).map(r => ({",
        "    const rows = (cj.reviews || []).map(r => ({",
    ),
    # ── H4: نهاية البناء — رجّع { rows, total } ──
    (
        "H4-return-meta",
        """      created_at: r.date,
      source: 'cj',
    }));""",
        """      created_at: r.date,
      source: 'cj',
    }));
    return { rows, total: cj.total || rows.length }; // [cj-reviews v2] الصفوف + الإجمالي الحقيقي من CJ (ماشي غير المحمّل)""",
    ),
    # ── H5: التدهور الصامت → شكل {rows,total} ──
    (
        "H5-degrade",
        "    return []; // 🛟 تدهور صامت — الريفيوزات المحلية باقة تخدم",
        "    return { rows: [], total: 0 }; // 🛟 تدهور صامت — الريفيوزات المحلية باقة تخدم [cj-reviews v2]",
    ),
    # ── H6: الراوت — ?v2=1 → {reviews, meta} / بلاها → array قديم ──
    (
        "H6-route-v2",
        """    const cjRows = await getCjMergedReviews(productId);
    res.json([...result.rows, ...cjRows]);""",
        """    const cj = await getCjMergedReviews(productId); // [cj-reviews v2] { rows, total }
    const merged = [...result.rows, ...cj.rows];

    // ⭐ [cj-reviews v2] — ?v2=1 → { reviews, meta }: meta.total = الإجمالي الحقيقي
    //    (المحليون + total تاع CJ) ماشي غير المحمّل. بلا ?v2 → array القديم (توافق رجعي كامل).
    if (req.query.v2 === '1' || req.query.v2 === 'true') {
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const r of merged) {
        const k = parseInt(r.rating, 10) || 0;
        if (k >= 1 && k <= 5) counts[k]++;
      }
      return res.json({
        reviews: merged,
        meta: {
          total: result.rows.length + (cj.total || cj.rows.length),
          loaded: merged.length,
          counts,
          local: result.rows.length,
          cj: cj.rows.length,
          hasMore: cj.total > cj.rows.length, // CJ عندها أكثر مما حُمّل → عرض جزئي صادق
        },
      });
    }
    res.json(merged);""",
    ),
]

# أنكورات كيت 34 (شرط RAW — v2 كيتبنى فوق v1)
KIT34_ANCHORS = [
    "async function getCjMergedReviews(productId) {",
    "app.get('/api/reviews/:productId', async (req, res) => {",
    "    const cjRows = await getCjMergedReviews(productId);",
]


# ══════════════════════════════════════════════════════════════════
# محرك الرقعة (نفس نمط كيت 34)
# ══════════════════════════════════════════════════════════════════

class Diag:
    def __init__(self, root):
        self.dir = os.path.join(root, "kit36-diag")
        self.lines = []
        self.root = root

    def note(self, msg):
        self.lines.append(msg)
        print(msg)

    def dump(self, relpath, content_bytes, why):
        try:
            os.makedirs(self.dir, exist_ok=True)
            base = os.path.basename(relpath).replace(".", "_")
            out = os.path.join(self.dir, base + ".kit36-diag.txt")
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
    """لقاء جذر الـ backend: cwd + طلاعة للفوق (سكناريو Extract All تاع Windows)
    + ./backend + neo-store-backend*"""
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
    return s.replace("\n", "\r\n") if crlf else s


def backup_once(path, rel):
    bak = path + ".bak-kit36"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print(f"  💾 backup: {rel}.bak-kit36 (الأصل محفوظ — أول مرة)")
    else:
        print(f"  💾 backup موجود مسبقاً — ما تخطاش: {rel}.bak-kit36")


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

    server_rel = "server.js"
    server_path = os.path.join(root, server_rel)

    print("═══════════════════════════════════════════════════")
    print("  كيت 36 [cj-reviews-v2] — meta الإجمالي الحقيقي (backend)")
    print(f"  root: {root}")
    print("═══════════════════════════════════════════════════")

    if not os.path.isfile(server_path):
        print(f"❌ MISSING: {server_rel}")
        return 1

    # شرط: كيت 34 مركب — v2 كيتبنى فوقو
    _, bridge_probe, _ = load(os.path.join(root, "routes", "cjLiveBridge.js"))
    if "module.exports.fetchCjReviews" not in bridge_probe:
        print("❌ كيت 34 [cj-reviews] ماشي مركب — ركبو أولاً (patch_cj_reviews.py) ثم عاود هادا.")
        return 1

    diag = Diag(root)
    s_raw, s_text, s_crlf = load(server_path)

    # ── فحص الحالة ──
    s_patched = MARKER in s_text
    anchors_ok = all(count_occurrences(s_text, adapt(a, s_crlf)) == 1 for a in KIT34_ANCHORS)
    v1_bodies_ok = all(
        count_occurrences(s_text, adapt(old, s_crlf)) == 1 for _name, old, _new in HUNKS
    )

    s_state = "PATCHED" if s_patched else ("RAW" if (anchors_ok and v1_bodies_ok) else "UNKNOWN")

    print(f"  server : {s_state}{' (CRLF)' if s_crlf else ''} — {len(HUNKS)} hunks")

    if check_only:
        return 0

    if s_state == "UNKNOWN":
        print("❌ FAIL-CLOSED: أنكور مفقود أو مكرر — صفر كتابة.")
        missing = [
            (n, count_occurrences(s_text, old))
            for n, old, _new in HUNKS
            if count_occurrences(s_text, adapt(old, s_crlf)) != 1
        ]
        diag.note(f"server UNKNOWN — hunks mismatch: {missing} | kit34 anchors: "
                  f"{[(a[:40], count_occurrences(s_text, a)) for a in KIT34_ANCHORS]}")
        diag.dump(server_rel, s_raw, "anchors failed")
        diag.summary()
        print(f"   📨 صيفط مجلد {diag.dir} للمطوّر — رقعة مخصصة بلا تخمين.")
        return 1

    if s_state == "PATCHED":
        print("✅ NOTHING TO DO — [cj-reviews v2] مركب من قبل (idempotent)")
        return 0

    # ── تطبيق: كل هونك بالضبط مرة ──
    backup_once(server_path, server_rel)
    new_s = s_text
    for name, old, new in HUNKS:
        old_a = adapt(old, s_crlf)
        new_a = adapt(new, s_crlf)
        if count_occurrences(new_s, old_a) != 1:
            print(f"❌ FAIL-CLOSED: هونك {name} ما لقاش الأنكور ديالو بالضبط — إلغاء كلي.")
            diag.note(f"hunk {name} failed — old×{count_occurrences(new_s, old_a)}")
            diag.dump(server_rel, s_raw, f"hunk {name} failed")
            diag.summary()
            return 1
        new_s = new_s.replace(old_a, new_a, 1)

    if MARKER not in new_s:
        print("❌ حماية داخلية: الماركر ما دخلش لـ server.js — إلغاء")
        return 1

    with open(server_path, "wb") as f:
        f.write(new_s.encode("utf-8"))
    print("  ✚ server: getCjMergedReviews → { rows, total } + size 50")
    print("  ✚ server: GET /api/reviews/:productId → ?v2=1 يعطي {reviews, meta} · بلاها array القديم")

    print("═══════════════════════════════════════════════════")
    print("✅ ركب [cj-reviews v2] backend بنجاح")
    print("   الخطوات: node --check server.js")
    print("            → git add . → push → Render redeploy")
    print("            → python verify_reviews_v2.py")
    print("   التراجع: انسخ server.js.bak-kit36 فوق الأصل")
    return 0


if __name__ == "__main__":
    sys.exit(main())
