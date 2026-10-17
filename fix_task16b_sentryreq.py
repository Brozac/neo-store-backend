#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# fix_task16b_sentryreq.py — HOTFIX Task 16-b (حادثة إنتاج: Render deploy طاح)
#
# الخطأ:
#   TypeError: app.use() requires a middleware function  (server.js:73)
#
# الجذر (مثبت بالـ SDK الحقيقي @sentry/node 10.76.2):
#   بلوك [LACLARC::SENTRY-REQ] v1 كيدير:
#       app.use(Sentry.expressIntegration());
#   ولكن expressIntegration() فv8+/v10 كترجع integration OBJECT
#   ({name:'Express', setupOnce, getShouldHandleError}) ماشي middleware function.
#   الـ API الصحيح: Sentry.init({ integrations: [Sentry.expressIntegration()] })
#   Sentry.Handlers = undefined فv10 → الـ v7 fallback عمرو ما كيتشغل.
#   node --check كيدوز (سينتاكس سليم) — المشكل runtime فقط.
#
# الحل (v2):
#   · v8+/v10: حتى request middleware ما خاص — لمرحلة 1 (أخطاء فقط،
#     tracesSampleRate: 0) الـ setupExpressErrorHandler (بلوك SENTRY-ERR)
#     + httpIntegration (مفعّل by default) كيكفيان.
#   · v7 فقط: Sentry.Handlers.requestHandler() — كيرجع function حقيقي.
#
# الضمانات (نفس منهجية العائلة):
#   · backup قبل الكتابة: server.js.bak-task16b-<timestamp>
#   · node --check قبل/بعد — فشل بعد = rollback أوتوماتيكي بايت-ببايت
#   · Idempotent: marker [LACLARC::SENTRY-REQ] v2 → SKIP
#   · --dry-run / --yes / --backend
# ═══════════════════════════════════════════════════════════════════════════
import argparse
import datetime
import os
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MARK_V2 = "[LACLARC::SENTRY-REQ] v2 (Task 16-b hotfix)"

BLOCK_V2 = '''// ──── [LACLARC::SENTRY-REQ] v2 (Task 16-b hotfix) ────
// request context — v2: تصحيح باغ الإنتاج (TypeError: app.use() requires a middleware function)
//   الجذر (مثبت بالـ SDK الحقيقي 10.76.2): expressIntegration() كترجع integration object
//     { name, setupOnce, getShouldHandleError } ماشي middleware → app.use() كيرمي TypeError
//   بلاصتها الصحيحة فv8+: Sentry.init({ integrations: [Sentry.expressIntegration()] })
//   القرار لمرحلة 1 (أخطاء فقط · tracesSampleRate: 0):
//     · v8+/v10: حتى request middleware ما خاص — setupExpressErrorHandler (بلوك SENTRY-ERR)
//       + httpIntegration (مفعّل by default) كيكفيان لالتقاط الأخطاء مع سياق الطلب
//     · v7 فقط: Sentry.Handlers.requestHandler() — كيرجع middleware حقيقي (function)
if (Sentry.Handlers && typeof Sentry.Handlers.requestHandler === 'function') {
  app.use(Sentry.Handlers.requestHandler());     // v7 فقط — آمن: كيرجع function
}
// ──── [/LACLARC::SENTRY-REQ] ────
'''

# من سطر الفتح (فيه [LACLARC::SENTRY-REQ] بلا slash) حتى سطر الإغلاق [/LACLARC::SENTRY-REQ]
RE_BLOCK = re.compile(
    r'//[^\n]*\[LACLARC::SENTRY-REQ\][^\n]*\n.*?//[^\n]*\[/LACLARC::SENTRY-REQ\][^\n]*\n?',
    re.DOTALL,
)

PH = "HOTFIX"


def row(status, label, detail=""):
    print(f"  [{status}] {label:<22} {detail}")


def node_check(path):
    """node --check — سليم= True/errmsg"""
    try:
        p = subprocess.run(
            ["node", "--check", path],
            capture_output=True, text=True, timeout=60,
        )
        if p.returncode == 0:
            return True, ""
        return False, (p.stderr or p.stdout or "").strip().splitlines()
    except FileNotFoundError:
        return None, "node ما كاينش فالـ PATH"
    except subprocess.TimeoutExpired:
        return False, "node --check timeout"


def find_server(explicit):
    candidates = []
    if explicit:
        candidates.append(os.path.join(explicit, "server.js"))
        candidates.append(explicit if explicit.endswith("server.js") else os.path.join(explicit, "server.js"))
    candidates += [
        os.path.join("backend", "server.js"),
        "server.js",
        os.path.join("src", "server.js"),
        os.path.join("..", "backend", "server.js"),
    ]
    seen = set()
    for c in candidates:
        c2 = os.path.abspath(c)
        if c2 in seen:
            continue
        seen.add(c2)
        if os.path.isfile(c2):
            return c2
    return None


