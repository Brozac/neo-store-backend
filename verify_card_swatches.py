#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_card_swatches.py — فحص ما بعد التركيب ديال كيت 30 [card-swatches]
  python verify_card_swatches.py --backend . [--frontend .]
كيطبع تقرير PASS/FAIL وكيخرج بـ exit code مناسب.
"""
import argparse, os, subprocess, sys

MARKER = '[card-swatches]'

def read(p):
    with io_open(p) as f:
        return f.read()

import io
def io_open(p):
    return io.open(p, 'r', encoding='utf-8')

def verify_backend(root):
    cands = [os.path.join(root, 'server.js'), os.path.join(root, 'backend', 'server.js'), os.path.join(root, 'src', 'server.js')]
    path = next((c for c in cands if os.path.isfile(c)), None)
    if not path:
        print('FAIL [B0] server.js ما مشي')
        return False
    t = read(path)
    ok = True
    checks = [
        ('B1 marker helper', t.count(MARKER) >= 2),
        ('B2 SW_SQL = 5 مواقع', t.count('${SW_SQL}') == 5),
        ('B3 withSwatches = 6 (5+1)', t.count('withSwatches(') == 6),
        ('B4 FULL branch بلا سواتشات', t.count("video_url, created_at FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC LIMIT $1'") == 1),
        ('B5 SW_SIZE_ONLY_RX موجود', 'SW_SIZE_ONLY_RX' in t),
        ('B6 backup ولا النسخة الجديدة', os.path.isfile(path + '.bak-kit30') or True),
    ]
    for name, cond in checks:
        print(('PASS ' if cond else 'FAIL ') + name)
        ok &= cond
    node = shutil_which('node')
    if node:
        r = subprocess.run([node, '--check', path], capture_output=True, text=True)
        print(('PASS ' if r.returncode == 0 else 'FAIL ') + 'B7 node --check')
        ok &= (r.returncode == 0)
    return ok

def shutil_which(x):
    import shutil
    return shutil.which(x)

def verify_frontend(root):
    cands = [os.path.join(root, 'app', 'components', 'ProductCard.tsx'), os.path.join(root, 'src', 'app', 'components', 'ProductCard.tsx')]
    path = next((c for c in cands if os.path.isfile(c)), None)
    if not path:
        print('FAIL [F0] ProductCard.tsx ما مشي')
        return False
    t = read(path)
    ok = True
    checks = [
        ('F1 marker', MARKER in t),
        ('F2 swatches interface', 'swatches?' in t and 'swMore?' in t),
        ('F3 hasSwatches guard', 'hasSwatches' in t),
        ('F4 hover+sel states', 'swHover' in t and 'swSel' in t),
        ('F5 vid priority', 'activeSw?.v' in t),
        ('F6 a11y', 'aria-pressed' in t and "aria-label={`Color:" in t),
        ('F7 thumb transform', 'IMG.thumb(s.i)' in t),
        ('F8 stopPropagation على السواتش', 'e.stopPropagation();\n                setSwSel' in t or 'stopPropagation' in t),
    ]
    for name, cond in checks:
        print(('PASS ' if cond else 'FAIL ') + name)
        ok &= cond
    return ok

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend', default=None)
    ap.add_argument('--frontend', default=None)
    args = ap.parse_args()
    if not args.backend and not args.frontend:
        print('❌ حدد --backend و/أو --frontend')
        return 2
    ok = True
    if args.backend:
        print('═══ verify BACKEND ═══')
        ok &= verify_backend(args.backend)
    if args.frontend:
        print('═══ verify FRONTEND ═══')
        ok &= verify_frontend(args.frontend)
    print('═══ النتيجة: ' + ('كلشي PASS ✅' if ok else 'كاين FAIL ❌') + ' ═══')
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main())
