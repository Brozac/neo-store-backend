#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LACLARC SEO TITLE DE-DUPLICATOR
================================
كيصلح العناوين المكررة (duplicate SEO titles / H1) فجدول الأقسام.

• كيكتاشف الجدول والأعمدة بوحدو (auto-discovery) — ما محتاج حتى تعديل
• الوضع الافتراضي: REPORT فقط (كيورر وش غادي يتبدل، ما كيبدل والو)
• --fix: كيطبق التصحيح فـ transaction واحدة + كيعاود يتحقق (بقا تكرار = rollback كامل)
• idempotent: تقدر تعاود تشغلو بلا خوف
• خدام مع psycopg (v3) ولا psycopg2 — اللي كاين عندك

Usage:
  python fix_duplicate_titles.py "postgresql://user:pass@host/db?sslmode=require"
  python fix_duplicate_titles.py "postgresql://..." --fix
  python fix_duplicate_titles.py "postgresql://..." --fix --max-len 62
"""

import sys, os, re, json, argparse
from datetime import datetime, timezone

# ---- Windows console UTF-8 guard -------------------------------------------
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MAXLEN_DEFAULT = 60
SMALL_WORDS = {"and", "or", "the", "for", "of", "in", "with", "to", "a", "an"}

TITLE_CANDS = ("seo_title", "seo_page_title", "meta_title", "page_title", "title")
SLUG_CANDS = ("slug", "category_slug", "cate_slug", "handle", "cate_handle")
H1_CANDS = ("seo_h1", "h1")
NAME_CANDS = ("name", "category_name", "cate_name", "label")
SEC_CANDS = ("section_slug", "section", "section_name", "l1_slug", "top_slug",
             "top_level_slug", "parent_slug", "root_slug", "department_slug", "department")
PARENT_FK_CANDS = ("parent_id", "parent_cid", "parent")


def die(msg, code=1):
    print(f"\n❌ {msg}")
    sys.exit(code)


def q(cur, sql, params=None):
    cur.execute(sql, params or ())
    return cur.fetchall()


def qi(name):
    return '"' + str(name).replace('"', '""') + '"'


def qt(name):
    return qi(name)


def connect(url):
    try:
        import psycopg  # v3
        conn = psycopg.connect(url)
        conn.autocommit = True
        return conn, "psycopg3"
    except ImportError:
        pass
    try:
        import psycopg2
        conn = psycopg2.connect(url)
        conn.autocommit = True
        return conn, "psycopg2"
    except ImportError:
        die("ما كاين لا psycopg لا psycopg2 — نصبو:\n  pip install \"psycopg[binary]\"\nولا:\n  pip install psycopg2-binary")


def humanize_slug(slug):
    """women-s-clothing → Women's Clothing | health-beauty-and-hair → Health Beauty and Hair"""
    if not slug:
        return slug
    words = [w for w in str(slug).strip().split("-") if w]
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        if lw == "s" and out:
            out[-1] = out[-1] + "'s"
            continue
        if lw in SMALL_WORDS and i > 0:
            out.append(lw)
        else:
            out.append(w[0].upper() + w[1:])
    return " ".join(out)


def looks_like_slug(v):
    return bool(v) and re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)+", str(v)) is not None


def discover_pk(cur, table):
    try:
        rows = q(cur, """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = %s
              AND tc.constraint_type = 'PRIMARY KEY'
            ORDER BY kcu.ordinal_position
        """, (table,))
        return rows[0][0] if rows else None
    except Exception:
        return None


def discover(cur, conn, args):
    cols_by_table = {}
    for tname, cname in q(cur, """
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
    """):
        cols_by_table.setdefault(tname, set()).add(cname)

    cands = []
    for t, cols in cols_by_table.items():
        tc = next((c for c in TITLE_CANDS if c in cols), None)
        sc = next((c for c in SLUG_CANDS if c in cols), None)
        if not (tc and sc):
            continue
        try:
            n = q(cur, f"SELECT count(*) FROM {qt(t)}")[0][0]
        except Exception:
            conn.rollback()
            continue
        if 100 <= n <= 5000:
            cands.append((abs(n - 681), t, tc, sc, n))

    if args.table:
        forced = [c for c in cands if c[1] == args.table]
        if not forced:
            die(f"الجدول '{args.table}' ما لقيناهوش ولا ما عندوش أعمدة title+slug.")
        cands = forced
    if not cands:
        die("ما لقيتش جدول الأقسام (جدول فيه title+slug وبين 100 و 5000 سطر).\n"
            "عطيني الجدول يدوياً: --table categories --title-col seo_title")

    cands.sort()
    _, table, title_col, slug_col, nrows = cands[0]
    cols = cols_by_table[table]
    h1_col = next((c for c in H1_CANDS if c in cols), None)
    name_col = next((c for c in NAME_CANDS if c in cols), None)
    pk = discover_pk(cur, table) or ("id" if "id" in cols else None)

    if args.title_col:
        title_col = args.title_col

    sec_col, sec_mode = None, None
    for c in SEC_CANDS:
        if c in cols and c != title_col:
            sec_col, sec_mode = c, "col"
            break
    if not sec_col and pk:
        for pcol in PARENT_FK_CANDS:
            if pcol in cols:
                try:
                    q(cur, f"SELECT 1 FROM {qt(table)} c JOIN {qt(table)} p "
                           f"ON p.{qi(pk)} = c.{qi(pcol)} LIMIT 1")
                    sec_col, sec_mode = pcol, "parent"
                    break
                except Exception:
                    conn.rollback()

    return {"table": table, "nrows": nrows, "title_col": title_col,
            "slug_col": slug_col, "h1_col": h1_col, "name_col": name_col,
            "pk": pk, "sec_col": sec_col, "sec_mode": sec_mode}