def main():
    ap = argparse.ArgumentParser(description="Task 16-b HOTFIX: SENTRY-REQ v1 → v2")
    ap.add_argument("--backend", help="مجلد الباكند (ولا المسار الكامل لـ server.js)")
    ap.add_argument("--dry-run", action="store_true", help="معاينة بلا كتابة")
    ap.add_argument("--yes", action="store_true", help="بلا سؤال تأكيد")
    ap.add_argument("--force", action="store_true", help="كمّل حتى إلا node --check قبل فاشل")
    args = ap.parse_args()

    print("═" * 68)
    print("  fix_task16b_sentryreq.py — HOTFIX 16-b: SENTRY-REQ v1 → v2")
    print("  (TypeError: app.use() requires a middleware function)")
    print("═" * 68)

    target = find_server(args.backend)
    if not target:
        print("  ✗ ما لقيتش server.js — دير --backend <path> صريح")
        sys.exit(1)
    print(f"  الهدف: {target}")

    with open(target, "r", encoding="utf-8") as f:
        old = f.read()

    # ── الحالة 1: مصلح من قبل
    if MARK_V2 in old:
        row("SKIP", "sentry-req v2", "الحوتفيكس داز من قبل — ما كاين ما يتبدل")
        print("═" * 68)
        sys.exit(0)

    # ── الحالة 2: بلوك v1 موجود؟
    matches = list(RE_BLOCK.finditer(old))
    if not matches:
        print("  ✗ ما لقيتش بلوك [LACLARC::SENTRY-REQ] v1 — إما الحاقن ما دازش")
        print("    ولا الملف تبدل بيدك. ما غاديش نلمس والو بلا توقيع مطابق.")
        sys.exit(1)
    if len(matches) > 1:
        print(f"  ✗ لقيت {len(matches)} بلوكات — أمانياً ما نكملش بلا تدخل يدوي")
        sys.exit(1)
    old_block = matches[0].group(0)

    # ── node --check قبل (المفروض يدوز: الباغ runtime ماشي syntax)
    ok, info = node_check(target)
    if ok is True:
        row("OK", "node --check (قبل)", "السينتاكس سليم (متوقع — الباغ runtime)")
    elif ok is None:
        row("WARN", "node --check (قبل)", f"{info} — مكملين بلا فحص")
    else:
        if not args.force:
            print(f"  ✗ الملف الحالي مخرب سينتاكسياً — ما نكملش (دير --force باش تكسر القاعدة):")
            for line in (info if isinstance(info, list) else [info])[:6]:
                print("      " + line)
            sys.exit(1)
        row("WARN", "node --check (قبل)", "فاشل — --force مفعّل، مكملين")

    # ── dry-run؟
    if args.dry_run:
        print("  ── DRY-RUN: حتى بايت ما غادي تكتب ──")
        print("  ── البلوك القديم (المقصوص):")
        for line in old_block.splitlines():
            print("    | " + line)
        print("  ── البلوك الجديد (v2):")
        for line in BLOCK_V2.rstrip().splitlines():
            print("    > " + line)
        print("═" * 68)
        sys.exit(0)

    # ── تأكيد
    if not args.yes:
        ans = input("  نكملو بالتعويض؟ (y/N): ").strip().lower()
        if ans not in ("y", "yes"):
            print("  ألغيت — ما تبدل والو")
            sys.exit(0)

    # ── backup
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = f"{target}.bak-task16b-{ts}"
    with open(bak, "w", encoding="utf-8", newline="") as f:
        f.write(old)
    row("OK", "backup", bak)

    # ── التعويض
    new = old[:matches[0].start()] + BLOCK_V2 + old[matches[0].end():]
    with open(target, "w", encoding="utf-8", newline="") as f:
        f.write(new)
    row("OK", "replace v1→v2", "البلوك تعوض — app.use(expressIntegration()) خرج نهائياً")

    # ── node --check بعد + rollback أوتوماتيكي
    ok, info = node_check(target)
    if ok is False:
        with open(target, "w", encoding="utf-8", newline="") as f:
            f.write(old)
        row("FAIL", "node --check (بعد)", "rollback أوتوماتيكي تدار — الملف رجع بحالو بالبايت")
        for line in (info if isinstance(info, list) else [info])[:6]:
            print("      " + line)
        sys.exit(1)
    elif ok is None:
        row("WARN", "node --check (بعد)", f"{info} — شوف الملف بيدك قبل push")
    else:
        row("OK", "node --check (بعد)", "السينتاكس سليم ✓")

    print("═" * 68)
    print("  ✅ الحوتفيكس داز. الخطوات: ")
    print("     1) git add -A && git commit -m 'task16b: fix SENTRY-REQ v2 (TypeError)'")
    print("     2) git push  →  Render كيعاود ينشر بوحدو")
    print("     3) من بعد ما يطلع: curl \"https://<host>/__sentry_test\" (بلا go=1)")
    print("        متوقع: {\"ok\":true,\"marker\":\"LACLARC-SENTRY-OK\",...} — السيرفر حي")
    print("     4) من بعد DSN فـ Render: curl \"...?go=1\" → الحدث فالـ dashboard ≤60s")
    print(f"  🗂️  backup: {bak}")
    print("═" * 68)


if __name__ == "__main__":
    main()
