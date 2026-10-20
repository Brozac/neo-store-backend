#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_card_swatches.py — Kit 30 [card-swatches]
الاستعمال:
  python patch_card_swatches.py --backend .    # من جذر الباك (فين server.js)
  python patch_card_swatches.py --frontend .   # من جذر الفرونت (فين app/)
الضمانات: fail-closed (حتى كتابة قبل كل الأنكورات تثبت) + backup .bak-kit30
         + idempotent (الجولة 2 = skip) + diag/kit30-diag + node --check (إن وجد node)
"""
import argparse, base64, os, shutil, subprocess, sys, io

MARKER = '[card-swatches]'
HELPER_START = '// ═══ [card-swatches] Kit 30 — سواتشات الصور لكارت المنتج (بداية) ═══'
HELPER_END = '// ═══ [card-swatches] Kit 30 — نهاية ═══'
HELPER_BLOCK = '// ═══ [card-swatches] Kit 30 — سواتشات الصور لكارت المنتج (بداية) ═══\n// المصدر: variants JSONB (CJ product/query) — variantKey بصيغة CJ الرسمية "Color-Size"\n// (توثيق CJ: variants[].variantKey مثال "Black-XXL" · variants[].variantImage · vid)\n// SW_SQL كيستخرج: لون واحد (قبل آخر -) + أول صورة + أول vid لكل لون (بترتيب أول ظهور)\n// withSwatches كيفلتر: المقاسات-فقط (XL/42...) + الصور المكررة · سقف 5 · swMore = الباقي\n// ⚡ صفر نقاط CJ — عملية DB محلية بحتة · الفرع الكامل (FULL_CAP=5000) بلا سواتشات عمداً (الأداء)\nconst SW_SIZE_ONLY_RX = /^(?:xxs|xs|s|m|l|xl|xxl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|\\d{1,4})$/i;\nconst SW_MAX = 5;\nconst SW_SQL = `, COALESCE((\n  SELECT json_agg(json_build_object(\'c\', t.c, \'i\', t.i, \'v\', t.v) ORDER BY t.ord)\n  FROM (\n    SELECT regexp_replace(v.val->>\'variantKey\', \'-[^-]+$\', \'\') AS c,\n           (array_agg(v.val->>\'variantImage\' ORDER BY v.ord))[1] AS i,\n           (array_agg(v.val->>\'vid\' ORDER BY v.ord))[1] AS v,\n           min(v.ord) AS ord\n    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(variants) = \'array\' THEN variants ELSE \'[]\'::jsonb END) WITH ORDINALITY AS v(val, ord)\n    WHERE COALESCE(v.val->>\'variantImage\', \'\') <> \'\' AND COALESCE(v.val->>\'variantKey\', \'\') <> \'\'\n    GROUP BY 1\n  ) t\n), \'[]\'::json) AS swatches`;\n\nfunction withSwatches(rows) {\n  try {\n    if (!Array.isArray(rows)) return rows;\n    for (const r of rows) {\n      if (!r || typeof r !== \'object\') continue;\n      if (!(\'swatches\' in r)) continue; // صفوف بلا الحقل (فروع غير مرقعة) → بلا لمس\n      let arr = r.swatches;\n      if (typeof arr === \'string\') {\n        try { arr = JSON.parse(arr || \'[]\'); } catch (e) {\n          console.error(\'[card-swatches] swatches JSON parse failed (product \' + (r.id ?? \'?\') + \'):\', e.message);\n          arr = [];\n        }\n      }\n      if (!Array.isArray(arr)) { r.swatches = []; continue; }\n      const out = [];\n      const seenImg = new Set();\n      let total = 0;\n      for (const s of arr) {\n        const c = (s && typeof s.c === \'string\') ? s.c.trim() : \'\';\n        const i = (s && typeof s.i === \'string\') ? s.i.trim() : \'\';\n        if (!c || !i) continue;\n        if (SW_SIZE_ONLY_RX.test(c)) continue; // مقاس-فقط (XL/42) ماشي لون\n        total++;\n        if (seenImg.has(i)) continue; // جوج أسماء لنفس الصورة → سواتش واحد\n        seenImg.add(i);\n        if (out.length < SW_MAX) out.push({ c: c.slice(0, 40), i, v: (s && typeof s.v === \'string\' && s.v) ? s.v : undefined });\n      }\n      r.swatches = out;\n      const more = total - out.length;\n      if (more > 0) r.swMore = more;\n    }\n  } catch (e) {\n    console.error(\'[card-swatches] withSwatches failed:\', e.message); // Tenet — بلا صمت\n  }\n  return rows;\n}\n// ═══ [card-swatches] Kit 30 — نهاية ═══'

BACKEND_PATCHES = [('S1-cat-sql', '          `SELECT id, title, price, original_price, image_url, category, video_url\n           FROM products WHERE stock_status = true AND category ILIKE $1', '          `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}\n           FROM products WHERE stock_status = true AND category ILIKE $1'), ('S1-cat-json', "        res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');\n        return res.json(rows);", "        res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');\n        return res.json(withSwatches(rows));"), ('S2-feed-sql', '        `SELECT id, title, price, original_price, image_url, category, video_url\n         FROM products WHERE stock_status = true\n         ORDER BY md5(category || id::text), id DESC', '        `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}\n         FROM products WHERE stock_status = true\n         ORDER BY md5(category || id::text), id DESC'), ('S2-feed-json', "      res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');\n      return res.json(rows);", "      res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');\n      return res.json(withSwatches(rows));"), ('S3-limit', "          'SELECT id, title, price, original_price, image_url, category, video_url, created_at FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC LIMIT $1',\n          [Math.min(limitParam, 200)]", '          `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}, created_at FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC LIMIT $1`,\n          [Math.min(limitParam, 200)]'), ('S3-limit-json', '        return res.json(q.rows);', '        return res.json(withSwatches(q.rows));'), ('S4-search', "    let query = 'SELECT id, title, price, original_price, image_url, category, video_url FROM products WHERE stock_status = true';", '    let query = `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL} FROM products WHERE stock_status = true`;'), ('S4-search-json', '    const result = await pool.query(query, params);\n    res.json(result.rows);', '    const result = await pool.query(query, params);\n    res.json(withSwatches(result.rows));'), ('S5-byids-sql', '      `SELECT id, title, price, original_price, image_url, category, video_url\n         FROM products\n        WHERE stock_status = true AND id = ANY($1::int[])', '      `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}\n         FROM products\n        WHERE stock_status = true AND id = ANY($1::int[])'), ('S5-byids-json', "      [ids]\n    );\n    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');\n    res.json(rows);", "      [ids]\n    );\n    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');\n    res.json(withSwatches(rows));")]

A_HELPER = "app.get('/api/products', async (req, res) => {"
FULL_ANCHOR_INTACT = "video_url, created_at FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC LIMIT $1'"

PRODUCT_CARD_B64 = "J3VzZSBjbGllbnQnOwoKLyoqCiAqIOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkOKVkAogKiBMYWNsYXJjIFByb2R1Y3RDYXJkIOKAlCB2My4xIChLaXQgMzAgW2NhcmQtc3dhdGNoZXNdIMK3INit2YTZgtipINin2YTYs9mI2KfYqti0INin2YTYr9in2YPZhtipKQogKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICog4pyoIFtjYXJkLXN3YXRjaGVzXSDigJQg2LPZiNin2KrYtNin2Kog2KfZhNi12YjYsSDZgdin2YTZg9in2LHYqiAo2KjYo9iz2YTZiNioIFRlbXUpOgogKiAgICDCtyBzd2F0Y2hlc1tdINmD2KrYrNmKINmF2YYg2KfZhNio2KfZgyAoS2l0IDMwKTog2YTZiNmGICsg2LXZiNix2KkgdmFyaWFudCArIHZpZAogKiAgICAgICjYp9mE2YXYtdiv2LE6IHZhcmlhbnRzIEpTT05CIOKAlCB2YXJpYW50S2V5INio2LXZiti62KkgQ0og2KfZhNix2LPZhdmK2KkgIkNvbG9yLVNpemUiKQogKiAgICDCtyBob3ZlciA9INmF2LnYp9mK2YbYqSDYp9mE2LXZiNix2Kkg2KjYqtin2LnYqSDYsNin2YMg2KfZhNmE2YjZhiDCtyBjbGljayA9INiq2KvYqNmK2Kog2KfZhNin2K7YqtmK2KfYsQogKiAgICDCtyDwn6m5INil2LXZhNin2K0g2K3ZgtmK2YLZiiDZhNmE2YAgcXVpY2stYWRkOiDZg9in2YYg2YPZiti12YrZgdi3IHZpZCDYrtin2YjZiiAo2KfZhNmE2KfYptit2Kkg2YXYpyDZgdmK2YfYp9i0CiAqICAgICAgdmFyaWFudHMpIOKGkiDYr9in2KjYpyDZg9mK2LXZitmB2LcgdmlkINiq2KfYuSDYp9mE2YTZiNmGINin2YTZhdiu2KrYp9ixL9in2YTZhdi52KfZitmGIOKAlCDZhtmB2LMKICogICAgICDYp9mE2K3Zhdin2YrYqSDYp9mE2YTZiiDZgdmKIFByb2R1Y3REZXRhaWxzQ2xpZW50ICh2aWQg2K7Yp9i32KYgPSDYqNi22KfYudipINiu2KfYt9im2KkpCiAqICAgIMK3ICtOINmE2YTYo9mE2YjYp9mGINin2YTYstin2YrYr9ipIMK3IHRpdGxlL2FyaWEtbGFiZWwg2YTZg9mEINiz2YjYp9iq2LQgwrcg2KjZhNinIENMUwogKiAgICDCtyBbc3dhdGNoLXJpbmcgdjMuMV0g2K3ZhNmC2Kkg2KfZhNin2K7YqtmK2KfYsSA9IHRlbXUtYmxhY2sgKCMxRDFFM0MpICsgcmluZy1vZmZzZXQg2KPYqNmK2LY6CiAqICAgICAg2KfZhNiz2YjYp9iq2LTYp9iqINi12YjYsSDYrdmC2YrZgtmK2Kkg2YHZitmH2Kcg2KjZhtmB2LPYrNmKICjZhdir2KfZhCAyODcwMSBQdXJwbGUpIOKGkiDYrdmE2YLYqSDYqNmG2YHYs9is2YoKICogICAgICDZg9iq2K7ZgdmKIOKAlCDYp9mE2K/Yp9mD2YYg2KfZhNmF2K3Yp9mK2K8g2YPZitiq2YLYsdinINi52YTZiSDYo9mKINmE2YjZhiAo2KjZhtiq2LHZhiBUZW11L0FtYXpvbi9TSEVJTikKICogICAgICDZiNmK2LLYp9mEINmF2YYg2YbZgdizINio2KfZhNmK2Kog2KfZhNmF2YjZgti5IMK3INin2YTYqNmG2YHYs9is2Yog2YrYqNmC2Ykg2YTZhNmAIENUQS/Yp9mE2LHZiNin2KjYty/Yp9mE2KPYs9i52KfYsQogKiAgICDCtyDYqtmI2KfZgdmCINiu2YTZgdmKIDEwMCU6INio2YTYpyBzd2F0Y2hlcyDZgdin2YTZvtin2YrZhNmI2K8g4oaSINin2YTYtdmBINmF2K7YqNmKICjYp9mE2YPYp9ix2Kog2KfZhNmC2K/ZitmFKQogKiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICog2YXYrdmB2YjYuCDZg9mF2Kcg2YfZiCAodjIuMCDigJQgVGFzayAxMCBSZXZpZXcpOgogKiDwn5S5IEZJWC1JTUcg4oCUIElNRy5jYXJkKCkgKE9TUyB0cmFuc2Zvcm0gNDAwdyB+MTVLQiDYqNiv2YQgMjU5S0Ig2K7Yp9mFKQogKiDwn5S5IEZJWC1MQVpZIOKAlCBsb2FkaW5nPSJsYXp5IiArIGRlY29kaW5nPSJhc3luYyIgKyBlYWdlciDYp9iu2KrZitin2LHZiiAoTENQKQogKiDwn5S5IEZJWC1MSU5LIOKAlCBMaW5rINit2YLZitmC2Yo6IG5ldy10YWIgLyBrZXlib2FyZCAvIFNFTyAvIHByZWZldGNoPXtmYWxzZX0KICog8J+UuSBGSVgtU0lMRU5UIOKAlCBjYXRjaCDYqNmE2Kcg2LXZiNiqINmF2YXZhtmI2Lkg4oaSIGNvbnNvbGUuZXJyb3Ig2YrZhtis2Ygg2YXZhiByZW1vdmVDb25zb2xlCiAqIPCflLkgRklYLVpFUk8g4oCUINiz2LnYsSDZhdmB2YLZiNivINmF2Kcg2YrYudix2LbYtCAiJDAuMDAiIOKGkiDYp9mE2LXZgSDZitiu2KrZgdmKCiAqIPCflLkgVFJVU1QgRklYIOKAlCDYrti12YUg2YXZhiBvcmlnaW5hbF9wcmljZSDYp9mE2K3ZgtmK2YLZiiDZgdmC2LcgKDHigJM4OSUpCiAqIPCflLkgaXNUb3VjaGVkL2lzLWFjdGl2ZSDCtyBhc3BlY3Qtc3F1YXJlID0g2LXZgdixIENMUwogKiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICog4pqg77iPINiq2LDZg9mK2LEg2KPZhdmG2Yo6INin2YTYs9i52LEg2YfZhtinINmE2YTYudix2LYv2KfZhNiz2YTYqSDZgdmC2LcuINil2LnYp9iv2Kkg2KfZhNiq2LPYudmK2LEgc2VydmVyLXNpZGUKICogICAg2KXZhNiy2KfZhdmK2Kkg2YHZiiBjaGVja291dCAoc2VydmVyLmpzKSDZgtio2YQg2KPZiiBQYXltZW50SW50ZW50LgogKiDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZDilZAKICovCgppbXBvcnQgeyB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0JzsKaW1wb3J0IHsgdXNlUm91dGVyIH0gZnJvbSAnbmV4dC9uYXZpZ2F0aW9uJzsKaW1wb3J0IExpbmsgZnJvbSAnbmV4dC9saW5rJzsKaW1wb3J0IHsgdXNlQ2FydCB9IGZyb20gJy4uL2NvbnRleHQvQ2FydENvbnRleHQnOwppbXBvcnQgeyBJTUcgfSBmcm9tICcuLi8uLi9saWIvaW1hZ2VPcHRpbWl6ZXInOwppbXBvcnQgR2xhc3NJY29uIGZyb20gJ0AvY29tcG9uZW50cy91aS9HbGFzc0ljb24nOwoKaW50ZXJmYWNlIFByb2R1Y3QgewogIGlkOiBzdHJpbmcgfCBudW1iZXI7CiAgdGl0bGU6IHN0cmluZzsKICBwcmljZTogbnVtYmVyIHwgc3RyaW5nOwogIG9yaWdpbmFsX3ByaWNlPzogbnVtYmVyIHwgc3RyaW5nOwogIGltYWdlPzogc3RyaW5nOwogIGltYWdlX3VybD86IHN0cmluZzsKICBkZXNjcmlwdGlvbj86IHN0cmluZzsKICByYXRpbmc/OiBudW1iZXI7CiAgc2FsZXNfY291bnQ/OiBudW1iZXI7CiAgZGlzY291bnQ/OiBzdHJpbmc7CiAgdmFyaWFudHM/OiBhbnlbXTsKICAvKiog4pyoIFtjYXJkLXN3YXRjaGVzXSDigJQg2YXZhiDYp9mE2KjYp9mDIChLaXQgMzApOiB7Yzog2KfYs9mFINin2YTZhNmI2YYsIGk6INi12YjYsdipINin2YTZgCB2YXJpYW50LCB2OiB2aWR9ICovCiAgc3dhdGNoZXM/OiB7IGM6IHN0cmluZzsgaTogc3RyaW5nOyB2Pzogc3RyaW5nIH1bXTsKICAvKiog4pyoIFtjYXJkLXN3YXRjaGVzXSDigJQg2LnYr9ivINin2YTYo9mE2YjYp9mGINin2YTYstin2YrYr9ipINmB2YjZgiDYp9mE2YAgNSDYp9mE2YXYudix2YjYttmK2YYgKi8KICBzd01vcmU/OiBudW1iZXI7Cn0KCmludGVyZmFjZSBQcm9kdWN0Q2FyZFByb3BzIHsKICBwcm9kdWN0OiBQcm9kdWN0OwogIGlzVG91Y2hlZD86IGJvb2xlYW47CiAgLyoqIPCfqbkgRklYLUxBWlk6IHRydWUgPSBlYWdlciDZhNmE2LXZiNix2KkgKNij2YjZhCDZg9ix2YjYqiDYo9mI2YQg2LTYp9i02Kkg4oCUINmF2LHYtNit2YggTENQKSAqLwogIGVhZ2VyPzogYm9vbGVhbjsKfQoKZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gUHJvZHVjdENhcmQoeyBwcm9kdWN0LCBpc1RvdWNoZWQsIGVhZ2VyID0gZmFsc2UgfTogUHJvZHVjdENhcmRQcm9wcykgewogIGNvbnN0IHJvdXRlciA9IHVzZVJvdXRlcigpOwogIGNvbnN0IHsgYWRkVG9DYXJ0IH0gPSB1c2VDYXJ0KCk7CiAgY29uc3QgW2lzQWRkZWQsIHNldElzQWRkZWRdID0gdXNlU3RhdGUoZmFsc2UpOwogIC8vIOKcqCBbY2FyZC1zd2F0Y2hlc10g4oCUIGhvdmVyID0g2YXYudin2YrZhtipINmF2KTZgtiq2KkgwrcgY2xpY2sgPSDYp9iu2KrZitin2LEg2YXYq9io2KogKNmF2YjYqNin2YrZhCkKICBjb25zdCBbc3dIb3Zlciwgc2V0U3dIb3Zlcl0gPSB1c2VTdGF0ZSgtMSk7CiAgY29uc3QgW3N3U2VsLCBzZXRTd1NlbF0gPSB1c2VTdGF0ZSgtMSk7CgogIGNvbnN0IGhhbmRsZUNhcmRDbGljayA9ICgpID0+IHsKICAgIHJvdXRlci5wdXNoKGAvcHJvZHVjdHMvJHtwcm9kdWN0LmlkfWApOwogIH07CgogIC8vIOKcqCBbY2FyZC1zd2F0Y2hlc10g4oCUINmC2KfYptmF2Kkg2KfZhNiz2YjYp9iq2LTYp9iqINin2YTYtdin2YTYrdipICjiiaUyINio2KfYtCDYp9mE2LXZgSDZiti42YfYsSDigJQg2YTZiNmGINmI2KfYrdivINmF2Kcg2YPZitit2KrYp9is2LQg2LPZiNin2KrYtCkKICBjb25zdCBzd0xpc3QgPSBBcnJheS5pc0FycmF5KHByb2R1Y3Quc3dhdGNoZXMpCiAgICA/IHByb2R1Y3Quc3dhdGNoZXMuZmlsdGVyKChzKSA9PiBzICYmIHR5cGVvZiBzLmkgPT09ICdzdHJpbmcnICYmIHMuaSkKICAgIDogW107CiAgY29uc3QgaGFzU3dhdGNoZXMgPSBzd0xpc3QubGVuZ3RoID49IDI7CiAgY29uc3QgYWN0aXZlSWR4ID0gc3dIb3ZlciA+PSAwID8gc3dIb3ZlciA6IHN3U2VsOwogIGNvbnN0IGFjdGl2ZVN3ID0gaGFzU3dhdGNoZXMgJiYgYWN0aXZlSWR4ID49IDAgJiYgYWN0aXZlSWR4IDwgc3dMaXN0Lmxlbmd0aCA/IHN3TGlzdFthY3RpdmVJZHhdIDogbnVsbDsKCiAgY29uc3QgaGFuZGxlQWRkVG9DYXJ0ID0gKGU6IFJlYWN0Lk1vdXNlRXZlbnQpID0+IHsKICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICBlLnByZXZlbnREZWZhdWx0KCk7CgogICAgLy8g8J+puSBbY2FyZC1zd2F0Y2hlc10gRklYLVZJRCDigJQg2KfZhNij2YjZhNmI2YrYqSDZhNmE2YAgdmlkINiq2KfYuSDYp9mE2YTZiNmGINin2YTZhdiu2KrYp9ixL9in2YTZhdi52KfZitmGCiAgICAvLyAgICAo2YPYp9mGINmD2YrYtdmK2YHYtyAnJyDYr9in2YrZhdin2Ysg2YXZhiDYp9mE2YTYp9im2K3YqSDigJQg2KfZhNio2KfZgyDZg9in2YYg2YrZiNmC2Lkg2LnZhNmJINij2YjZhCB2YXJpYW50INio2YTYpyDYp9iu2KrZitin2LEpCiAgICBsZXQgZGVmYXVsdFZpZCA9ICcnOwogICAgaWYgKGFjdGl2ZVN3Py52KSB7CiAgICAgIGRlZmF1bHRWaWQgPSBhY3RpdmVTdy52OwogICAgfSBlbHNlIGlmIChwcm9kdWN0LnZhcmlhbnRzKSB7CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgdiA9IHR5cGVvZiBwcm9kdWN0LnZhcmlhbnRzID09PSAnc3RyaW5nJyA/IEpTT04ucGFyc2UocHJvZHVjdC52YXJpYW50cykgOiBwcm9kdWN0LnZhcmlhbnRzOwogICAgICAgIGlmIChBcnJheS5pc0FycmF5KHYpICYmIHZbMF0/LnZpZCkgZGVmYXVsdFZpZCA9IHZbMF0udmlkOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICAvLyDwn6m5IEZJWC1TSUxFTlQg4oCUIFRlbmV0OiBjYXRjaCDYqNmE2Kcg2LXZiNiqINmF2YXZhtmI2LkuIGVycm9yLWxldmVsINmK2YbYrNmIINmF2YYgcmVtb3ZlQ29uc29sZQogICAgICAgIGNvbnNvbGUuZXJyb3IoYFtQcm9kdWN0Q2FyZF0gdmFyaWFudHMgSlNPTiBwYXJzZSBmYWlsZWQgKHByb2R1Y3QgJHtwcm9kdWN0LmlkfSlgLCBlcnIpOwogICAgICB9CiAgICB9CgogICAgYWRkVG9DYXJ0KHsKICAgICAgaWQ6IHByb2R1Y3QuaWQsCiAgICAgIHRpdGxlOiBwcm9kdWN0LnRpdGxlLAogICAgICBwcmljZTogTnVtYmVyKHByb2R1Y3QucHJpY2UpIHx8IDAsCiAgICAgIHF1YW50aXR5OiAxLAogICAgICBpbWFnZTogcHJvZHVjdC5pbWFnZSB8fCBwcm9kdWN0LmltYWdlX3VybCB8fCAnL3BsYWNlaG9sZGVyLmpwZycsCiAgICAgIGltYWdlX3VybDogcHJvZHVjdC5pbWFnZV91cmwgfHwgcHJvZHVjdC5pbWFnZSB8fCAnL3BsYWNlaG9sZGVyLmpwZycsCiAgICAgIHZpZDogZGVmYXVsdFZpZAogICAgfSwgMSk7CgogICAgc2V0SXNBZGRlZCh0cnVlKTsKICAgIHNldFRpbWVvdXQoKCkgPT4gc2V0SXNBZGRlZChmYWxzZSksIDEyMDApOwogIH07CgogIGNvbnN0IHNhZmVQcmljZSA9IE51bWJlcihwcm9kdWN0LnByaWNlKSB8fCAwOwoKICAvLyDwn6m5IFRSVVNUIEZJWCDigJQgZGlzY291bnQg2YXZhiBvcmlnaW5hbF9wcmljZSDYp9mE2K3ZgtmK2YLZiiDZgdmC2LcgKENKKSDigJQg2LXZgdixINiu2LXZiNmF2KfYqiDZhdmB2KjYsdmD2Kk6CiAgLy8gICAg2KfZhNmG2LPYqNipINiq2Y/Yrdiz2Kgg2YXZhiBvcmlnaW5hbF9wcmljZSDYp9mE2K3ZgtmK2YLZiiDZgdmC2LfYjCDZiNin2YTYtNin2LHYqSDYqti42YfYsSDZgdmC2Lcg2LnZhtivINiu2LXZhSDYrdmC2YrZgtmKINmF2LnZgtmI2YQgKDEtODklKQogIGxldCBkaXNwbGF5T3JpZ2luYWxQcmljZSA9IE51bWJlcihwcm9kdWN0Lm9yaWdpbmFsX3ByaWNlKSB8fCAwOwogIGxldCBkaXNjb3VudFRleHQgPSAnJzsKCiAgaWYgKGRpc3BsYXlPcmlnaW5hbFByaWNlID4gc2FmZVByaWNlKSB7CiAgICBjb25zdCBkaXNjID0gTWF0aC5yb3VuZCgoKGRpc3BsYXlPcmlnaW5hbFByaWNlIC0gc2FmZVByaWNlKSAvIGRpc3BsYXlPcmlnaW5hbFByaWNlKSAqIDEwMCk7CiAgICBpZiAoZGlzYyA+IDAgJiYgZGlzYyA8IDkwKSB7CiAgICAgIGRpc2NvdW50VGV4dCA9IGAke2Rpc2N9JSBPRkZgOwogICAgfSBlbHNlIHsKICAgICAgZGlzcGxheU9yaWdpbmFsUHJpY2UgPSAwOwogICAgfQogIH0KCiAgLy8g8J+puSBGSVgtSU1HIOKAlCBPU1MgdHJhbnNmb3JtIDQwMHcgKH4xNUtCKSDigJQg4pyoIFtjYXJkLXN3YXRjaGVzXTog2KfZhNmF2LnYp9mK2YbYqSDZg9iq2KjYr9mEINin2YTYtdmI2LHYqQogIC8vICAgINmE2LXZiNix2Kkg2KfZhNmAIHZhcmlhbnQg2KfZhNmF2K7Yqtin2LEgKNmG2YHYsyDYp9mE2YAgdHJhbnNmb3JtIOKGkiDZhtmB2LMg2KfZhNij2K/Yp9ihKQogIGNvbnN0IGltZ1NyYyA9IElNRy5jYXJkKGFjdGl2ZVN3Py5pIHx8IHByb2R1Y3QuaW1hZ2VfdXJsIHx8IHByb2R1Y3QuaW1hZ2UgfHwgJy9wbGFjZWhvbGRlci5qcGcnKTsKCiAgY29uc3QgcHJvZHVjdFVybCA9IGAvcHJvZHVjdHMvJHtwcm9kdWN0LmlkfWA7CgogIHJldHVybiAoCiAgICA8ZGl2CiAgICAgIGRhdGEtcHJvZHVjdC1pZD17U3RyaW5nKHByb2R1Y3QuaWQpfQogICAgICBjbGFzc05hbWU9e2Bwcm9kdWN0LWNhcmQtd3JhcHBlciBwcm9kdWN0LWNhcmQtYW5pbWF0ZWQgYmctd2hpdGUgYm9yZGVyIGJvcmRlci10ZW11LWdyYXktYm9yZGVyLWxpZ2h0IHJvdW5kZWQtdGVtdS1zbSBvdmVyZmxvdy1oaWRkZW4gZmxleCBmbGV4LWNvbCBqdXN0aWZ5LWJldHdlZW4gZ3JvdXAgcmVsYXRpdmUgY3Vyc29yLXBvaW50ZXIgdHJhbnNpdGlvbi1hbGwgZHVyYXRpb24tMzAwIGFjdGl2ZTpzY2FsZS1bMC45OF0gc2hhZG93LXNtIGhvdmVyOnNoYWRvdy1tZCAkewogICAgICAgIGlzVG91Y2hlZCA/ICdpcy1hY3RpdmUnIDogJycKICAgICAgfWB9CiAgICAgIG9uQ2xpY2s9e2hhbmRsZUNhcmRDbGlja30KICAgID4KICAgICAgey8qIPCfqbkgRklYLUxJTksg4oCUIExpbmsg2K3ZgtmK2YLZiiAo2YPYp9mGIGRpdiDZgdmC2LcpOiBuZXctdGFiIC8ga2V5Ym9hcmQgLyBTRU8uCiAgICAgICAgICBzdG9wUHJvcGFnYXRpb24g2YrZhdmG2Lkg2KfZhNiq2YbZgdmK2LAg2KfZhNmF2LLYr9mI2KwgKExpbmsg2YrYqtmD2YHZhCDYqNin2YTYqtmG2YLZhCArIGRpdiBvbkNsaWNrKSAqL30KICAgICAgPExpbmsKICAgICAgICBocmVmPXtwcm9kdWN0VXJsfQogICAgICAgIHByZWZldGNoPXtmYWxzZX0KICAgICAgICBvbkNsaWNrPXsoZSkgPT4gZS5zdG9wUHJvcGFnYXRpb24oKX0KICAgICAgICBjbGFzc05hbWU9ImJsb2NrIgogICAgICA+CiAgICAgICAgPGRpdiBjbGFzc05hbWU9InJlbGF0aXZlIGFzcGVjdC1zcXVhcmUgYmctdGVtdS1vZmZ3aGl0ZSBvdmVyZmxvdy1oaWRkZW4iPgogICAgICAgICAgey8qIOKcqCBpbWcg4oCUIPCfqbkgRklYLUlNRyAoT1NTIHRyYW5zZm9ybSkgKyDwn6m5IEZJWC1MQVpZIChsYXp5L2FzeW5jICsgZWFnZXIg2KfYrtiq2YrYp9ix2YopCiAgICAgICAgICAgICAg4pyoIFtjYXJkLXN3YXRjaGVzXTogYWN0aXZlU3c/LmkgPSDYtdmI2LHYqSDYp9mE2YTZiNmGINin2YTZhdiu2KrYp9ixICjZhtmB2LMgT1NTIHRyYW5zZm9ybSkgKi99CiAgICAgICAgICA8aW1nCiAgICAgICAgICAgIHNyYz17aW1nU3JjfQogICAgICAgICAgICBhbHQ9e3Byb2R1Y3QudGl0bGUgfHwgJ1Byb2R1Y3QnfQogICAgICAgICAgICBsb2FkaW5nPXtlYWdlciA/ICdlYWdlcicgOiAnbGF6eSd9CiAgICAgICAgICAgIGRlY29kaW5nPSJhc3luYyIKICAgICAgICAgICAgY2xhc3NOYW1lPSJ3LWZ1bGwgaC1mdWxsIG9iamVjdC1jb250YWluIHAtMiB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi01MDAgZ3JvdXAtaG92ZXI6c2NhbGUtMTA1IgogICAgICAgICAgLz4KICAgICAgICAgIHtkaXNjb3VudFRleHQgJiYgKAogICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT0iYWJzb2x1dGUgdG9wLTIgbGVmdC0yIGJnLXRlbXUtZXJyb3IgdGV4dC13aGl0ZSB0ZXh0LVsxMHB4XSBmb250LWJsYWNrIHB4LTIgcHktMC41IHJvdW5kZWQgc2hhZG93LXNtIj4KICAgICAgICAgICAgICB7ZGlzY291bnRUZXh0fQogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICl9CiAgICAgICAgPC9kaXY+CgogICAgICAgIDxkaXYgY2xhc3NOYW1lPSJwLTMgcGItMiI+CiAgICAgICAgICA8aDMgY2xhc3NOYW1lPSJ0ZXh0LXhzIGZvbnQtYm9sZCB0ZXh0LXRlbXUtYmxhY2sgbGluZS1jbGFtcC0yIG1iLTIgZ3JvdXAtaG92ZXI6dGV4dC10ZW11LW9yYW5nZSB0cmFuc2l0aW9uIG1pbi1oLVszMnB4XSBsZWFkaW5nLXJlbGF4ZWQiPgogICAgICAgICAgICB7cHJvZHVjdC50aXRsZX0KICAgICAgICAgIDwvaDM+CgogICAgICAgICAgey8qIPCfqbkgRklYLVpFUk8g4oCUINio2YTYpyDYs9i52LEg2K3ZgtmK2YLZiiDZhdinINmD2KfZitmG2LQgIiQwLjAwIiAqL30KICAgICAgICAgIHtzYWZlUHJpY2UgPiAwICYmICgKICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9ImZsZXggaXRlbXMtYmFzZWxpbmUgZ2FwLTIgbWItMSBmbGV4LXdyYXAiPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT0idGV4dC1iYXNlIGZvbnQtYmxhY2sgdGV4dC10ZW11LWVycm9yIj4KICAgICAgICAgICAgICAgICR7c2FmZVByaWNlLnRvRml4ZWQoMil9CiAgICAgICAgICAgICAgPC9zcGFuPgogICAgICAgICAgICAgIHtkaXNwbGF5T3JpZ2luYWxQcmljZSA+IHNhZmVQcmljZSAmJiAoCiAgICAgICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9InRleHQtWzExcHhdIHRleHQtdGVtdS1ncmF5LWxpZ2h0IGxpbmUtdGhyb3VnaCBmb250LW1lZGl1bSI+CiAgICAgICAgICAgICAgICAgICR7ZGlzcGxheU9yaWdpbmFsUHJpY2UudG9GaXhlZCgyKX0KICAgICAgICAgICAgICAgIDwvc3Bhbj4KICAgICAgICAgICAgICApfQogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICl9CiAgICAgICAgPC9kaXY+CiAgICAgIDwvTGluaz4KCiAgICAgIHsvKiDinKggW2NhcmQtc3dhdGNoZXNdIOKAlCDYtdmBINin2YTYs9mI2KfYqti02KfYqjog2K7Yp9ix2Kwg2KfZhNmAIExpbmsgKNmD2YTZitmDINmF2Kcg2YPZitio2K/ZhNi0INin2YTYtdmB2K3YqSkKICAgICAgICAgIHN0b3BQcm9wYWdhdGlvbiDZitmF2YbYuSBjYXJkIG9uQ2xpY2sgwrcgaG92ZXI92YXYudin2YrZhtipIMK3IGNsaWNrPdiq2KvYqNmK2KogKi99CiAgICAgIHtoYXNTd2F0Y2hlcyAmJiAoCiAgICAgICAgPGRpdgogICAgICAgICAgY2xhc3NOYW1lPSJweC0zIHBiLTEgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSBmbGV4LXdyYXAiCiAgICAgICAgICBvbk1vdXNlTGVhdmU9eygpID0+IHNldFN3SG92ZXIoLTEpfQogICAgICAgID4KICAgICAgICAgIHtzd0xpc3QubWFwKChzLCBpZHgpID0+ICgKICAgICAgICAgICAgPGJ1dHRvbgogICAgICAgICAgICAgIGtleT17YCR7cy5jIHx8ICdzdyd9LSR7aWR4fWB9CiAgICAgICAgICAgICAgdHlwZT0iYnV0dG9uIgogICAgICAgICAgICAgIHRpdGxlPXtzLmMgfHwgJ0NvbG9yJ30KICAgICAgICAgICAgICBhcmlhLWxhYmVsPXtgQ29sb3I6ICR7cy5jIHx8ICdvcHRpb24nfSR7c3dTZWwgPT09IGlkeCA/ICcgKHNlbGVjdGVkKScgOiAnJ31gfQogICAgICAgICAgICAgIGFyaWEtcHJlc3NlZD17c3dTZWwgPT09IGlkeH0KICAgICAgICAgICAgICBvbk1vdXNlRW50ZXI9eygpID0+IHNldFN3SG92ZXIoaWR4KX0KICAgICAgICAgICAgICBvbkNsaWNrPXsoZSkgPT4gewogICAgICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICAgICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgICAgICAgICAgICAgIHNldFN3U2VsKChwcmV2KSA9PiAocHJldiA9PT0gaWR4ID8gLTEgOiBpZHgpKTsKICAgICAgICAgICAgICB9fQogICAgICAgICAgICAgIGNsYXNzTmFtZT17YHctNSBoLTUgcm91bmRlZC1tZCBvdmVyZmxvdy1oaWRkZW4gYm9yZGVyIHRyYW5zaXRpb24tYWxsIGR1cmF0aW9uLTE1MCBjdXJzb3ItcG9pbnRlciBwLTAgJHsKICAgICAgICAgICAgICAgIGFjdGl2ZUlkeCA9PT0gaWR4CiAgICAgICAgICAgICAgICAgID8gJ2JvcmRlci10ZW11LWJsYWNrIHJpbmctMiByaW5nLXRlbXUtYmxhY2sgcmluZy1vZmZzZXQtMSByaW5nLW9mZnNldC13aGl0ZScKICAgICAgICAgICAgICAgICAgOiAnYm9yZGVyLXRlbXUtZ3JheS1ib3JkZXItbGlnaHQgaG92ZXI6Ym9yZGVyLXRlbXUtZ3JheS1saWdodCcKICAgICAgICAgICAgICB9YH0KICAgICAgICAgICAgPgogICAgICAgICAgICAgIDxpbWcKICAgICAgICAgICAgICAgIHNyYz17SU1HLnRodW1iKHMuaSl9CiAgICAgICAgICAgICAgICBhbHQ9IiIKICAgICAgICAgICAgICAgIGxvYWRpbmc9ImxhenkiCiAgICAgICAgICAgICAgICBkZWNvZGluZz0iYXN5bmMiCiAgICAgICAgICAgICAgICBjbGFzc05hbWU9InctZnVsbCBoLWZ1bGwgb2JqZWN0LWNvdmVyIgogICAgICAgICAgICAgIC8+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgKSl9CiAgICAgICAgICB7dHlwZW9mIHByb2R1Y3Quc3dNb3JlID09PSAnbnVtYmVyJyAmJiBwcm9kdWN0LnN3TW9yZSA+IDAgJiYgKAogICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9InRleHQtWzEwcHhdIGZvbnQtYm9sZCB0ZXh0LXRlbXUtZ3JheS1saWdodCBsZWFkaW5nLW5vbmUiPit7cHJvZHVjdC5zd01vcmV9PC9zcGFuPgogICAgICAgICAgKX0KICAgICAgICAgIHthY3RpdmVTdz8uYyAmJiAoCiAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT0idGV4dC1bMTBweF0gdGV4dC10ZW11LWdyYXktbGlnaHQgdHJ1bmNhdGUgbWF4LXctWzkwcHhdIGxlYWRpbmctbm9uZSI+CiAgICAgICAgICAgICAge2FjdGl2ZVN3LmN9CiAgICAgICAgICAgIDwvc3Bhbj4KICAgICAgICAgICl9CiAgICAgICAgPC9kaXY+CiAgICAgICl9CgogICAgICA8ZGl2IGNsYXNzTmFtZT0icC0zIHB0LTAiPgogICAgICAgIDxidXR0b24KICAgICAgICAgIHR5cGU9ImJ1dHRvbiIKICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUFkZFRvQ2FydH0KICAgICAgICAgIGNsYXNzTmFtZT17YHctZnVsbCBmb250LWJvbGQgcHktMi41IHB4LTMgcm91bmRlZC10ZW11LXNtIHRyYW5zaXRpb24tYWxsIGR1cmF0aW9uLTIwMCBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBnYXAtMS41IHRleHQteHMgY3Vyc29yLXBvaW50ZXIgYWN0aXZlOnNjYWxlLTkwIHNoYWRvdy1zbSAkewogICAgICAgICAgICBpc0FkZGVkCiAgICAgICAgICAgICAgPyAnYmctZW1lcmFsZC02MDAgdGV4dC13aGl0ZSBzaGFkb3ctZW1lcmFsZC01MDAvMjAnCiAgICAgICAgICAgICAgOiAnYmctdGVtdS1vcmFuZ2UgaG92ZXI6YmctdGVtdS1vcmFuZ2UtYnJpZ2h0IHRleHQtd2hpdGUnCiAgICAgICAgICB9YH0KICAgICAgICA+CiAgICAgICAgICB7aXNBZGRlZCA/ICgKICAgICAgICAgICAgPD4KICAgICAgICAgICAgICA8c3Bhbj48R2xhc3NJY29uIGk9ImNoZWNrIiBzaXplPSJ4cyIgLz48L3NwYW4+IEFkZGVkIHRvIENhcnQKICAgICAgICAgICAgPC8+CiAgICAgICAgICApIDogKAogICAgICAgICAgICA8PgogICAgICAgICAgICAgIDxzdmcgd2lkdGg9IjE0IiBoZWlnaHQ9IjE0IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2VXaWR0aD0iMi41Ij48cGF0aCBkPSJNNiAyTDMgNnYxNGEyIDIgMCAwIDAgMiAyaDE0YTIgMiAwIDAgMCAyLTJWNmwtMy00eiI+PC9wYXRoPjxsaW5lIHgxPSIzIiB5MT0iNiIgeDI9IjIxIiB5Mj0iNiI+PC9saW5lPjxwYXRoIGQ9Ik0xNiAxMGE0IDQgMCAwIDEtOCAwIj48L3BhdGg+PC9zdmc+CiAgICAgICAgICAgICAgQWRkIHRvIENhcnQKICAgICAgICAgICAgPC8+CiAgICAgICAgICApfQogICAgICAgIDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICk7Cn0K"

DIAG = None

def diag(name, content):
    global DIAG
    try:
        if DIAG is None:
            DIAG = 'kit30-diag'
        os.makedirs(DIAG, exist_ok=True)  # ديما — حتى ملي DIAG محدد مسبقاً
        with io.open(os.path.join(DIAG, name), 'w', encoding='utf-8') as f:
            f.write(content)
    except Exception as e:
        print('⚠️ diag write failed:', e)

def find_one(candidates, what):
    for c in candidates:
        if os.path.isfile(c):
            return c
    print(f'❌ ما لقيتش {what} فـ: {candidates}')
    return None

def patch_backend(root):
    global DIAG
    path = find_one([os.path.join(root, 'server.js'), os.path.join(root, 'backend', 'server.js'),
                     os.path.join(root, 'src', 'server.js')], 'server.js (backend)')
    if not path:
        diag('backend-missing.txt', 'server.js not found under ' + root)
        return 1
    DIAG = os.path.join(os.path.dirname(path), 'kit30-diag')  # diag ديما جنب الملف المستهدف
    with io.open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    orig = text

    if MARKER in text:
        print('⏭️  الباك مركب من قبل [card-swatches] — skip (idempotent)')
        return 0

    # ── fail-closed: كل الأنكورات قبل حتى كتابة ──
    problems = []
    if text.count(A_HELPER) != 1:
        problems.append(f"helper anchor count={text.count(A_HELPER)} (متوقع 1)")
    for name, old, new in BACKEND_PATCHES:
        n = text.count(old)
        if n != 1:
            problems.append(f"{name}: count={n} (متوقع 1)")
    if problems:
        msg = 'الأنكورات ما طابقوش — ما تبدل والو (fail-closed):\n' + '\n'.join('  - ' + p for p in problems)
        print('❌ ' + msg)
        diag('backend-anchors-fail.txt', msg + '\n\n=== BEFORE ===\n' + orig)
        return 1

    # ── التطبيق ──
    text = text.replace(A_HELPER, HELPER_BLOCK + '\n\n' + A_HELPER, 1)
    for name, old, new in BACKEND_PATCHES:
        text = text.replace(old, new, 1)

    # ── فحوصات ما بعد الكتابة (على النص، قبل الفسح للديسك) ──
    post = []
    if text.count('${SW_SQL}') != 5:
        post.append(f"${{SW_SQL}} count={text.count('${SW_SQL}')} (متوقع 5)")
    if text.count('withSwatches(') != 6:
        post.append(f"withSwatches( count={text.count('withSwatches(')} (متوقع 6: 5 نداءات + 1 تعريف)")
    if text.count(FULL_ANCHOR_INTACT) != 1:
        post.append(f"FULL branch anchor count={text.count(FULL_ANCHOR_INTACT)} (متوقع 1 — يبقى بلا سواتشات)")
    if text.count(HELPER_START) != 1 or text.count(HELPER_END) != 1:
        post.append('helper markers مكررين/ناقصين')
    if post:
        msg = 'فحوصات ما بعد الترقيع فشلو — ما تبدل والو:\n' + '\n'.join('  - ' + p for p in post)
        print('❌ ' + msg)
        diag('backend-post-fail.txt', msg + '\n\n=== AFTER-IN-MEMORY ===\n' + text)
        return 1

    # ── backup + كتابة ──
    bak = path + '.bak-kit30'
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    diag('server.after.js', text)
    print(f'✅ الباك ترقع: {path} (backup: {bak})')

    # ── node --check (إن وجد) — فشلو = تراجع ──
    node = shutil.which('node')
    if node:
        r = subprocess.run([node, '--check', path], capture_output=True, text=True)
        if r.returncode != 0:
            shutil.copy2(bak, path)
            msg = 'node --check فشل — تراجعنا للـ backup:\n' + (r.stderr or r.stdout)
            print('❌ ' + msg)
            diag('backend-nodecheck-fail.txt', msg)
            return 1
        print('✅ node --check سليم')
    else:
        print('⚠️ node ماكانش فالـ PATH — ناقص فحص --check (راح يبان فالديبلوي)')
    return 0

def patch_frontend(root):
    global DIAG
    path = find_one([os.path.join(root, 'app', 'components', 'ProductCard.tsx'),
                     os.path.join(root, 'src', 'app', 'components', 'ProductCard.tsx')], 'ProductCard.tsx (frontend)')
    if not path:
        diag('frontend-missing.txt', 'ProductCard.tsx not found under ' + root)
        return 1
    DIAG = os.path.join(os.path.dirname(path), 'kit30-diag')  # diag ديما جنب الملف المستهدف
    with io.open(path, 'r', encoding='utf-8') as f:
        text = f.read()

    if MARKER in text:
        print('⏭️  الفرونت مركب من قبل [card-swatches] — skip (idempotent)')
        return 0

    # ── fail-closed: الكارت الحالي خاصو يكون هو النسخة المتوقعة ──
    need = ['interface Product {', 'handleAddToCart', 'IMG.card(', "from '../context/CartContext'"]
    missing = [s for s in need if s not in text]
    if missing:
        msg = 'ProductCard.tsx ما طابقش المتوقع (drift؟) — ما تبدل والو:\n' + '\n'.join('  - ' + m for m in missing)
        print('❌ ' + msg)
        diag('frontend-anchors-fail.txt', msg + '\n\n=== CURRENT ===\n' + text)
        return 1

    bak = path + '.bak-kit30'
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    new_src = base64.b64decode(PRODUCT_CARD_B64).decode('utf-8')
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(new_src)
    diag('ProductCard.after.tsx', new_src)
    print(f'✅ الفرونت ترقع: {path} (backup: {bak})')
    return 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend', default=None, help='جذر الباك (فين server.js)')
    ap.add_argument('--frontend', default=None, help='جذر الفرونت (فين app/)')
    args = ap.parse_args()
    if not args.backend and not args.frontend:
        print('❌ حدد --backend أو --frontend (أو بجوج)')
        return 2
    rc = 0
    if args.backend:
        print('═══ [card-swatches] BACKEND ═══')
        rc |= patch_backend(args.backend)
    if args.frontend:
        print('═══ [card-swatches] FRONTEND ═══')
        rc |= patch_frontend(args.frontend)
    if rc == 0:
        print('═══ كيت 30 مكتمل — swatches راهم فالطريق 🎨 ═══')
    return rc

if __name__ == '__main__':
    sys.exit(main())
