#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_cj_shipping.py — Kit 27 (CJ Live Shipping Estimate + CJ Points Monitor)
=============================================================================
يخدم من جذر repo الـ backend (المجلد اللي فيه server.js)

الترقعتين (جراحية، بلا مساس لأي حاجة أخرى):
  1. services/cjService.js  — 📊 مراقبة نقاط CJ (pointsInfo): سجل مرة/ساعة،
     أو فوراً إلا نقص الأيقونة لأقل من 15% — ما كيوقفش حتى طلب حتى لو فشل.
  2. server.js              — 🚚 endpoint جديد عمومي:
     GET /api/shipping/estimate?pid=123&country=MA
       · freightCalculate حقيقي من CJ (10 نقاط/استدعاء، cache 6 ساعات)
       · pre-filter بـ shipping_matrix (دولة غير مدعومة = 0 نقطة)
       · محدد IP بسيط: 30 طلب / 10 دقايق

الأنكورات مفحوصين إنفراد — إلا واحد ما لقيتش أو تكرر: إيقاف كامل بلا تعديل.
Backup تلقائي: *.bak-cjkit27 بجانب كل ملف.
"""
import os
import sys
import shutil
import subprocess

BACKUP_SUFFIX = ".bak-cjkit27"

# ──────────────────────────── Anchors ────────────────────────────
ANCHOR_SVC_FN = "async function cjRequest(requestFn, retryCount = 0) {"
ANCHOR_SVC_CALL = "    await cjPace();\n    return await requestFn(token, config);"
ANCHOR_SRV = (
    "// ==========================================\n"
    "// فئات CJ والـ Backfill\n"
    "// =========================================="
)

# ──────────────────────────── Insertions ────────────────────────────
POINTS_HELPER = """// ==========================================
// 📊 Kit 27 — CJ Points monitor (نظام النقاط فعال من يوليوز 2026)
// كل response ديال CJ فيه pointsInfo — نسجلو مرة فالساعة،
// أو فوراً إلا نقص الأيقونة لأقل من 15% — المراقبة عمرها ما كتوقف طلب.
// ==========================================
let cjPointsLastLog = 0;
function logCjPointsInfo(resp) {
  try {
    const pi = resp && resp.data && resp.data.pointsInfo;
    if (!pi || typeof pi.remaining !== 'number') return;
    const ratio = pi.total > 0 ? pi.remaining / pi.total : 1;
    const now = Date.now();
    if (ratio < 0.15 || now - cjPointsLastLog > 60 * 60 * 1000) {
      cjPointsLastLog = now;
      const tag = ratio < 0.15 ? '⚠️ [CJ Points LOW]' : '📊 [CJ Points]';
      console.log(tag + ' used=' + pi.usedToday + '/' + pi.total + ' remaining=' + pi.remaining);
    }
  } catch (e) { /* monitoring never breaks requests */ }
}

"""

SVC_CALL_REPLACEMENT = """    await cjPace();
    const __cjResp27 = await requestFn(token, config);
    logCjPointsInfo(__cjResp27);
    return __cjResp27;"""

SHIPPING_ENDPOINT = """// ════════════════════════════════════════════
// 🚚 Kit 27 — CJ Live Shipping Estimate (freightCalculate حقيقي)
// GET /api/shipping/estimate?pid=123&country=MA
//   · cache 6 ساعات على (pid|country) — 10 نقاط فقط على cache-miss
//   · pre-filter بـ shipping_matrix (دولة غير مدعومة = 0 نقطة)
//   · محدد IP بسيط: 30 طلب / 10 دقايق / IP
// ════════════════════════════════════════════
const shippingEstimateCache = new Map();
const SHIPPING_ESTIMATE_TTL_MS = 6 * 60 * 60 * 1000;
const shipIpHits = new Map();

