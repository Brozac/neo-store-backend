#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_cj_pid_health.py — كيت 35 [cj-pid-guard] — جرد صحي تاع روابط CJ + جرد الريفيوزات
=======================================================================================
الهدف: أداة واحدة كتجاوب على 3 أسئلة على الكاطالوج كامل:
  1) الصيغ: كل cj_product_id راه صيغة CJ رسمية؟ (رقمية 15-20 خانة 🡒 الكاطالوج القديم
     · UUID 8-4-4-4-12 🡒 كاطالوج ES الجديد — الزوج صحيحين!)
  2) الحياة (--deep): كل pid باقي حي على CJ؟ (منتج محيّد = PDP كتدور على estimate
     بصمت + 20pt مضيعة فكل زيارة — هادي هي الفشيلة الوحيدة الحقيقية)
  3) الريفيوزات: شكون عندو ريفيوزات CJ دابا؟ (productComments مكاشية 6h — رخيصة)

⚠️ درسين موثقين (عمرهم ما تنعاو — قرا README قبل ما تشخص):
  · listV2/البريدج كيتيقبل ?q= ماشي ?keyWord= — keyWord هو الباراميتر الداخلي تاع CJ
  · pids بصيغة UUID صيغة رسمية جديدة ماشي داتا خايبة — ما تحيدش بالقوة!

الاستعمال:
  python verify_cj_pid_health.py                 # جرد خفيف: صيغ + ريفيوزات (رخيص)
  python verify_cj_pid_health.py --deep          # + فحص الحياة (≈20pt/منتج مربوط)
  python verify_cj_pid_health.py --deep --yes    # بلا سؤال تأكيد
  python verify_cj_pid_health.py --base URL      # باك آخر (افتراضي neo-store)
الخروج: 0 = صحي · 1 = لقينا مشاكل حقيقية (صيغة غريبة / pid ميت)
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE_DEFAULT = "https://neo-store-backend.onrender.com"
H = {"User-Agent": "Mozilla/5.0 (cj-pid-guard kit35)", "Accept": "application/json"}

# ✅ الصيغ الرسمية تاع CJ (درس كيت 35: الزوج صحيحين)
RE_NUMERIC = re.compile(r"^\d{15,20}$")
RE_UUID = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")


