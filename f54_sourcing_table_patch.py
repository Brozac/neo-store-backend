#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
F#54 — FIX [F54-SOURCING-TABLE]
ضمان جدول cj_sourcing_requests قبل استعلام كرون SourcingWatch (04:30/16:30)
السبب (Sentry SERVER-R): CREATE TABLE موجود فقط داخل POST /api/admin/sourcing/create
→ الكرون يرمي relation "cj_sourcing_requests" does not exist كل يوم.
الإصلاح: ensure-table في أول runSourcingWatch (نفس DDL تاع الراوت).
الترتيب (درس جولة الـ push): pull --rebase أولاً → باتش → فحص → commit → push (الحارس يخدم وحدو).
"""
import os, sys, shutil, subprocess

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MARK = "F54-SOURCING-TABLE"
ANCHOR = "async function runSourcingWatch() {"
CREATE_COUNT_EXPECTED = 2  # الراوت (3245) + بتاعنا

DDL_BLOCK = [
    "",
    "  // 🩹 FIX [" + MARK + "] — ضمان الجدول قبل الاستعلام (كان CREATE داخل /api/admin/sourcing/create فقط",
    "  //    → كرون السورسنغ 04:30/16:30 يرمي relation \"cj_sourcing_requests\" does not exist كل يوم — Sentry SERVER-R)",
    "  await pool.query(`",
    "    CREATE TABLE IF NOT EXISTS cj_sourcing_requests (",
    "      source_id TEXT PRIMARY KEY,",
    "      product_name TEXT,",
    "      status TEXT DEFAULT 'pending',",
    "      notified BOOLEAN DEFAULT FALSE,",
    "      payload JSONB,",
    "      created_at TIMESTAMPTZ DEFAULT NOW(),",
    "      updated_at TIMESTAMPTZ DEFAULT NOW()",
    "    )",
    "  `);",
    "",
]

def die(msg, code=1):
    print("❌ " + msg)
    sys.exit(code)

def ok(msg):
    print("✅ " + msg)

def git(args, cwd):
    r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")

def main():
    local_test = "--local-test" in sys.argv
    if local_test:
        repo = sys.argv[sys.argv.index("--local-test") + 1]
    else:
        repo = os.path.dirname(os.path.abspath(__file__))
    server = os.path.join(repo, "server.js")
    if not os.path.isfile(server):
        die("server.js ما لقيتوش في " + repo + " — حط السكربت في جذر DRPS\\backend")

    print("══════════════════════════════════════════")
    print(" F#54 — Sourcing Table Fix (SERVER-R)")
    print("══════════════════════════════════════════")

    # ── 1) pull --rebase أولاً (درس جولة الـ push)
    if not local_test:
        rc, out = git(["rev-parse", "--is-inside-work-tree"], repo)
        if rc != 0:
            die("ماشي في ريبو git؟ حط السكربت في جذر DRPS\\backend")
        rc, out = git(["pull", "origin", "main", "--rebase"], repo)
        print(out.strip())
        if rc != 0:
            die("pull --rebase فشل — غالباً عندك تعديلات محلية ما تدمجتش.\n"
                "   حفظها (git stash) ولا اعمل commit، وعاود شغّل السكربت.")
        ok("pull --rebase — الريبو محدّث")

    # ── 2) قراءة الملف + كشف نمط الأسطر (LF ولا CRLF)
    raw = open(server, "rb").read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        die("server.js ماشي UTF-8 — ما نمسوش يدوياً")
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    nl = "\r\n" if crlf > lf else "\n"
    print("   الأسطر: LF=%d CRLF=%d → نستعملو %s" % (lf, crlf, "CRLF" if nl == "\r\n" else "LF"))

    # ── 3) الحارسات
    if MARK in text:
        ok("الباتش مطبق من قبل — ما كاين ما يترجع (idempotent)")
        if not local_test:
            print("   حاجة للـ push؟ شوف git status.")
        return
    if text.count(ANCHOR) != 1:
        die("أنكور runSourcingWatch موجود %d مرة (نتوقع 1) — النسخة تبدلت؟ جبد تحديث ويكيلي" % text.count(ANCHOR))

    # ── 4) الجراحة
    pos = text.index(ANCHOR)
    line_end = text.index("\n", pos)
    if text[line_end - 1] == "\r":
        line_end -= 1  # نحقن قبل الـ \r
    block = nl.join(DDL_BLOCK)
    new_text = text[:line_end] + block + text[line_end:]
    if new_text.count(MARK) != 1:
        die("تحقق مايز فبلاصتو — ما سجلش")
    creates = new_text.count("CREATE TABLE IF NOT EXISTS cj_sourcing_requests")
    if creates != CREATE_COUNT_EXPECTED:
        die("CREATE TABLE cj_sourcing_requests = %d (نتوقع %d) — ما سجلش" % (creates, CREATE_COUNT_EXPECTED))
    open(server, "wb").write(new_text.encode("utf-8"))
    ok("الباتش تحقن — CREATE TABLE cj_sourcing_requests = %d مواضع (الراوت + الكرون)" % creates)

    # ── 5) فحص الصياغة (اختياري — node إذا موجود)
    node = shutil.which("node")
    if node:
        r = subprocess.run([node, "--check", "server.js"], cwd=repo, capture_output=True, text=True)
        if r.returncode != 0:
            open(server, "wb").write(raw)  # رجّع الأصل
            die("node --check فشل — رجعنا server.js لأصله:\n" + (r.stderr or "")[:600])
        ok("node --check ✓ — الصياغة سليمة")
    else:
        print("⚠️ node ماكانش فالـ PATH — نقزناه (الحارس تاع الـ push يعاود الفحص)")

    if local_test:
        ok("LOCAL TEST كمل — ماعندناش git هنا")
        return

    # ── 6) commit + push (الحارس يخدم تلقائياً قبل الـ push)
    rc, out = git(["add", "server.js"], repo)
    rc, out = git(["commit", "-m",
                   "fix: F#54 ensure cj_sourcing_requests table in SourcingWatch cron (Sentry SERVER-R)"], repo)
    print(out.strip() or "(commit)")
    if rc != 0:
        print("ℹ️ commit ما تمش (يمكن ما كاينش تغيير بعد pull) — نكملو للـ push")
    rc, out = git(["push", "origin", "main"], repo)
    print(out.strip())
    if rc != 0:
        die("الـ push ما مشاش — اقرا الرسالة فوق (الحارس ولا الرفض — الحل: عاود شغل السكربت)")

    print("")
    ok("دفع ✅ — الحارس قبّل")
    print(" ▸ الخطوة الأخيرة: Render → Manual Deploy (باش الديبلوي ياخد الإصلاح)")
    print(" ▸ بعد النشر: أول كرون 04:30/16:30 يضمن الجدول — SERVER-R يطيح وحدو")

if __name__ == "__main__":
    main()