app.get('/api/shipping/estimate', async (req, res) => {
  try {
    const pid = parseInt(String(req.query.pid || ''), 10);
    const country = String(req.query.country || '').trim().toUpperCase().slice(0, 2);
    if (!Number.isFinite(pid) || pid <= 0 || !/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({ error: 'pid (numeric) and country (ISO-2) required' });
    }

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const nowMs = Date.now();
    const hits = (shipIpHits.get(ip) || []).filter(ts => nowMs - ts < 10 * 60 * 1000);
    if (hits.length >= 30) return res.status(429).json({ supported: false, error: 'Too many requests' });
    hits.push(nowMs);
    shipIpHits.set(ip, hits);
    if (shipIpHits.size > 5000) shipIpHits.clear();

    const cacheKey = pid + '|' + country;
    const cached = shippingEstimateCache.get(cacheKey);
    if (cached && nowMs - cached.t < SHIPPING_ESTIMATE_TTL_MS) return res.json(cached.data);

    const { rows } = await pool.query(
      "SELECT id, cj_product_id, variants FROM products WHERE id = $1 AND cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%' LIMIT 1",
      [pid]
    );
    if (!rows.length) return res.status(404).json({ supported: false, error: 'product not found or not CJ-linked' });

    let variants = rows[0].variants;
    if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch (e) { variants = []; } }
    const vid = Array.isArray(variants) && variants[0] && variants[0].vid;
    if (!vid) return res.status(404).json({ supported: false, error: 'no CJ variant (vid) on product' });

    try {
      const sm = await pool.query('SELECT is_supported FROM shipping_matrix WHERE country_code = $1', [country]);
      if (sm.rows.length && sm.rows[0].is_supported === false) {
        const data = { supported: false, reason: 'country unsupported (matrix)', country, source: 'shipping_matrix' };
        shippingEstimateCache.set(cacheKey, { t: nowMs, data });
        return res.json(data);
      }
    } catch (smErr) { console.warn('⚠️ [ShipEstimate] matrix prefilter skipped:', smErr.message); }

    const cjRes = await cjRequest((token, config) =>
      axios.post('https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate', {
        startCountryCode: 'CN',
        endCountryCode: country,
        products: [{ vid, quantity: 1 }]
      }, { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
    );

    const list = Array.isArray(cjRes.data && cjRes.data.data) ? cjRes.data.data : [];
    if (!list.length) {
      const data = { supported: false, reason: 'no carriers returned', country, source: 'cj-live' };
      shippingEstimateCache.set(cacheKey, { t: nowMs, data });
      return res.json(data);
    }

    const byPrice = list.slice().sort((a, b) => (Number(a.logisticPrice) || 1e12) - (Number(b.logisticPrice) || 1e12));
    const byDays  = list.slice().sort((a, b) => (parseInt(a.logisticAging, 10) || 9999) - (parseInt(b.logisticAging, 10) || 9999));
    const cheapest = byPrice[0];
    const fastest = byDays[0];
    const agingNums = String(cheapest.logisticAging || '').match(/\\d+/g);
    const agingDays = (agingNums && agingNums.length)
      ? { min: parseInt(agingNums[0], 10), max: parseInt(agingNums[agingNums.length - 1], 10) }
      : null;

    const data = {
      supported: true,
      country,
      cheapest: { price: cheapest.logisticPrice, carrier: cheapest.logisticName, aging: cheapest.logisticAging || null },
      fastest: { days: fastest.logisticAging || null, price: fastest.logisticPrice, carrier: fastest.logisticName },
      agingDays,
      carriersCount: list.length,
      source: 'cj-live',
      cached: false
    };
    shippingEstimateCache.set(cacheKey, { t: nowMs, data });
    if (shippingEstimateCache.size > 20000) shippingEstimateCache.clear();
    return res.json(data);
  } catch (err) {
    try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('ShippingEstimate', err);
    return res.status(502).json({ supported: false, error: 'upstream CJ error' });
  }
});

"""


def detect_eol(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def flexible_find(text: str, anchor: str):
    """يلقى الأنكور حتى لو الملف CRLF — كيرجع (index, matched_text) ولا (None, None)."""
    idx = text.find(anchor)
    if idx != -1:
        return idx, anchor
    crlf_anchor = anchor.replace("\n", "\r\n")
    idx = text.find(crlf_anchor)
    if idx != -1:
        return idx, crlf_anchor
    return None, None


def read_file(path: str) -> str:
    with open(path, "rb") as f:
        return f.read().decode("utf-8")


def write_file(path: str, text: str) -> None:
    with open(path, "wb") as f:
        f.write(text.encode("utf-8"))


def backup(path: str) -> None:
    bak = path + BACKUP_SUFFIX
    if os.path.exists(bak):
        os.remove(bak)
    shutil.copy2(path, bak)


def apply_patch(path: str, steps) -> None:
    """steps: list of (anchor, mode, payload) — mode='insert_before'|'replace'"""
    text = read_file(path)
    original = text
    for anchor, mode, payload in steps:
        idx, matched = flexible_find(text, anchor)
        if idx is None:
            print(f"❌ ANCHOR NOT FOUND in {path}:\n---\n{anchor[:120]}\n---")
            sys.exit(1)
        if text.count(matched) != 1:
            print(f"❌ ANCHOR NOT UNIQUE ({text.count(matched)}×) in {path}:\n---\n{anchor[:120]}\n---")
            sys.exit(1)
        if mode == "insert_before":
            eol = detect_eol(text)
            text = text[:idx] + payload.replace("\n", eol) + text[idx:]
        elif mode == "replace":
            text = text[:idx] + payload + text[idx + len(matched):]
    if text != original:
        backup(path)
        write_file(path, text)
        print(f"✅ patched: {path}")
    else:
        print(f"⚪ no change: {path}")


def node_check(path: str) -> bool:
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            print(f"   node --check ✓  {path}")
            return True
        print(f"❌ SYNTAX ERROR in {path}:\n{r.stderr[:1500]}")
        return False
    except FileNotFoundError:
        print("⚠️ node غير موجود — تخطى فحص السينتاكس (شغلو يدوياً: node --check)")
        return True


def main() -> None:
    if not os.path.exists("server.js") or not os.path.exists(os.path.join("services", "cjService.js")):
        print("❌ خدم من جذر الـ backend (المجلد اللي فيه server.js)")
        sys.exit(1)

    print("═══ 🚚 Kit 27 — CJ Live Shipping Estimate + Points Monitor ═══\n")

    # 1) cjService.js — points monitor (helper + log فالمسار الناجح)
    apply_patch(
        os.path.join("services", "cjService.js"),
        [
            (ANCHOR_SVC_FN, "insert_before", POINTS_HELPER),
            (ANCHOR_SVC_CALL, "replace", SVC_CALL_REPLACEMENT),
        ],
    )

    # 2) server.js — endpoint الشحن الحي (قبل فئات CJ والـ Backfill)
    apply_patch("server.js", [(ANCHOR_SRV, "insert_before", SHIPPING_ENDPOINT)])

    print()
    ok1 = node_check(os.path.join("services", "cjService.js"))
    ok2 = node_check("server.js")
    if not (ok1 and ok2):
        print("\n♻️ رجّع النسخ من .bak-cjkit27 و صلحني قبل ما تعاود")
        sys.exit(1)

    print("""
═══ ✅ الترقعة دازت ═══

الخطوات الجاية:
  1. git add services/cjService.js server.js
  2. git commit -m "Kit27: live shipping estimate + CJ points monitor"
  3. git push   ← Render غادي يعاود يبني بوحدو
  4. من بعد الـ deploy: python verify_shipping_estimate.py
""")


if __name__ == "__main__":
    main()
