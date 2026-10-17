#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# check_task16b_live.py — مُشخِّص Task 16-b (قراءة فقط + probe حي + git state)
#
# السؤال اللي كيجاوب عليه:
#   علاش curl /__sentry_test كيرجع {"error":"Route not found"}؟
#
# الأسباب المحتملة (فحصهم كامل أوتوماتيكي):
#   L1  الحوتفيكس مازال ما تبدلش (commit/push ناقص) → السيرفر الحي = نسخة قديمة
#   L2  Deploy مازال فالـ progress (خاص 2-5 دقايق من بعد push)
#   L3  Deploy فشل (شوف Render Events/Logs)
#   L4  ⚠️ باغ الترتيب: بلوك [LACLARC::SENTRY-TEST] تحقن فآخر الملف (fallback
#       ديال find_listen — WARN=2 فتقرير 16-b) وإلا كان فserver.js catch-all
#       ديال 404 قبلو → الروت كيتسجل من بعدو → عمرو ما غادي يطابق حتى من بعد
#       deploy ناجح → "Route not found" للأبد
#
# ما كيدير:
#   [1] FILE   — server.js موجود؟ v2 marker؟ بلوك SENTRY-TEST؟
#   [2] ORDER  — فين كاين الروت بالنسبة لأول catch-all عالمي ديال 404
#   [3] GIT    — commit تدار؟ pushed؟ HEAD فيه v2؟ شحال من دقيقة من بعد الـ push
#   [4] PROBE  — GET حي على {url}/__sentry_test (حساب الحالة الحقيقية)
#   [5] VERDICT— التشخيص المجمع + الخطوة الجديدة بالضبط
#
# --fix (اختياري): إلا كان L4 متحقق — كيحرك بلوك SENTRY-TEST لبلاصة مضمونة:
#   آخر marker ديال Sentry كيكون بعد تعريف const app = express() (يفضّل
#   [/LACLARC::SENTRY-REQ])، وإلا مباشرة بعد تعريف app. الحارس ضد TDZ:
#   الروت كيتسجل أعلى المستوى وكيرجع لـ app → خاصو يكون معرف قبل البلاصة
#   الجديدة (node --check ما كيلاقطش TDZ — درس 16-c). ضمانات العائلة:
#   backup timestamped · node --check قبل/بعد · rollback بايت-ببايت عند الفشل.
#
# قراءة فقط فالوضع العادي — حتى بايت ما كتبدل بلا --fix.
# ═══════════════════════════════════════════════════════════════════════════
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MARK_V2 = "[LACLARC::SENTRY-REQ] v2 (Task 16-b hotfix)"
M_TEST_OPEN = "[LACLARC::SENTRY-TEST]"
M_TEST_CLOSE = "[/LACLARC::SENTRY-TEST]"
M_REQ_CLOSE = "[/LACLARC::SENTRY-REQ]"
M_INIT_CLOSE = "[/LACLARC::SENTRY-INIT]"

# أدلة على catch-all عالمي (ماشي 404 ديال route معين)
EVIDENCE_PAT = re.compile(r"Route not found|status\(404\)|sendStatus\(404\)")
# بداية statement ديال wildcard: app.all('*') / app.get('/*') / app.use('*') ...
WILDCARD_PAT = re.compile(
    r"^\s*app\s*\.\s*(all|get|use|post)\s*\(\s*['\"]/?\*[^'\"]*['\"]"
)
# app declaration — TDZ guard (the route registers app.get() at module top-level,
# so `app` MUST already be declared above the insertion point; node --check does
# NOT catch TDZ — same class as the 16-c incident)
APP_DECL_PAT = re.compile(
    r"^\s*(?:(?:const|let|var)\s+)?app\s*=\s*express\s*\("
)
# app.use بلا مسار كأول وسيط (middleware عالمي): app.use((req...) / app.use(fn)
GLOBAL_USE_PAT = re.compile(r"^\s*app\s*\.\s*use\s*\(\s*[^'\"\d]")

PH = "CHECK"


def row(status, label, detail=""):
    print(f"  [{status}] {label:<24} {detail}")