def get(base, path, timeout=90):
    url = f"{base}{path}"
    req = urllib.request.Request(url, headers=H)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, None
    except Exception as e:
        return 0, {"_err": repr(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE_DEFAULT)
    ap.add_argument("--deep", action="store_true", help="فحص الحياة (~20pt لكل منتج مربوط)")
    ap.add_argument("--yes", action="store_true", help="بلا سؤال تأكيد على --deep")
    ap.add_argument("--json", default="", help="تسجيل النتيجة فملف JSON")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    problems = []
    rows = []
    census = {"total": 0, "numeric": 0, "uuid": 0, "unmapped": 0, "bad": 0, "alive": 0, "dead": 0,
              "with_reviews": 0, "reviews_total": 0}

    print("═" * 60)
    print("  كيت 35 [cj-pid-guard] — جرد روابط CJ + الريفيوزات")
    print(f"  ضد {base} · deep={args.deep}")
    print("═" * 60)

    st, cat = get(base, "/api/products?limit=100&page=1")
    if st != 200 or not isinstance(cat, list):
        print(f"❌ /api/products ما جاوبش ({st}) — نتوقفو")
        return 1
    ids = [p.get("id") for p in cat if isinstance(p, dict) and p.get("id")]
    print(f"📦 الكاطالوج: {len(ids)} منتج\n")

    if args.deep and not args.yes:
        est = len(ids) * 20
        a = input(f"⚠️ --deep غادي يضرب product/query لكل منتج (≈{est} نقطة). كمّل؟ [y/N] ")
        if a.strip().lower() not in ("y", "yes"):
            print("تلغى — جري بلا --deep ولا زيد --yes")
            args.deep = False

    for i in ids:
        std, jd = get(base, f"/api/products/{i}")
        p = (jd or {}).get("product", jd) if isinstance(jd, dict) else {}
        cp = str((p or {}).get("cj_product_id") or "")
        title = (p.get("title") or "")[:38]
        row = {"id": i, "title": title, "pid": cp, "fmt": None, "alive": None,
               "reviews": None, "with_images": None}

        if not cp:
            row["fmt"] = "unmapped"
            census["unmapped"] += 1
            print(f"  · [{i}] {title:<38} — بلا ربط CJ (عادي إلا منتج محلي)")
        elif RE_NUMERIC.match(cp):
            row["fmt"] = "numeric"
            census["numeric"] += 1
        elif RE_UUID.match(cp):
            row["fmt"] = "uuid"
            census["uuid"] += 1
        else:
            row["fmt"] = "BAD"
            census["bad"] += 1
            problems.append(f"[{i}] cj_product_id بصيغة موش معروفة: {cp}")
            print(f"  ⚠️ [{i}] {title:<38} صيغة غريبة: {cp}")

        if row["fmt"] in ("numeric", "uuid"):
            # الريفيوزات — مكاشية 6h، رخيصة، وكنهفضو 500/غلط
            time.sleep(0.3)
            str_, jsr = get(base, f"/api/cj-live/reviews/{urllib.request.quote(cp)}")
            if str_ == 200 and isinstance(jsr, dict):
                rv = jsr.get("reviews") or []
                row["reviews"] = int(jsr.get("total") or 0)
                row["with_images"] = sum(1 for r in rv if r.get("images"))
                census["reviews_total"] += row["reviews"]
                if row["reviews"] > 0:
                    census["with_reviews"] += 1
            else:
                problems.append(f"[{i}] /reviews رد {str_} على pid صحيح الصيغة")

            if args.deep:
                stp, jsp = get(base, f"/api/cj-live/product/{urllib.request.quote(cp)}?country=MA")
                if stp == 200 and isinstance(jsp, dict) and jsp.get("pid"):
                    row["alive"] = True
                    census["alive"] += 1
                elif stp == 404:
                    row["alive"] = False
                    census["dead"] += 1
                    problems.append(f"[{i}] pid ميت على CJ (404): {cp} — PDP غادي تدور على estimate بصمت")
                else:
                    row["alive"] = f"?{stp}"  # شبكة/نقاط — ماشي دليل موت
                    problems.append(f"[{i}] فحص الحياة رد {stp} (شوف يدوياً): {cp}")
                time.sleep(0.4)

        rows.append(row)

    # ── التقرير ──
    print("\n" + "═" * 60)
    print("📊 جرد الصيغ:")
    print(f"   رقمية (كاطالوج قديم): {census['numeric']} · UUID (كاطالوج ES جديد): {census['uuid']}"
          f" · بلا ربط: {census['unmapped']} · صيغ غريبة: {census['bad']}")
    print(f"💬 الريفيوزات: {census['with_reviews']} منتج عندهم · المجموع {census['reviews_total']} ريفيوز")
    for r in rows:
        if (r.get("reviews") or 0) > 0:
            print(f"   🎉 [{r['id']}] {r['title']} — {r['reviews']} ريفيوز ({r['with_images']} بصور فأول 20)")
    if args.deep:
        print(f"🫀 الحياة: {census['alive']} أحياء · {census['dead']} ميتين · ?{sum(1 for r in rows if isinstance(r.get('alive'), str))} مشكوكين")
    print("═" * 60)
    if problems:
        print(f"⚠️ {len(problems)} مشاكل حقيقية:")
        for x in problems:
            print(f"   · {x}")
    else:
        print("✅ صحي كامل — كل الصيغ رسمية وكل الروابط خدّامة")
    print("═" * 60)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"census": census, "problems": problems, "rows": rows}, f, ensure_ascii=False, indent=2)
        print(f"💾 {args.json}")

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