def fetch_rows(cur, d):
    """pk, slug, name, sec_display لكل سطر"""
    t, pk, slug_col = d["table"], d["pk"], d["slug_col"]
    name_sel = f"c.{qi(d['name_col'])}" if d["name_col"] else "NULL"
    if d["sec_mode"] == "col":
        sql = (f"SELECT c.{qi(pk)}, c.{qi(slug_col)}, {name_sel}, "
               f"c.{qi(d['sec_col'])} FROM {qt(t)} c")
        raw = q(cur, sql)
    elif d["sec_mode"] == "parent":
        pval = f"p.{qi(d['name_col'])}" if d["name_col"] else f"p.{qi(d['slug_col'])}"
        sql = (f"SELECT c.{qi(pk)}, c.{qi(slug_col)}, {name_sel}, {pval} "
               f"FROM {qt(t)} c LEFT JOIN {qt(t)} p ON p.{qi(d['pk'])} = c.{qi(d['sec_col'])}")
        raw = q(cur, sql)
    else:
        sql = f"SELECT c.{qi(pk)}, c.{qi(slug_col)}, {name_sel}, NULL FROM {qt(t)} c"
        raw = q(cur, sql)

    out = {}
    for pkv, slug, name, sec in raw:
        nm = (name or "").strip() or humanize_slug(slug)
        if sec and looks_like_slug(sec):
            sec = humanize_slug(sec)
        out[pkv] = {"slug": slug or "", "name": nm, "sec": (sec or "").strip() or None}
    return out


def dup_groups(cur, d, col):
    sql = (f"SELECT {qi(col)}, count(*) FROM {qt(d['table'])} "
           f"WHERE {qi(col)} IS NOT NULL GROUP BY 1 HAVING count(*) > 1 "
           f"ORDER BY count(*) DESC, 1")
    return q(cur, sql)


def slug_tail(slug):
    words = [w for w in str(slug).split("-") if w]
    if not words:
        return None
    tail = words[-1]
    if tail.lower() in SMALL_WORDS or len(tail) < 3:
        if len(words) >= 2:
            tail = words[-2] + " " + words[-1]
    return humanize_slug(tail.replace("-", " "))


def pick(cands, collision, maxlen):
    for c in cands:
        c = re.sub(r"\s+", " ", c).strip()
        if len(c) <= maxlen and c not in collision:
            return c
    return None


