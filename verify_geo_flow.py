#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_geo_flow.py — فحص حي للـ Geo Flow بعد الديبلوي
  python verify_geo_flow.py [BASE_URL] [--search]
  BASE_URL الافتراضي: https://neo-store-backend.onrender.com
  --search : يجرب /search كذلك (⚠ يحرق 50 نقطة CJ على MISS — استعملو بlying تقتير)
"""
import json, sys, urllib.request

BASE = "https://neo-store-backend.onrender.com"
if len(sys.argv) > 1 and not sys.argv[1].startswith("--"):
    BASE = sys.argv[1].rstrip("/")
DO_SEARCH = "--search" in sys.argv

def get(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "LaClarc-Kit29-Verify"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode())

ok = bad = 0
def check(name, cond, extra=""):
    global ok, bad
    if cond: ok += 1; print(f"  PASS  {name}" + (f"  — {extra}" if extra else ""))
    else:    bad += 1; print(f"  FAIL  {name}" + (f"  — {extra}" if extra else ""))

print(f"== Geo Flow verify — {BASE} ==\n")

g = get("/api/cj-live/geo?country=MA")
check("/geo MA", g.get("country") == "MA" and g.get("supported") is True, json.dumps(g))
check("registryCount=250", g.get("registryCount") == 250, str(g.get("registryCount")))

g = get("/api/cj-live/geo?country=uk")
check("UK→GB alias", g.get("country") == "GB", g.get("country"))

g = get("/api/cj-live/geo?country=ZZ")
check("ZZ → غير مدعومة", g.get("supported") is False and g.get("freightReady") is False)

g = get("/api/cj-live/geo")
print(f"  INFO  بلدك المكشوفة تلقائياً: {g.get('country')} ({g.get('name')}) source={g.get('source')}")

if DO_SEARCH:
    s = get("/api/cj-live/search?q=led&country=MA")
    check("/search جواب سليم", isinstance(s.get("products"), list), f"{len(s.get('products') or [])} منتج — geo={s.get('geo', {}).get('country')}")
    if s.get("products"):
        p = s["products"][0]
        check("شكل المنتج", all(k in p for k in ("pid", "title", "laclarcPrice", "image")), f"pid={p.get('pid')} price={p.get('laclarcPrice')}")

print(f"\n== {ok} PASS / {bad} FAIL ==")
sys.exit(1 if bad else 0)
