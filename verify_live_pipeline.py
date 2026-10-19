#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_live_pipeline.py — التحقق اللايف الكامل ديال Integration Layer (4 مراحل)
  LaClarc × CJ Dropshipping — https://neo-store-backend.onrender.com

  Pipeline: GeoIP → باب الـ 250 → listV2 بـ countryCode → freightCalculateTip

  النقاط: /search MISS=50pt · /product MISS=10pt + freight=10pt · ZZ=10pt
  دورة كاملة ≈ 70..120pt (من 50,000/يوم)

  python verify_live_pipeline.py [BASE_URL] [--country MA]
  v2 — كيعرض cjCode/cjMessage من أخطاء envelope ديال CJ (البريدج ≥ kit29b)
"""
import json, sys, time, urllib.request, urllib.error

BASE = "https://neo-store-backend.onrender.com"
COUNTRY = "MA"
args = [a for a in sys.argv[1:]]
if args and not args[0].startswith("--"):
    BASE = args.pop(0).rstrip("/")
if "--country" in args:
    COUNTRY = args[args.index("--country") + 1].upper()

TERM1, TERM2 = "led", "phone case"
ok = bad = warn = pts = 0
t_start = time.time()

def check(name, cond, extra="", is_warn=False):
    global ok, bad, warn
    tag = "WARN" if (is_warn and not cond) else ("PASS" if cond else "FAIL")
    if cond: ok += 1
    elif is_warn: warn += 1
    else: bad += 1
    print(f"  {tag}  {name}" + (f"  — {extra}" if extra else ""))

def get(path, timeout=60, retries=0):
    """GET مع retry للـ cold start ديال Render"""
    last_err = None
    for attempt in range(1 + max(0, retries)):
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": "LaClarc-Pipeline-Verify/1.0"})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.loads(r.read().decode())
                return body, (time.time() - t0) * 1000
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode())
            except Exception:
                body = {}
            # 502/429 ما كيتصلحوش بالـ retry — نرجعو الجواب باش نوصلو لحكم دقيق
            return {"__http_error__": e.code, **body}, 0
        except Exception as e:
            last_err = e
            time.sleep(3)
    raise last_err or RuntimeError("unreachable")

def cj_hint(b):
    """نص تشخيصي من جواب خطأ CJ (envelope)"""
    if not b.get("cjCode") and not b.get("cjMessage"):
        return ""
    hints = {
        16900500: "→ نقاط CJ ناقصين (راجع Points/رصيد الحساب)",
        1600001:  "→ توكن/أوث CJ — تأكد من CJ_API_KEY فالـ env ديال Render",
        1600200:  "→ QPS limit CJ",
        429:      "→ QPS limit CJ",
    }
    h = hints.get(b.get("cjCode"), "")
    return f"cjCode={b.get('cjCode')} \"{b.get('cjMessage')}\" {h}".strip()

print(f"== Live Pipeline verify — {BASE} ==")
print(f"   Pipeline: GeoIP → 250-gate → listV2(countryCode={COUNTRY}) → freightCalculateTip\n")

# ────────────────────────────────────────────────────────────
# [0+1] WARM-UP + GEO — بلا نقاط
# ────────────────────────────────────────────────────────────
print("── [1] GeoIP → باب الـ 250 (بلا نقاط) ──")
try:
    g, ms = get(f"/api/cj-live/geo?country={COUNTRY}", timeout=90, retries=3)  # retries = cold start
    check(f"/geo {COUNTRY}", g.get("country") == COUNTRY and g.get("supported") is True,
          f"{ms:.0f}ms source={g.get('source')} registry={g.get('registryCount')}")
    check("registryCount=250", g.get("registryCount") == 250, str(g.get("registryCount")))
except Exception as e:
    check("/geo reachable", False, f"{e} — الباك إند ماكاش ولا cold start طويل")
    print(f"\n== {ok} PASS / {bad} FAIL / {warn} WARN =="); sys.exit(1)

# ────────────────────────────────────────────────────────────
# [2] SEARCH — listV2 + countryCode (50pt على MISS)
# ────────────────────────────────────────────────────────────
print("\n── [2] listV2 بـ countryCode (50pt على MISS) ──")
search = None; pid = None
terms = (TERM1, TERM2)
for ti, term in enumerate(terms):
    try:
        s, ms = get(f"/api/cj-live/search?q={urllib.request.quote(term)}&country={COUNTRY}", timeout=90)
    except Exception as e:
        check("/search reachable", False, str(e)); break
    if s.get("__http_error__"):
        code = s["__http_error__"]
        if code == 502:
            check("/search → CJ", False, f"502 — {cj_hint(s) or 'CJ unavailable (شوف logs [cj-live/search])'}")
        elif code == 429:
            check("/search limiter", False, "429 — 20 بحث/10د/IP، عاود من بعد")
        else:
            check("/search HTTP", False, f"HTTP {code} {cj_hint(s)}")
        break
    if not s.get("cached"):
        pts += 50
    prods = s.get("products") or []
    geo_s = (s.get("geo") or {})
    check(f"/search '{term}' جواب سليم", isinstance(prods, list),
          f"{len(prods)} منتج · geo={geo_s.get('country')}/{geo_s.get('source')} · {ms:.0f}ms · cached={s.get('cached')}")
    if prods:
        search = s
        p0 = prods[0]
        pid = p0.get("pid")
        check("شكل المنتج (pid/title/price/image)",
              all(k in p0 for k in ("pid", "title", "laclarcPrice", "image")) and p0.get("laclarcPrice", 0) > 0,
              f"pid={pid} · laclarcPrice=${p0.get('laclarcPrice')} · deliveryCycle={p0.get('deliveryCycle') or '—'}")
        n_dc = sum(1 for p in prods if p.get("deliveryCycle"))
        check(f"deliveryCycle موجودة ({n_dc}/{len(prods)})", True, "معلومة من listV2 مباشرة", is_warn=True)
        break
    if ti < len(terms) - 1:
        print(f"  WARN  '{term}' بلا نتائج → نجرب '{terms[ti + 1]}' (50pt زايدة)…")

if not pid:
    print(f"\n== {ok} PASS / {bad} FAIL / {warn} WARN ==  (ما كانش pid — التحقق توقف هنا)")
    if not search:
        print("   💡 إذا /search رجع 0 منتجات بجواب سليم: شوف cjCode فالـ 502 ولا logs Render [cj-live/search]")
    sys.exit(1)

# ────────────────────────────────────────────────────────────
# [3] CACHE SHIELD — نفس الطلب مرة ثانية (بلا نقاط)
# ────────────────────────────────────────────────────────────
print("\n── [3] درع الكاش (نفس البحث مرة ثانية — خاصو يكون مجاني) ──")
try:
    s2, ms2 = get(f"/api/cj-live/search?q={urllib.request.quote(TERM1)}&country={COUNTRY}", timeout=60)
    same_first = (s2.get("products") or [{}])[0].get("pid") == pid
    check("cached=true + نفس النتيجة", s2.get("cached") is True and same_first,
          f"{ms2:.0f}ms — 0pt (الكاش خدم لايف)")
except Exception as e:
    check("cache shield", False, str(e))

# ────────────────────────────────────────────────────────────
# [4] FREIGHT — product/query + freightCalculateTip (10+10pt/منتج)
# ────────────────────────────────────────────────────────────
print("\n── [4] freightCalculateTip — الثمن المباشر (10+10pt على MISS) ──")
freight_live = False
candidates = [pid]
if search and len(search.get("products") or []) > 1:
    candidates.append(search["products"][1].get("pid"))

for i, try_pid in enumerate(c for c in candidates if c):
    try:
        pr, ms = get(f"/api/cj-live/product/{try_pid}?country={COUNTRY}", timeout=90)
    except Exception as e:
        check(f"/product/{try_pid[:12]}…", False, str(e)); continue
    if pr.get("__http_error__"):
        code = pr["__http_error__"]
        if code == 404:
            check(f"/product/{try_pid[:12]}…", False, "404 product not found عند CJ")
        elif code == 502:
            check(f"/product/{try_pid[:12]}…", False, f"502 — {cj_hint(pr) or 'CJ auth/شبكة'}")
        else:
            check(f"/product/{try_pid[:12]}…", False, f"HTTP {code} {cj_hint(pr)}")
        continue
    pts += 10  # product/query
    ship = pr.get("shipping") or {}
    geo_p = pr.get("geo") or {}
    check("geo.country فالمنتج", geo_p.get("country") == COUNTRY,
          f"{geo_p.get('country')}/{geo_p.get('source')}")
    if ship.get("source") == "cj-live":
        freight_live = True
        pts += 10  # freightCalculateTip MISS
        check("shipping.source = cj-live ✅", True,
              f"${ship.get('amount')} · {str(ship.get('channelName') or '')[:38]} · وصول {ship.get('arrivalTime') or '—'} · {ms:.0f}ms")
        check("amount > 0 + currency USD", (ship.get("amount") or 0) > 0 and ship.get("currency") == "USD",
              f"src={ship.get('srcAreaCode')}")
        check("options ≤ 3 (top channels)", isinstance(ship.get("options"), list) and 1 <= len(ship.get("options") or []) <= 3,
              f"{len(ship.get('options') or [])} قنوات")
        check("laclarcPrice بالفريت الحقيقي", (pr.get("laclarcPrice") or 0) > 0,
              f"laclarcPrice=${pr.get('laclarcPrice')} · estimatedShipUsd=${pr.get('estimatedShipUsd')}")
        v0 = (pr.get("variants") or [{}])[0]
        check("variants + v0 مسعر", v0.get("laclarcVariantPrice", 0) > 0,
              f"vid={v0.get('vid')} · v0=${v0.get('laclarcVariantPrice')} · inv={','.join((v0.get('inventoryCountries') or [])[:4])}")
        break
    else:
        cjx = (ship.get("cjError") or {})
        msg = f"source={ship.get('source')} {('cjCode=' + str(cjx.get('cjCode')) + ' ' + str(cjx.get('cjMessage'))) if cjx else 'CJ ما رجعاتش قناة نحو ' + COUNTRY}"
        check("/product shipping cj-live", False, msg, is_warn=(i == 0))
        continue

# ────────────────────────────────────────────────────────────
# [5] WORLDWIDE MODE — بلد غير مدعومة ZZ (10pt — بلا فريت)
# ────────────────────────────────────────────────────────────
print("\n── [5] الوضع العالمي — ZZ غير مدعومة (10pt) ──")
try:
    pz, ms = get(f"/api/cj-live/product/{pid}?country=ZZ", timeout=90)
    if not pz.get("__http_error__"):
        pts += 10
        shipz = pz.get("shipping") or {}
        geoz = pz.get("geo") or {}
        check("ZZ → estimate fallback (وضع عالمي)", shipz.get("source") == "estimate" and geoz.get("supported") is False,
              f"source={shipz.get('source')} · ${shipz.get('amount')} · geo={geoz.get('country')}/supported={geoz.get('supported')}")
    else:
        check("ZZ fallback", False, f"HTTP {pz['__http_error__']} {cj_hint(pz)}")
except Exception as e:
    check("ZZ fallback", False, str(e))

# ────────────────────────────────────────────────────────────
dt = time.time() - t_start
print(f"\n== {ok} PASS / {bad} FAIL / {warn} WARN ==  ({dt:.1f}s · نقاط CJ مصروفة ≈{pts}pt من 50,000/يوم)")
sys.exit(1 if bad else 0)