def find_server(explicit):
    candidates = []
    if explicit:
        if os.path.isfile(explicit):
            candidates.append(explicit)          # مسار ملف كامل
        else:
            explicit = explicit.rstrip("/\\")
            candidates.append(os.path.join(explicit, "server.js"))
    candidates += [
        os.path.join("backend", "server.js"),
        "server.js",
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


def node_check(path):
    try:
        p = subprocess.run(
            ["node", "--check", path],
            capture_output=True, text=True, timeout=60,
        )
        if p.returncode == 0:
            return True, ""
        return False, (p.stderr or p.stdout or "").strip().splitlines()
    except FileNotFoundError:
        return None, "node ما كاينش فالـ PATH (نكملو بلا فحص)"
    except subprocess.TimeoutExpired:
        return False, "node --check timeout"


# ───────────────────────────── [2] ORDER ─────────────────────────────
def statement_start(lines, idx, window=40):
    """من سطر evidence، طل لفوق حتى لبداية الـ statement (app./router.)."""
    lo = max(0, idx - window)
    for i in range(idx, lo - 1, -1):
        s = lines[i].strip()
        if re.match(r"^(app|router)\s*\.\s*\w+\s*\(", s):
            return i
    return idx  # ما لقيناش — نرجعو evidence بحد ذاتو (مع حالة شك)


def is_global_catchall(lines, start):
    """واش الـ statement اللي كيبدا فstart هو catch-all عالمي ديال 404؟"""
    s = lines[start].strip()
    # (أ) wildcard path: app.all('*') / app.get('/*') ...
    if WILDCARD_PAT.match(lines[start]):
        return True
    # (ب) app.use بلا مسار + الجسم فيه 404 evidence (نافذة 15 سطر)
    if GLOBAL_USE_PAT.match(lines[start]) and not re.match(
        r"^\s*app\s*\.\s*use\s*\(\s*['\"]", lines[start]
    ):
        body = "\n".join(lines[start:start + 15])
        if EVIDENCE_PAT.search(body):
            return True
    # (ج) سطر واحد فيه كولشي: app.use((req,res)=>res.status(404)...)
    if re.match(r"^\s*app\s*\.\s*use\s*\(", lines[start]) and EVIDENCE_PAT.search(s):
        return True
    return False


def scan_order(text):
    """> (route_line, boundary_line|None, notes) — 0-based. route_line داخل server.js"""
    lines = text.splitlines()
    route_line = None
    for i, ln in enumerate(lines):
        if "__sentry_test" in ln and "app.get" in ln:
            route_line = i
            break
    notes = []
    boundary = None
    # المرور من الفوق للتحت: أول catch-all عالمي هو اللي كيبلع
    for i, ln in enumerate(lines):
        s = ln.strip()
        cand = None
        if WILDCARD_PAT.match(ln) or (
            re.match(r"^\s*app\s*\.\s*use\s*\(\s*\(", ln)
        ) or (re.match(r"^\s*app\s*\.\s*use\s*\(\s*(req|function|\w+)\s*[),]", ln)):
            if is_global_catchall(lines, i):
                cand = i
        if cand is not None:
            boundary = cand
            break
    # fallback: literal 'Route not found' مباشرة (أقوى دليل)
    if boundary is None:
        for i, ln in enumerate(lines):
            if "Route not found" in ln:
                st = statement_start(lines, i)
                if is_global_catchall(lines, st):
                    boundary = st
                    notes.append(f"literal 'Route not found' فسطر {i+1} → statement من {st+1}")
                    break
    return route_line, boundary, notes


def scan_other_files(backend_dir):
    """'Route not found' فملفات .js أخرى فbackend (routes/ إلخ) — بلا node_modules"""
    hits = []
    for root, dirs, files in os.walk(backend_dir):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "dist", "build")]
        for fn in files:
            if not fn.endswith(".js"):
                continue
            fp = os.path.join(root, fn)
            try:
                with open(fp, "r", encoding="utf-8", errors="replace") as f:
                    for n, ln in enumerate(f, 1):
                        if "Route not found" in ln:
                            hits.append(f"{fp}:{n}")
            except OSError:
                continue
    return hits[:8]


