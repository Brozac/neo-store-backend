#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
════════════════════════════════════════════════════════════════════
laclarc fix_visibility_settings.py — v25 [visibility-persist]
════════════════════════════════════════════════════════════════════
المشكل اللي رفع المالك:
  «حبست فرع من غرفة التحكم في الظهور، درت save، عاودت دخلت → لقيتو رجع»

الجذر (مثبت بالكود — server.js من GitHub HEAD 51c9a78):
  1) PUT  /api/admin/settings/:key      → كان خدّام والتخزين في store_settings
                                          جرى بلا مشكل (الداتا كانت كتسجل فعلاً)
  2) GET  /api/admin/settings           → كان يرجّع show_reels وحداه
                                          → الغرفة بعد reload كتلقى الحالة خاوية
  3) GET  /api/settings (العام)         → whitelist بلا hidden_routes/hidden_sections
                                          + تحويل value === 'true' فقط
                                          → الزوار ما كانوش يقدرو يقراو الحجب

الرقعة (3 عمليات، كل واحدة بمرساة دقيقة):
  A) admin GET      → يرجّع show_reels + hidden_routes + hidden_sections
  B) public GET     → القائمتين داخل whitelist كقوائم JSON (سقف 100، فاسدة = [])
  C) PUT            → حارس شكل المفتاح + حارس الحجم (نفس السلوك للصالح)

حمايات:
  - idempotent: marker [visibility-persist] موجود = SKIP بلا لمسة
  - backup: server.js.bak-visibility-<timestamp> قبل أي كتابة
  - node --check بعد الرقعة (إلا node موجود)
  - أرضية منجرفة (--full): يستبدل server.js كامل بـ server.patched.js
