#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_cj_reviews.py — التحقق اللايف ديال كيت 34 [cj-reviews] بعد الديبلوي
كيتصnba على الإنتاج مباشرة (بلا توكنات — endpoints عامة):

  [1] GET /api/cj-live/reviews/:cjPid   → البريدج المباشر (شكل الجواب + precision)
  [2] GET /api/reviews/:productId       → الدمج (ريفيوزات CJ داخل جواب الجدول المحلي)

الاستعمال:
  python verify_cj_reviews.py                       # منتجات افتراضية معروفة مرتبطة بـ CJ
  python verify_cj_reviews.py 45747 51151 83062     # منتجات من عندك
  python verify_cj_reviews.py --base http://localhost:10000
"""
import sys
import json
import urllib.request

BASE = "https://neo-store-backend.onrender.com"
DEFAULT_PRODUCTS = [45747, 83062, 51151]  # معروفين مرتبطين بـ CJ من worklog

args = [a for a in sys.argv[1:]]
if "--base" in args:
    i = args.index("--base")
    BASE = args[i + 1].rstrip("/")
    args = args[:i] + args[i + 2:]
PRODUCTS = [int(a) for a in args if a.isdigit()] or DEFAULT_PRODUCTS

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    tag = "✅" if cond else "❌"
    if cond:
        PASS += 1
    else:
        FAIL += 1
    print(f"  {tag} {name}" + (f" — {extra}" if extra else ""))


def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "laclarc-verify/kit34"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


print("════════════════════════════════════════════════════")
print(f"  كيت 34 [cj-reviews] — التحقق اللايف ضد {BASE}")
print("════════════════════════════════════════════════════")

cj_pids = {}
for pid in PRODUCTS:
    print(f"\n── 📦 المنتج {pid} ──")
    try:
        st, prod = get(f"{BASE}/api/products/{pid}")
        cj_pid = str(prod.get("cj_product_id") or "") if isinstance(prod, dict) else ""
        ok(f"[{pid}] /api/products يرد", st == 200, f"cj_product_id={cj_pid or '—'}")
        if cj_pid:
            cj_pids[pid] = cj_pid
    except Exception as e:
        ok(f"[{pid}] /api/products", False, str(e)[:90])

    # [2] الدمج — /api/reviews/:id
    try:
        st, revs = get(f"{BASE}/api/reviews/{pid}")
        is_list = isinstance(revs, list)
        cj_rows = [r for r in revs if isinstance(r, dict) and r.get("source") == "cj"] if is_list else []
        ok(f"[{pid}] /api/reviews يرد مصفوفة", st == 200 and is_list,
           f"local={len(revs) - len(cj_rows) if is_list else '?'} · cj={len(cj_rows)}")
        if cj_rows:
            r0 = cj_rows[0]
            shape_ok = all(k in r0 for k in ("id", "author", "rating", "content", "images", "created_at"))
            id_ok = isinstance(r0.get("id"), str) and r0["id"].startswith("cj-")
            ok(f"[{pid}] صفوف CJ بالشكل المحلي", shape_ok and id_ok,
               f"sample: {r0.get('author')} · ⭐{r0.get('rating')} · {r0.get('country')}")
    except Exception as e:
        ok(f"[{pid}] /api/reviews", False, str(e)[:90])

print("\n── 🌉 البريدج المباشر /api/cj-live/reviews ──")
for pid, cj_pid in list(cj_pids.items())[:2]:
    try:
        st, data = get(f"{BASE}/api/cj-live/reviews/{cj_pid}?size=5")
        ok(f"[{pid}] بريدج 200", st == 200, f"total={data.get('total')}")
        revs = data.get("reviews") or []
        precision_ok = all(isinstance(r.get("id"), str) and len(r["id"]) >= 10 for r in revs)
        ok(f"[{pid}] commentId strings (precision-safe)", precision_ok or not revs,
           f"n={len(revs)}")
        if revs:
            r0 = revs[0]
            print(f"      عينة: {r0.get('name')} · ⭐{r0.get('score')} · {r0.get('country')} · "
                  f"صور={len(r0.get('images') or [])} · \"{(r0.get('text') or '')[:40]}…\"")
    except Exception as e:
        ok(f"[{pid}] بريدج مباشر", False, str(e)[:90])

print("════════════════════════════════════════════════════")
print(f"  النتيجة: {PASS} PASS / {FAIL} FAIL")
if FAIL == 0:
    print("  🎉 [cj-reviews] خدّام لايف — ريفيوزات CJ داخل صفحات المنتجات")
else:
    print("  ⚠️ شوف الأسطر ❌ — إلا cjCode ظهر، الرسالة فيها سبب CJ مباشرة")
print("════════════════════════════════════════════════════")
sys.exit(0 if FAIL == 0 else 1)
