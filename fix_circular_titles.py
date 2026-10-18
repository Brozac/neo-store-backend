#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LACLARC CIRCULAR TITLE FIXER
============================
كيصلح العناوين اللي خرجات "دائرية" من بعد الـ de-dup — يعني اسم الأب = اسم القسم:

  ❌ "Shop Wedding & Engagement in Wedding & Engagement — Laclarc"

السكريبت كيطلع فسلسلة الأب/الجدّ (parent_id) حتى يلقى أول اسم مختلف، ومن بعد:

  ✅ "Shop Wedding & Engagement in {الجدّ المختلف} — Laclarc"

• REPORT افتراضي (ما كيبدل والو) · --fix كيطبق فـ transaction
• كيتحقق من التفرد ضد القاعدة كاملة (collision set)
• من بعد التحديث كيعاود يتحقق: بقا تكرار ولا دائرية → ROLLBACK كامل
• idempotent · psycopg3 / psycopg2 · UTF-8 guard للويندوز

Usage:
  python fix_circular_titles.py "postgresql://user:pass@host/db?sslmode=require"
  python fix_circular_titles.py "postgresql://..." --fix
"""

import sys, re, json, argparse
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

END_PAT = re.compile(r" in (.+?) (?:— Laclarc|\| Laclarc)$")


def die(msg, code=1):
    print(f"\n❌ {msg}")
    sys.exit(code)


def connect(url):
    try:
        import psycopg
        c = psycopg.connect(url)
        c.autocommit = True
        return c, "psycopg3"
    except ImportError:
        pass
    try:
        import psycopg2
        c = psycopg2.connect(url)
        c.autocommit = True
        return c, "psycopg2"
    except ImportError:
        die('نصب الدرايفر: pip install "psycopg[binary]"  (ولا psycopg2-binary)')


def qi(n):
    return '"' + str(n).replace('"', '""') + '"'


def circular_in(value, name):
    """العنوان فيه ' in {name} — Laclarc' و{name} هو اسم القسم نفسه → دائري"""
    if not value or not name:
        return False
    m = END_PAT.search(value.strip())
    return bool(m) and m.group(1).strip() == name.strip()


def first_diff_ancestor(by_id, parent_id, own_name, max_depth=10):
    """أول اسم أسلاف مختلف على الاسم ديال القسم (كنطلع: أب → جدّ → ...)"""
    seen, pid, depth = set(), parent_id, 0
    while pid is not None and pid in by_id and depth < max_depth:
        if pid in seen:
            break
        seen.add(pid)
        nm = (by_id[pid].get("name") or "").strip()
        if nm and nm != (own_name or "").strip():
            return nm
        pid = by_id[pid].get("parent")
        depth += 1
    return None


def choose(cands, collision, max_len):
    for c in cands:
        c = re.sub(r"\s+", " ", c).strip()
        if len(c) <= max_len and c not in collision:
            return c
    return None


def analyze(rows, max_len=60):
    """pure: rows=[{id,slug,name,parent,title,h1}] → plans"""
    by_id = {r["id"]: r for r in rows}
    plans = []
    for kind in ("title", "h1"):
        circ = [r for r in rows if r.get(kind) and circular_in(r[kind], r["name"])]
        if not circ:
            continue
        all_vals = {r[kind] for r in rows if r.get(kind)}
        collision = all_vals - {r[kind] for r in circ}
        for r in circ:
            ANC = first_diff_ancestor(by_id, r["parent"], r["name"])
            if ANC:
                if kind == "title":
                    cands = [f"Shop {r['name']} in {ANC} — Laclarc",
                             f"Shop {r['name']} — {ANC} | Laclarc",
                             f"{r['name']} — {ANC} | Laclarc",
                             f"{r['name']} | {ANC} | Laclarc"]
                else:
                    cands = [f"{r['name']} in {ANC} — Laclarc",
                             f"{r['name']} — {ANC} | Laclarc",
                             f"{r['name']} | {ANC} | Laclarc"]
            else:
                cands = [f"Shop {r['name']} Collection — Laclarc",
                         f"{r['name']} Collection | Laclarc"]
            chosen = choose(cands, collision, max_len)
            i = 2
            while chosen is None:
                base = re.sub(r"\s+", " ", cands[-1]).strip()
                cand = f"{base} #{i}"
                if len(cand) <= max_len + 8 and cand not in collision:
                    chosen = cand
                    break
                i += 1
                if i > 20:
                    die("ما قدرناش نصاوبو عنوان فريد — جرب --max-len أكبر")
            collision.add(chosen)
            plans.append({"kind": kind, "id": r["id"], "slug": r["slug"],
                          "old": r[kind], "new": chosen,
                          "ancestor": ANC or "(ما كاينش — Collection)"})
    return plans


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db_url")
    ap.add_argument("--fix", action="store_true", help="طبق (بدونها = report فقط)")
    ap.add_argument("--table", default="categories")
    ap.add_argument("--pk", default="id")
    ap.add_argument("--parent-col", default="parent_id")
    ap.add_argument("--title-col", default="seo_title")
    ap.add_argument("--h1-col", default="seo_h1")
    ap.add_argument("--name-col", default="name")
    ap.add_argument("--slug-col", default="slug")
    ap.add_argument("--max-len", type=int, default=60)
    args = ap.parse_args()

    print("🔁 LACLARC CIRCULAR TITLE FIXER")
    print("=" * 50)

    conn, driver = connect(args.db_url)
    print(f"🔌 متصل ({driver})")
    cur = conn.cursor()

    T, PK, PC = args.table, args.pk, args.parent_col
    cols = {"title": args.title_col, "h1": args.h1_col}

    cur.execute(f"SELECT {qi(PK)}, {qi(args.slug_col)}, {qi(args.name_col)}, {qi(PC)}, "
                f"{qi(args.title_col)}, {qi(args.h1_col)} FROM {qi(T)}")
    rows = []
    for pid, slug, name, parent, title, h1 in cur.fetchall():
        rows.append({"id": pid, "slug": slug or "", "name": (name or "").strip(),
                     "parent": parent, "title": title, "h1": h1})
    print(f"🌳 {args.table}: {len(rows)} سطر")

    plans = analyze(rows, args.max_len)
    print(f"\n📊 مجموع التصحيحات المخططة: {len(plans)}")
    for p in plans:
        print(f"  [{p['kind']}] {p['slug']} (pk={p['id']})")
        print(f"     ❌ {p['old']}")
        print(f"     ✅ {p['new']}  ({len(p['new'])} حرف) — الأسلاف: {p['ancestor']}")

    report = {"run_at": datetime.now(timezone.utc).isoformat(),
              "table": T, "driver": driver,
              "mode": "fix" if args.fix else "report",
              "planned": len(plans), "changes": plans}

    if not plans:
        print("\n✅ ما كاين حتى عنوان دائري — كولشي نظيف!")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    if not args.fix:
        print("\n👁  وضع REPORT — ما تبدل والو. زيد --fix باش تطبق.")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    print("\n🚀 تطبيق التصحيحات...")
    try:
        conn.autocommit = False
        cur2 = conn.cursor()
        for p in plans:
            cur2.execute(f"UPDATE {qi(T)} SET {qi(cols[p['kind']])} = %s "
                         f"WHERE {qi(PK)} = %s", (p["new"], p["id"]))
        # ---- إعادة التحقق: تكرارات + دائرية ---------------------------------
        dup_total, circ_total = 0, 0
        fresh_rows = []
        cur3 = conn.cursor()
        cur3.execute(f"SELECT {qi(args.name_col)}, {qi(args.title_col)}, {qi(args.h1_col)} FROM {qi(T)}")
        for nm, t, h in cur3.fetchall():
            fresh_rows.append({"name": (nm or "").strip(), "title": t, "h1": h})
        for kind in ("title", "h1"):
            vals = [r[kind] for r in fresh_rows if r.get(kind)]
            dup_total += len(vals) - len(set(vals))
            circ_total += sum(1 for r in fresh_rows if circular_in(r.get(kind), r["name"]))
        if dup_total > 0 or circ_total > 0:
            conn.rollback()
            die(f"من بعد التحديث: {dup_total} تكرارات + {circ_total} دائرية → ROLLBACK. حتى ما تبدل والو.")
        conn.commit()
        conn.autocommit = True
        print(f"✅ تثبت: 0 تكرارات · 0 دائرية | {len(plans)} عنوان تبدل | COMMIT")
    except SystemExit:
        raise
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        die(f"خطأ فالتطبيق → ROLLBACK: {e}")

    report["fixed"] = len(plans)
    report["verify"] = {"duplicates": 0, "circular": 0}
    print("\n" + json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
