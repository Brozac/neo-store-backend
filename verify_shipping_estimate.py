#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_shipping_estimate.py — Kit 27 verification
==================================================
Usage:
  python verify_shipping_estimate.py                        # production, pid=1, country=MA
  python verify_shipping_estimate.py http://localhost:3000 2 US

Tips:
  · pid: خذ واحد حقيقي من الموقع (مثلا من صفحة منتج: /products/123 → pid=123)
  · الدولة ISO-2 (MA, DZ, US, FR ...)
"""
import json
import sys
import urllib.error
import urllib.request

base = (sys.argv[1] if len(sys.argv) > 1 else "https://neo-store-backend.onrender.com").rstrip("/")
pid = sys.argv[2] if len(sys.argv) > 2 else "1"
country = (sys.argv[3] if len(sys.argv) > 3 else "MA").upper()

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK  {name} {extra}")
    else:
        FAIL += 1
        print(f"  XX  {name} {extra}")


def get(path):
    req = urllib.request.Request(base + path, headers={"User-Agent": "laclarc-kit27-verify"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {}
        return e.code, body
    except Exception as e:
        return 0, {"error": str(e)}


print(f"=== Kit 27 verify - {base} ===")
print(f"-- 1. happy path /api/shipping/estimate?pid={pid}&country={country}")
st, body = get(f"/api/shipping/estimate?pid={pid}&country={country}")
check("endpoint responds 200/404/502", st in (200, 404, 502), f"(status={st})")
if st == 200:
    check("JSON has 'supported' key", "supported" in body, f"(source={body.get('source', '?')})")
    if body.get("supported") is True:
        c = body.get("cheapest") or {}
        f = body.get("fastest") or {}
        check("cheapest.price present", c.get("price") is not None, f"(${c.get('price')} via {c.get('carrier', '?')})")
        check("fastest.days present", f.get("days") is not None, f"({f.get('days')})")
        check("agingDays shape", body.get("agingDays") is None or ("min" in body["agingDays"] and "max" in body["agingDays"]))
        print(f"     >> RESULT: {country} cheapest=${c.get('price')} ({c.get('carrier')}) "
              f"aging={c.get('aging')} fastest={f.get('days')} carriers={body.get('carriersCount')}")
    elif body.get("supported") is False:
        print(f"     >> country/product unsupported (legit): reason={body.get('reason') or body.get('error')}")
        check("unsupported response has reason/error", bool(body.get("reason") or body.get("error")))
else:
    print(f"     info: body={json.dumps(body, ensure_ascii=False)[:200]}")

print("-- 2. bad params must 400")
st2, _ = get("/api/shipping/estimate?pid=abc&country=ZZ1")
check("HTTP 400 on bad params", st2 == 400, f"(status={st2})")

print("-- 3. cache stability (same call twice)")
st3a, b1 = get(f"/api/shipping/estimate?pid={pid}&country={country}")
st3b, b2 = get(f"/api/shipping/estimate?pid={pid}&country={country}")
check("stable 200 on repeat", st3a == st3b == 200, f"({st3a},{st3b})")

print(f"\nالحصيلة: PASS={PASS} FAIL={FAIL}" + ("  🎉" if FAIL == 0 else "  ⚠️"))
sys.exit(0 if FAIL == 0 else 1)