════════════════════════════════════════════════════════════════════
"""

import sys
import os
import shutil
import subprocess
import time

MARKER = "[visibility-persist]"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ═══════════════════ الرقع: OLD → NEW (بال حرف من 51c9a78) ═══════════════════

OLD_A = """// ═══ 🆕 /admin/settings GET — زوج الـ PUT /admin/settings/:key ═══
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM store_settings WHERE key = 'show_reels' LIMIT 1`
    );
    const v = rows[0]?.value;
    res.json({ show_reels: v === undefined ? true : (v === true || v === 'true') });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    console.error('[admin/settings GET] failed:', e.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});"""

NEW_A = """// ═══ 🆕 /admin/settings GET — زوج الـ PUT /admin/settings/:key ═══
// 🆕 v25 [visibility-persist] — يرجّع show_reels + hidden_routes + hidden_sections.
//    القديم كان يرجّع show_reels وحداه → غرفة التحكم في الظهور كتلقى الحالة خاوية
//    بعد كل reload («سجّلت ورجعت») — الجذر كان هنا، التخزين في store_settings كان خدّام.
const ADMIN_SETTING_KEYS = ['show_reels', 'hidden_routes', 'hidden_sections'];
const ADMIN_LIST_KEYS = ['hidden_routes', 'hidden_sections'];
function parseSettingValue(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').slice(0, 100);
  const s = String(raw).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  try {
    const p = JSON.parse(s);
    if (Array.isArray(p)) return p.filter((x) => typeof x === 'string').slice(0, 100);
    return p;
  } catch { return s; }
}
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM store_settings WHERE key = ANY($1)', [ADMIN_SETTING_KEYS]
    );
    const out = { show_reels: true, hidden_routes: [], hidden_sections: [] };
    for (const row of rows) {
      const v = parseSettingValue(row.value);
      if (row.key === 'show_reels') {
        out.show_reels = (v === undefined) ? true : (v === true || v === 'true');
      } else if (ADMIN_LIST_KEYS.includes(row.key) && Array.isArray(v)) {
        out[row.key] = v;
      }
    }
    res.json(out);
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    console.error('[admin/settings GET] failed:', e.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});"""

OLD_B = """const PUBLIC_SETTING_KEYS = ['show_reels', 'show_lightning', 'show_fb'];
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings WHERE key = ANY($1)', [PUBLIC_SETTING_KEYS]);
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = row.value === 'true';
      return acc;
    }, {});
    res.json(settings);"""

NEW_B = """// 🆕 v25 [visibility-persist] — hidden_routes/hidden_sections داخلو للـ whitelist
//    كقوائم JSON (مصفوفة strings، سقف 100) — الواجهة كتقرا الحجب من هنا.
//    قيمة فاسدة/ناقصة = [] (fail-open: كلش باين — ما كيتحبس والو بغلط).
const PUBLIC_SETTING_KEYS = ['show_reels', 'show_lightning', 'show_fb', 'hidden_routes', 'hidden_sections'];
const PUBLIC_LIST_KEYS = ['hidden_routes', 'hidden_sections'];
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings WHERE key = ANY($1)', [PUBLIC_SETTING_KEYS]);
    const settings = rows.reduce((acc, row) => {
      if (PUBLIC_LIST_KEYS.includes(row.key)) {
        try {
          const p = Array.isArray(row.value) ? row.value : JSON.parse(String(row.value));
          acc[row.key] = Array.isArray(p) ? p.filter((x) => typeof x === 'string').slice(0, 100) : [];
        } catch { acc[row.key] = []; }
      } else {
        acc[row.key] = row.value === 'true';
      }
      return acc;
    }, {});
    res.json(settings);"""

OLD_C = """// PUT: تحديث إعداد معين (مثل إظهار/إخفاء الريلز)
app.put('/api/admin/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body; // true أو false

  try {
    await pool.query(
      'INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, String(value)]
    );
    res.json({ success: true, message: 'Setting updated successfully' });"""

NEW_C = """// PUT: تحديث إعداد معين (مثل إظهار/إخفاء الريلز وقوائم الظهور hidden_routes/hidden_sections)
// 🆕 v25 [visibility-persist] — حارس شكل المفتاح وحجم القيمة (نفس السلوك للمفاتيح الصالحة)
const SETTING_KEY_RX = /^[a-z0-9_]{1,64}$/;
app.put('/api/admin/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body; // true / false / JSON string (قائمة مفاتيح مخفية)

  if (!SETTING_KEY_RX.test(String(key || ''))) {
    return res.status(400).json({ error: 'Invalid setting key' });
  }
  const stored = String(value);
  if (stored.length > 10000) {
    return res.status(400).json({ error: 'Setting value too large' });
  }

  try {
    await pool.query(
      'INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, stored]
    );
    res.json({ success: true, message: 'Setting updated successfully' });"""

PATCHES = [("A", "admin GET (الغرفة كتقرا من هنا)", OLD_A, NEW_A),
           ("B", "public GET (الزوار كيقراو الحجب من هنا)", OLD_B, NEW_B),
           ("C", "PUT guards (حارس المفتاح والحجم)", OLD_C, NEW_C)]


def read_text(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def write_text(path, content):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)


def node_check(path):
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        print("  ⚠️ node ما لقيتوش — نقزنا فحص السينتاكس (دارو Render فالديبلوا)")
        return True
    r = subprocess.run([node, "--check", path], capture_output=True, text=True)
    if r.returncode != 0:
        print("  ❌ node --check فشل:\n" + (r.stderr or "")[:1200])
        return False
    print("  ✅ node --check سليم")
    return True


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    target = args[0] if args else os.path.join(SCRIPT_DIR, "server.js")
    if not os.path.isfile(target):
        print("❌ ما لقيتش server.js في: " + target)
        print("   حط الكيت فمجلد الباكند (جنب server.js) ولا مرّر المسار: python fix_visibility_settings.py <path>")
        return 1

    src = read_text(target)
    crlf = "\r\n" in src
    norm = src.replace("\r\n", "\n") if crlf else src
    print(f"🎯 الهدف: {target}  ({len(norm.splitlines())} سطر · CRLF={crlf})")

    # ── idempotency ──
    if MARKER in norm:
        print("✅ الملف مرقّع من قبل [visibility-persist] — والو باش نديرو. SKIP.")
        return 0

    # ── الرقعة العادية: مراسي دقيقة ──
    ok = True
    out = norm
    for pid, name, old, new in PATCHES:
        n = out.count(old)
        if n == 1:
            out = out.replace(old, new)
            print(f"  ✅ [{pid}] {name} — ترقّعت")
        elif n == 0 and new in out:
            print(f"  ⏭️ [{pid}] {name} — مرقّعة من قبل")
        else:
            print(f"  ❌ [{pid}] {name} — المرساة لقاها {n} مرات (متوقعة: 1) — انجراف فالملف")
            ok = False
    if not ok:
        print("\n❌ الرقعة الدقيقة ما ركبتش (الملف محلياً ماختالف على GitHub HEAD 51c9a78).")
        print("   جرب الوضع الكامل:  python fix_visibility_settings.py --full  ")
        print("   (كيبدّل server.js كامل بـ server.patched.js — نفس المصدر + الرقعة)")
        return 1

    # ── backup + كتابة ──
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = target + ".bak-visibility-" + stamp
    shutil.copy2(target, bak)
    print(f"  💾 Backup: {os.path.basename(bak)}")
    final = out.replace("\n", "\r\n") if crlf else out
    write_text(target, final)
    print("  ✅ الرقعة تكتبت")

    if not node_check(target):
        print("  ↩️ نرجعو الـ backup...")
        shutil.copy2(bak, target)
        return 1

    print("\n🎉 الرقعة ركبت — دابا:")
    print("   1) PUSH-DEPLOY.bat  (ولا: git add server.js && git commit -m 'visibility-persist v25' && git push)")
    print("   2) استنى Render deploy (~دقيقتين) — شوف اللوج حتى: 'Deploy live'")
    print("   3) التحقق: افتح فالبراوزر https://neo-store-backend.onrender.com/api/settings")
    print("      خاصك تشوف: {\"show_reels\":true} — ومن بعد أول save خاصو يبان فيه hidden_routes")
    print("   4) غرفة التحكم: /admin/visibility → حبس فرع → save → عاود دخّل الصفحة = الحالة باقة 💪")
    return 0


def full_mode():
    target = os.path.join(SCRIPT_DIR, "server.js")
    full = os.path.join(SCRIPT_DIR, "server.patched.js")
    if not os.path.isfile(target):
        print("❌ ما لقيتش server.js جنب الكيت — حط الكيت فمجلد الباكند.")
        return 1
    if not os.path.isfile(full):
        print("❌ server.patched.js ناقص من الكيت — ما نقدرش ندير --full")
        return 1
    patched = read_text(full)
    if MARKER not in patched:
        print("❌ server.patched.js فيه مشكل (marker ناقص) — ما نكملش.")
        return 1
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = target + ".bak-visibility-" + stamp
    shutil.copy2(target, bak)
    print(f"  💾 Backup: {os.path.basename(bak)}")
    src = read_text(target)
    crlf = "\r\n" in src
    write_text(target, patched.replace("\n", "\r\n") if crlf else patched)
    print("  ✅ الملف الكامل المرقّع تنسخ")
    if not node_check(target):
        shutil.copy2(bak, target)
        return 1
    print("\n🎉 --full دار خدمتو — نفس خطوات PUSH-DEPLOY فوق.")
    return 0


if __name__ == "__main__":
    if "--full" in sys.argv:
        sys.exit(full_mode())
    sys.exit(main())