def new_value(kind, name, sec, tail, collision, maxlen):
    """kind='title' ولا 'h1' — كيجرر المرشحين وكيختار أول واحد ≤ maxlen ومامش مكرر"""
    if sec:
        if kind == "title":
            cands = [f"Shop {name} in {sec} — Laclarc",
                     f"Shop {name} — {sec} | Laclarc",
                     f"{name} — {sec} | Laclarc",
                     f"{name} | {sec} | Laclarc"]
        else:
            cands = [f"{name} in {sec} — Laclarc",
                     f"{name} — {sec} | Laclarc",
                     f"{name} | {sec} | Laclarc"]
    else:
        if kind == "title":
            cands = [f"Shop {name} ({tail}) Online — Laclarc",
                     f"Shop {name} — {tail} | Laclarc",
                     f"{name} ({tail}) | Laclarc"]
        else:
            cands = [f"{name} ({tail}) — Laclarc",
                     f"{name} — {tail} | Laclarc",
                     f"{name} | {tail} | Laclarc"]
    v = pick(cands, collision, maxlen)
    i = 2
    while v is None:  # ملجأ أخير: عداد باش يضمن التفرد
        v = pick([f"{cands[-1]} #{i}"], collision, maxlen + 8)
        i += 1
        if i > 20:
            die("ما قدرناش نصاوبو عنوان فريد — جرب --max-len أكبر")
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db_url")
    ap.add_argument("--fix", action="store_true", help="طبق التصحيح (بدون هاد الراية = report فقط)")
    ap.add_argument("--table", help="فرض اسم الجدول")
    ap.add_argument("--title-col", help="فرض عمود العنوان")
    ap.add_argument("--max-len", type=int, default=MAXLEN_DEFAULT)
    args = ap.parse_args()

    print("🛠  LACLARC SEO TITLE DE-DUPLICATOR")
    print("=" * 52)

    conn, driver = connect(args.db_url)
    print(f"🔌 متصل ({driver})")
    cur = conn.cursor()

    d = discover(cur, conn, args)
    print(f"🌳 الجدول: {d['table']} ({d['nrows']} سطر) | title={d['title_col']} "
          f"| h1={d['h1_col']} | name={d['name_col']} | pk={d['pk']}")
    print(f"🔗 مصدر القسم: {d['sec_col'] or '— (fallback: slug tail)'} ({d['sec_mode'] or 'none'})")

    rows = fetch_rows(cur, d)

    # ---- مجموعات مكررين لـ title + h1 ---------------------------------------
    plans = []
    for kind, col in (("title", d["title_col"]), ("h1", d["h1_col"])):
        if not col:
            continue
        collision_all = {r[0] for r in q(cur, f"SELECT {qi(col)} FROM {qt(d['table'])} WHERE {qi(col)} IS NOT NULL")}
        for val, cnt in dup_groups(cur, d, col):
            if d["pk"]:
                grp_pks = [g[0] for g in q(cur,
                    f"SELECT {qi(d['pk'])} FROM {qt(d['table'])} WHERE {qi(col)} = %s "
                    f"ORDER BY {qi(d['slug_col'])}", (val,))]
            else:
                grp_pks = [pkv for pkv, r in rows.items() if True]
            if len(grp_pks) < 2:
                continue
            collision = collision_all - {val}
            sec_available = all(rows[p]["sec"] for p in grp_pks if p in rows)
            targets = grp_pks if sec_available else grp_pks[1:]
            for pos, pkv in enumerate(targets, start=1):
                r = rows.get(pkv)
                if not r:
                    continue
                sec = r["sec"] if sec_available else None
                tail = slug_tail(r["slug"]) or f"Cat {pos}"
                nv = new_value(kind, r["name"], sec, tail, collision, args.max_len)
                if nv:
                    collision.add(nv)
                    plans.append({"kind": kind, "col": col, "pk": pkv,
                                  "slug": r["slug"], "old": val, "new": nv})

    # ---- تاكيد أن الخطة نفسها بلا تكرار -------------------------------------
    seen = set()
    unique_plans = []
    for p in plans:
        key = (p["col"], p["new"])
        if key in seen:
            continue
        seen.add(key)
        unique_plans.append(p)
    plans = unique_plans

    print(f"\n📊 مجموع التصحيحات المخططة: {len(plans)}")
    for p in plans:
        print(f"  [{p['kind']}] {p['slug']}")
        print(f"     - {p['old']}")
        print(f"     + {p['new']}  ({len(p['new'])} حرف)")

    report = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "table": d["table"], "driver": driver, "mode": "fix" if args.fix else "report",
        "planned": len(plans),
        "changes": plans,
    }

    if not plans:
        print("\n✅ ما كاين حتى تكرار — كولشي نظيف!")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    if not args.fix:
        print("\n👁  وضع REPORT — ما تبدل والو. زيد --fix باش تطبق.")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    # ---- تطبيق --------------------------------------------------------------
    print("\n🚀 تطبيق التصحيحات...")
    if not d["pk"]:
        die("ما لقيتش مفتاح أساسي (PK) — ما نقدروش نعملو UPDATE دقيق. عطيلي اسم عمود id.")
    try:
        conn.autocommit = False
        cur2 = conn.cursor()
        for p in plans:
            cur2.execute(f"UPDATE {qt(d['table'])} SET {qi(p['col'])} = %s "
                         f"WHERE {qi(d['pk'])} = %s", (p["new"], p["pk"]))
        # ---- إعادة التحقق قبل commit -----------------------------------------
        remaining = 0
        for kind, col in (("title", d["title_col"]), ("h1", d["h1_col"])):
            if col:
                remaining += len(dup_groups(cur2, d, col))
        if remaining > 0:
            conn.rollback()
            die(f"باقي {remaining} تكرارات من بعد التحديث → ROLLBACK. حتى ما تبدل والو.")
        conn.commit()
        conn.autocommit = True
        print(f"✅ تثبت: 0 تكرارات | {len(plans)} عنوان تبدل | COMMIT")
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        die(f"خطأ فالتطبيق → ROLLBACK: {e}")

    report["fixed"] = len(plans)
    report["verify_remaining"] = 0
    print("\n" + json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