# ───────────────────────────── [3] GIT ─────────────────────────────
def git(args, cwd):
    try:
        p = subprocess.run(
            ["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=30
        )
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except FileNotFoundError:
        return None, "", "git ما كاينش"
    except subprocess.TimeoutExpired:
        return 1, "", "git timeout"


def git_section(server_path):
    """> dict معلومات git (ولا None إلا ما كاينش repo)"""
    d = os.path.dirname(server_path) or "."
    rc, top, _ = git(["rev-parse", "--show-toplevel"], d)
    if rc != 0:
        return None
    info = {"toplevel": top}
    rel = os.path.relpath(server_path, top).replace(os.sep, "/")
    info["rel"] = rel

    rc, out, _ = git(["rev-parse", "--abbrev-ref", "HEAD"], top)
    info["branch"] = out if rc == 0 else "?"

    rc, out, _ = git(["log", "--oneline", "-3"], top)
    info["log"] = out.splitlines() if rc == 0 else []

    rc, out, _ = git(["status", "-sb"], top)
    info["dirty"] = len(out.splitlines()) > 1

    # ahead: ما نعتمدوش على status -sb (كيسكت بلا upstream tracking) —
    # كنفحصو upstream صراحة، وإلا origin/<branch> مباشرة
    upstream = None
    rc, out, _ = git(["rev-parse", "--abbrev-ref", "HEAD@{upstream}"], top)
    if rc == 0 and out.strip():
        upstream = out.strip()
    else:
        rc, out, _ = git(
            ["rev-parse", "-q", "--verify", f"origin/{info['branch']}"], top
        )
        if rc == 0 and out.strip():
            upstream = f"origin/{info['branch']}"
    info["upstream"] = upstream
    info["ahead"] = 0
    info["ahead_unknown"] = upstream is None
    if upstream:
        rc, out, _ = git(["rev-list", "--count", f"{upstream}..HEAD"], top)
        if rc == 0 and out.strip().isdigit():
            info["ahead"] = int(out.strip())

    # واش HEAD فيه v2 marker فملف السيرفر؟
    rc, out, _ = git(["show", f"HEAD:{rel}"], top)
    info["head_has_v2"] = (rc == 0 and MARK_V2 in out)
    info["head_has_route"] = (rc == 0 and "__sentry_test" in out)

    # آخر commit للميتس ديال server.js — شحال من دقيقة من بعد
    rc, out, _ = git(["log", "-1", "--format=%ct", "--", rel], top)
    if rc == 0 and out.isdigit():
        info["last_touch_sec"] = max(0, int(time.time() - int(out)))
    else:
        info["last_touch_sec"] = None
    return info


# ───────────────────────────── [4] PROBE ─────────────────────────────
def probe(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": "laclarc-check/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(400).decode("utf-8", errors="replace")
            return r.status, body
    except urllib.error.HTTPError as e:
        try:
            body = e.read(400).decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return e.code, body
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


# ───────────────────────────── --FIX ─────────────────────────────
def fix_move(server_path, text, yes=False):
    """Move SENTRY-TEST block to a guaranteed-safe position (TDZ guard).

    Anchor priority: the LAST Sentry marker ([/LACLARC::SENTRY-REQ] or
    [/LACLARC::SENTRY-INIT]) that sits AFTER the `app = express()` declaration
    — otherwise right after that declaration line. The route registers
    app.get() at module top-level, so `app` MUST already be declared above the
    insertion point (node --check does NOT catch TDZ — lesson 16-c).
    """
    lines = text.splitlines(keepends=True)
    open_i = close_i = None
    req_close_i = init_close_i = None
    for i, ln in enumerate(lines):
        if M_TEST_OPEN in ln and M_TEST_CLOSE not in ln and open_i is None:
            open_i = i
        if M_TEST_CLOSE in ln and open_i is not None and close_i is None and i > open_i:
            close_i = i
        if M_REQ_CLOSE in ln and req_close_i is None:
            req_close_i = i
        if M_INIT_CLOSE in ln and init_close_i is None:
            init_close_i = i
    if open_i is None or close_i is None:
        print("  ✗ بلوك [LACLARC::SENTRY-TEST] ما كاملش (open/close ناقصين) — ما نقدرش نحرك")
        return False

    # ── حارس TDZ: تعريف app قبل البلاصة الجديدة إجباري ──
    app_i = None
    for i, ln in enumerate(lines):
        if APP_DECL_PAT.match(ln):
            app_i = i
            break
    if app_i is None:
        print("  ✗ ما لقيتش سطر const app = express() — ما نقدرش نضمن بلي الروت")
        print("    غادي يتسجل من بعد تعريف app (خطر TDZ/crash). ما نكملش بلا تأكيد.")
        print("    → صيفط ليا أول 40 سطر من server.js ونضبط الـ anchor يدوياً")
        return False

    # ── anchor = آخر marker صالح بعد تعريف app وقبل البلوق؛ وإلا سطر تعريف app ──
    candidates = [
        c for c in (req_close_i, init_close_i)
        if c is not None and app_i < c < open_i
    ]
    if candidates:
        anchor_i = max(candidates)
        anchor_kind = ("[/LACLARC::SENTRY-REQ]" if anchor_i == req_close_i
                       else "[/LACLARC::SENTRY-INIT]")
    else:
        anchor_i = app_i
        anchor_kind = "app-decl"
    if anchor_i >= open_i:
        print("  ✗ الـ anchor كاين بعد البلوق؟ بنية غير متوقعة — ما نكملش")
        return False

    block = lines[open_i:close_i + 1]
    # تنظيف تجميلي: سطر فارغ زايد قبل البلوق القديم
    rest = lines[:open_i] + lines[close_i + 1:]
    if open_i > 0 and rest[open_i - 1].strip() == "" and open_i < len(rest) and rest[open_i].strip() == "":
        del rest[open_i - 1]

    # مكان الـ anchor الجديد من بعد الحذف (anchor قبل open دائماً → ما تبدلش)
    new_anchor = anchor_i
    while new_anchor + 1 < len(rest) and rest[new_anchor + 1].strip() == "":
        new_anchor += 1  # نلصقو من بعد الفراغات الموجودة
    new_lines = rest[:new_anchor + 1] + ["\n"] + block + rest[new_anchor + 1:]
    new_text = "".join(new_lines)

    ok, info = node_check(server_path)
    if ok is False and not yes:
        print("  ✗ الملف الحالي مخرب سينتاكسياً — ما نكملش (دير --yes باش تكسر القاعدة)")
        return False

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = f"{server_path}.bak-sentrymove-{ts}"
    with open(bak, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    row("OK", "backup", bak)

    with open(server_path, "w", encoding="utf-8", newline="") as f:
        f.write(new_text)
    row("OK", "move block", f"سطر {open_i+1} → بعد {anchor_kind} (سطر {anchor_i+1}) — app معرف قبلو ✓")

    ok2, info2 = node_check(server_path)
    if ok2 is False:
        with open(server_path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        row("FAIL", "node --check (بعد)", "rollback أوتوماتيكي — الملف رجع بحالو بالبايت")
        for line in (info2 if isinstance(info2, list) else [info2])[:6]:
            print("      " + str(line))
        return False
    row("OK", "node --check (بعد)", "السينتاكس سليم ✓" if ok2 is True else str(info2))
    return True


# ───────────────────────────── MAIN ─────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Task 16-b live checker (قراءة فقط + --fix)")
    ap.add_argument("--backend", help="مجلد الباكند ولا المسار الكامل لـ server.js")
    ap.add_argument("--url", default="https://neo-store-backend.onrender.com",
                    help="قاعدة URL ديال الباكند فRender")
    ap.add_argument("--no-probe", action="store_true", help="تجاهل الفحص الحي")
    ap.add_argument("--fix", action="store_true", help="حرك بلوك SENTRY-TEST فوق الـ catch-alls")
    ap.add_argument("--yes", action="store_true", help="مع --fix: سير بلا أسئلة")
    args = ap.parse_args()

    print("═" * 68)
    print("  check_task16b_live.py — تشخيص 'Route not found' ديال /__sentry_test")
    print("═" * 68)

    target = find_server(args.backend)
    if not target:
        print("  ✗ ما لقيتش server.js — دير --backend <path>")
        sys.exit(1)
    print(f"  الهدف: {target}")

    with open(target, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    needs_fix = False
    action = None

    # ── [1] FILE
    print("  ── [1] FILE ──")
    has_v2 = MARK_V2 in text
    has_test = M_TEST_OPEN in text and M_TEST_CLOSE in text
    has_route = "__sentry_test" in text
    row("OK" if has_v2 else "FAIL", "SENTRY-REQ v2",
        "موجود ✓" if has_v2 else "مازال v1! — جري fix_task16b_sentryreq.py أولاً")
    row("OK" if has_route else "FAIL", "روت /__sentry_test",
        "موجود فالملف المحلي ✓" if has_route else "ما كاينش فالملف المحلي!")

    # ── [2] ORDER
    route_line, boundary, notes = scan_order(text)
    print("  ── [2] ORDER (الروت ضد أول catch-all عالمي ديال 404) ──")
    if not has_route:
        row("SKIP", "ترتيب", "ما كاينش روت — بلا معنى")
    elif boundary is None:
        row("OK", "ترتيب", "ما كاينش catch-all عالمي فserver.js — الروت حر ✓")
        other = scan_other_files(os.path.dirname(target) or ".")
        if other:
            row("INFO", "فملفات أخرى", "'Route not found' كاين حتى ف:")
            for h in other:
                print("        " + h)
    else:
        rl, bl = (route_line + 1) if route_line is not None else -1, boundary + 1
        for n in notes:
            row("INFO", "دليل", n)
        if route_line is not None and route_line < boundary:
            row("OK", "ترتيب", f"الروت (سطر {rl}) قبل الـ catch-all (سطر {bl}) ✓")
        elif route_line is not None:
            row("FAIL", "ترتيب ⚠️",
                f"الروت (سطر {rl}) كيتسجل من بعد الـ catch-all (سطر {bl}) — روت ميت!")
            print("        → حتى من بعد deploy ناجح، أي request غادي يبلعو الـ catch-all")
            print("        → الحل: --fix كيحرك الروت لتحت [/LACLARC::SENTRY-REQ] مباشرة")
            needs_fix = True
            action = "fix"

    # ── [3] GIT
    print("  ── [3] GIT ──")
    g = git_section(target)
    if g is None:
        row("WARN", "git", "ما لقيتش repo من هاد الملف — تجاهل هاد القسم")
        pushed_min = None
    else:
        for c in g["log"]:
            print("        " + c)
        row("INFO", "branch", g["branch"] + ("  (تغييرات غير محفوظة!)" if g["dirty"] else ""))
        row("OK" if g["head_has_v2"] else "WARN", "HEAD فيه v2؟",
            "أيه ✓" if g["head_has_v2"] else "لا — الحوتفيكس مازال ما commitاش")
        if g.get("ahead_unknown"):
            row("WARN", "push", "ما كاينش upstream/origin محلي — ما نقدرش نأكد واش pushed")
            action = action or "push-unknown"
        elif g["ahead"] > 0:
            row("FAIL", "push", f"عندك {g['ahead']} commit محلي ما مشاش لـ origin — دير git push")
            action = "push"
        elif g["dirty"]:
            row("FAIL", "push", "الملفات تبدلو لكن مازال ما commitاش — دير git add -A && git commit")
            action = "commit"
        elif g["head_has_v2"]:
            row("OK", "push", "كولشي pushed ✓")
        mins = g.get("last_touch_sec")
        pushed_min = (mins // 60) if mins is not None else None
        if pushed_min is not None and g.get("head_has_v2"):
            row("INFO", "عمر آخر commit", f"{pushed_min} دقيقة هادي")

    # ── [4] PROBE
    print("  ── [4] PROBE (حي) ──")
    live = None
    if args.no_probe:
        row("SKIP", "probe", "--no-probe مفعّل")
    else:
        url = args.url.rstrip("/") + "/__sentry_test"
        print(f"        GET {url}")
        code, body = probe(url)
        if code is None:
            row("WARN", "probe", body[:120] + " — cold start ديال Render؟ (مجاني كينعس) — عاود من بعد دقيقة")
        else:
            live = code
            snippet = " ".join(body.split())[:150]
            if code == 200 and "LACLARC-SENTRY-OK" in body:
                row("OK", "probe 200", "🎉 الروت حي: " + snippet)
            elif code == 404:
                row("FAIL", "probe 404", snippet)
            else:
                row("WARN", f"probe {code}", snippet)

    # ── [5] VERDICT
    print("═" * 68)
    if live == 200:
        print("  ✅ الحالة: الحوتفيكس حي فالإنتاج. من بعد DSN فRender: ?go=1 → dashboard ≤60s")
    elif needs_fix:
        print("  ⚠️ التشخيص: الروت كيتسجل من بعد الـ catch-all ديال 404 (باغ ترتيب L4).")
        print("     حتى إلا دخلت push، السيرفر الجديد غادي يرجع نفس 'Route not found'.")
        if args.fix:
            print("  ── تنفيذ --fix ──")
            okf = fix_move(target, text, yes=args.yes)
            if okf:
                print("═" * 68)
                print("  ✅ تحرك. دابا:")
                print("     1) git add -A && git commit -m 'task16b: move /__sentry_test above 404 catch-all'")
                print("     2) git push  →  تسنى 'Deploy live' فRender (2-5 دق)")
                print("     3) عاود: python check_task16b_live.py  (متوقع probe 200)")
            sys.exit(0 if okf else 1)
        print("     → جري: python check_task16b_live.py --fix")
        sys.exit(3)
    elif live == 404 or (live is None and action is None and has_v2):
        if action == "push":
            print("  ⚠️ التشخيص: commit موجود محلياً ولكن مازال ما pushedش → Render مازال عندو القديم.")
        elif pushed_min is not None and pushed_min < 7:
            print(f"  ⚠️ التشخيص: دفعتي {pushed_min} دقيقة هادي — Deploy مازال فالـ progress (2-5 دق).")
            print("     شوف Render → Events حتى تبان 'Deploy live' — من بعد عاود هاد السكريبت.")
        elif g is not None and g.get("head_has_v2") and not g.get("ahead") and not g.get("dirty"):
            print("  ⚠️ التشخيص: الكود pushed وv2 فHEAD ولكن الحي مازال 404.")
            print("     احتمالات: Deploy فشل (شوف Render → Events → Logs) ولا مازال فالبناء.")
            print("     إلا 'Deploy live' ومازال 404 → جري بـ --fix (الـ catch-all يمكن فملف آخر).")
        else:
            print("  ⚠️ التشخيص: الحوتفيكس مازال ما وصلش لـ Render (commit ولا push ناقص).")
        print("  ── الخطوات ──")
        print("     1) git add -A && git commit -m 'task16b: fix SENTRY-REQ v2 (TypeError)'")
        print("     2) git push")
        print("     3) Render → Events: تسنى 'Deploy live'")
        print("     4) عاود: python check_task16b_live.py")
        sys.exit(2)
    elif not has_v2:
        print("  ✗ الملف المحلي مازال فيه SENTRY-REQ v1 — جري fix_task16b_sentryreq.py أولاً")
        sys.exit(1)
    else:
        if action in ("commit", "push"):
            print("  ⚠️ الملف المحلي سليم — ولكن خاصو commit/push باش يوصل لRender:")
            print("     1) git add -A && git commit -m 'task16b: fix SENTRY-REQ v2 (TypeError)'")
            print("     2) git push  →  Render → Events → تسنى 'Deploy live'")
            print("     3) عاود: python check_task16b_live.py")
        else:
            print("  ✅ فالملف المحلي كولشي نقي — كمل النشر (push → Deploy live → probe)")
        sys.exit(0 if action is None else 2)


if __name__ == "__main__":
    main()