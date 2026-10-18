#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LACLARC SEO LIVE VERIFIER
=========================
من بعد الحقن (681 قسم) والتصحيحات — هاد الأداة كيتأكد أن العالم و Google غادي يشوفو النتيجة:

  1) فحص sitemap.xml — شحال من URL، شحال ديال صفحات الأقسام (المتوقع: 681)، عينات
  2) --check <URL> ... — كيجيب <title> الحي من السيرفر + رؤوس الـ cache (ISR/Vercel)

بلا اعتماديات (stdlib فقط) · UTF-8 guard للويندوز · JSON summary فالآخر

Usage:
  python verify_seo_live.py
  python verify_seo_live.py --sitemap https://laclarc.com/sitemap.xml
  python verify_seo_live.py --check "https://laclarc.com/category/xyz" "https://laclarc.com/category/abc"
"""

import sys, re, json, gzip, argparse
from datetime import datetime, timezone
import urllib.request
import urllib.error

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

UA = "Mozilla/5.0 (compatible; LaclarcSEOVerifier/1.0)"


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept-Encoding": "identity",
        "Accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding", "").lower() == "gzip":
            raw = gzip.decompress(raw)
        return r.status, dict(r.headers), raw.decode("utf-8", errors="replace"), r.geturl()


def extract_locs(xml):
    return re.findall(r"<loc>\s*(.*?)\s*</loc>", xml, re.IGNORECASE | re.DOTALL)


def is_sitemap_index(xml):
    return "<sitemapindex" in xml.lower()


def classify(url, cat_pattern):
    if re.search(cat_pattern, url, re.IGNORECASE):
        return "category"
    if re.search(r"/(product|p|item)s?/", url, re.IGNORECASE) or "/cj-product/" in url:
        return "product"
    return "other"


def crawl_sitemap(base_url, cat_pattern, max_follow=10):
    """كنرجع: {total, categories, products, other, samples, followed, errors}"""
    seen, urls, followed = set(), [], 0
    queue = [base_url]
    errors = []
    while queue and followed <= max_follow:
        sm = queue.pop(0)
        if sm in seen:
            continue
        seen.add(sm)
        try:
            status, hdrs, body, final = fetch(sm)
        except urllib.error.HTTPError as e:
            errors.append(f"{sm} → HTTP {e.code}")
            continue
        except Exception as e:
            errors.append(f"{sm} → {type(e).__name__}: {e}")
            continue
        followed += 1
        locs = extract_locs(body)
        if is_sitemap_index(body):
            for loc in locs:
                if loc.lower().endswith(".xml") and loc not in seen:
                    queue.append(loc)
        else:
            urls.extend(locs)

    cats = [u for u in urls if classify(u, cat_pattern) == "category"]
    prods = [u for u in urls if classify(u, cat_pattern) == "product"]
    others = [u for u in urls if classify(u, cat_pattern) == "other"]
    return {"total": len(urls), "category": len(cats), "product": len(prods),
            "other": len(others), "samples": cats[:5] or urls[:5],
            "sitemaps_followed": followed, "errors": errors}


TITLE_PAT = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
H1_PAT = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
CACHE_HEADERS = ("x-nextjs-cache", "x-nextjs-page", "x-vercel-cache",
                 "age", "cache-control", "x-vercel-id")


def check_page(url, timeout=30):
    out = {"url": url}
    try:
        status, hdrs, body, final = fetch(url, timeout)
        out["status"] = status
        out["final_url"] = final
        m = TITLE_PAT.search(body)
        out["title"] = re.sub(r"\s+", " ", m.group(1)).strip() if m else None
        m1 = H1_PAT.search(body)
        out["h1"] = re.sub(r"<[^>]+>", "", m1.group(1)).strip() if m1 else None
        out["cache"] = {k: hdrs.get(k) for k in CACHE_HEADERS if hdrs.get(k)}
        out["has_laclarc_brand"] = bool(out["title"] and "laclarc" in out["title"].lower())
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["error"] = f"HTTP {e.code}"
    except Exception as e:
        out["status"] = None
        out["error"] = f"{type(e).__name__}: {e}"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sitemap", default="https://laclarc.com/sitemap.xml")
    ap.add_argument("--category-pattern", default=r"/categor", help="regex يميز روابط الأقسام")
    ap.add_argument("--check", nargs="*", default=[], help="روابط لفحص <title> الحي")
    ap.add_argument("--expect-categories", type=int, default=681)
    args = ap.parse_args()

    print("🔍 LACLARC SEO LIVE VERIFIER")
    print("=" * 50)
    report = {"run_at": datetime.now(timezone.utc).isoformat(), "site": args.sitemap}

    if not args.check:
        print(f"🗺  فحص الـ sitemap: {args.sitemap}")
        sm = crawl_sitemap(args.sitemap, args.category_pattern)
        print(f"   URLs مجموعاً: {sm['total']} | أقسام: {sm['category']} | "
              f"منتجات: {sm['product']} | أخرى: {sm['other']}")
        print(f"   sitemaps متبعين: {sm['sitemaps_followed']}")
        if sm["errors"]:
            print("   ⚠️ أخطاء:")
            for e in sm["errors"]:
                print(f"      {e}")
        if sm["category"] < args.expect_categories:
            print(f"   ⚠️ المتوقع {args.expect_categories} قسم فالـ sitemap — "
                  f"لقينا غير {sm['category']} → خاص تجديد للـ sitemap (redeploy / regenerate)")
        else:
            print(f"   ✅ {sm['category']} ≥ {args.expect_categories} — الأقسام كاملين فالـ sitemap")
        print("   عينات من روابط الأقسام:")
        for s in sm["samples"]:
            print(f"      {s}")
        report["sitemap"] = sm

    if args.check:
        print(f"\n🌐 فحص {len(args.check)} صفحة حية:")
        checks = []
        for u in args.check:
            c = check_page(u)
            checks.append(c)
            t = c.get("title") or c.get("error", "?")
            print(f"   [{c.get('status', 'ERR')}] {u}")
            print(f"        title: {t}")
            if c.get("h1"):
                print(f"        h1:    {c['h1']}")
            if c.get("cache"):
                cc = " | ".join(f"{k}={v}" for k, v in c["cache"].items())
                print(f"        cache: {cc}")
        report["checks"] = checks
        ok = sum(1 for c in checks if c.get("status") == 200 and c.get("has_laclarc_brand"))
        print(f"\n   ✅ {ok}/{len(checks)} صفحات خدامين بعنوان فيه Laclarc")

    print("\n" + json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
