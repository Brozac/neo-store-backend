#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 inject_categories_monster.py — Laclarc Category Monster Injector
 Task 21 · DRS_PROMPT v14 · 2026
============================================================
الهدف:
  يدير لـ 681 قسم فـ جدول categories محتوى SEO كامل ومُفرد (unique):
    - seo_h1, seo_title (≤60), seo_description (140–160)
    - seo_keywords, seo_content (فقرات \n\n), seo_faqs (JSONB)
    - seo_related (JSONB — روابط داخلية), seo_version, seo_injected_at

الضمانات (تفاديا للاخطاء):
  1) ALTER TABLE ... ADD COLUMN IF NOT EXISTS  → الحقن ما كيكسر والو
  2) توليد المحتوى deterministic (seed = category_id+slug)
     → نفس القسم كيعطي نفس النص فـ كل تشغيلة = idempotent
  3) المعاملة (transaction) على مستوى القسم الرئيسي (Level-1)
     → كراش فـ قسم ما كيأثرش على باقي الأقسام + resume تلقائي
  4) إعادة المحاولة على أخطاء الشبكة/Neon cold-start (3 محاولات)
  5) حقائق حقيقية برك: عدد المنتجات والأسعار كيتقراو من قاعدة البيانات
     — إذا 0 منتجات، النص كيتكيف أوتوماتيكياً (بلا أرقام مزوّرة)
  6) الشكايات المستعملة هي نفسها اللي الموقع كيعرضها:
     FREE worldwide shipping · Buyer Protection · 24/7 AI Support ·
     tracking · 30-day return policy

الاستعمال:
  python inject_categories_monster.py "postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"

  خيارات:
    --dry-run              معاينة بلا أي كتابة فـ قاعدة البيانات
    --section slug[,slug]  خدمة قسم رئيسي وحدو أو عدة أقسام (قسم بقسم)
    --level 1,2,3          فلترة بالمستويات (default: الكل)
    --limit N              أقصى عدد أقسام تُحقن فهاد التشغيلة (للاختبار)
    --force                إعادة الحقن حتى على الأقسام المحقونة مسبقاً
    --no-verify            تخطى فحص الجودة النهائي
    --report PATH          مسار تقرير JSON (default: category_seo_report.json)

  المتطلبات:  pip install "psycopg[binary]"     (أو psycopg2 — كلاهما مدعوم)
============================================================
"""

import argparse
import json
import random
import sys
import time
from datetime import datetime, timezone

# ضمان UTF-8 حتى فـ ويندوز (PowerShell / cmd)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CONTENT_VERSION = "v1"
APP_NAME = "laclarc-seo-injector"
TRANSIENT_PGCODES = {
    "08000", "08001", "08003", "08004", "08006",  # connection exceptions
    "40001", "40P01",                              # serialization / deadlock
    "57P01", "57P03",                              # admin shutdown / cannot connect now
}

# ============================================================
# 📚 مكتبات النصوص (Copy Pools) — إنجليزية عالمية، شكايات حقيقية
#    كل جملة فيها slots كيتعبوا من حقائق القسم الحقيقية
# ============================================================

H1_POOL = [
    "Shop {name} Online",
    "{name} Collection",
    "{name}, Shipped Free Worldwide",
    "Discover {name} at Laclarc",
    "{name} — Curated for the World",
]

PARAGRAPHS = {
    "intro_leaf": [
        "Welcome to the {name} collection at Laclarc — a hand-picked corner of {parent} built for shoppers everywhere. Every listing is curated before it goes live, and every order ships free worldwide with insurance and door-to-door tracking included.",
        "This is {name}, done the Laclarc way: a curated {parent} selection, honest pricing, free worldwide insured shipping, and buyer protection on every single order. Take your time — the collection is organized so you can zero in on the right piece fast.",
        "Looking for {name} that balance quality, price and speed? This collection pulls together the strongest options our sourcing team has locked in, all shipped free across the globe with full tracking from warehouse to doorstep.",
        "The {name} edit at Laclarc brings together designs from trusted international partners under one roof — backed by free worldwide insured shipping, 24/7 AI support and a 30-day return policy.",
    ],
    "intro_mid": [
        "The {name} hub gathers the full range in one place — {subs}. Open any sub-collection and you get the same Laclarc standard: curated listings, free worldwide insured shipping and buyer protection on every order.",
        "Everything {name}, one destination. Browse {subs} and more — every piece ships free worldwide, insured and tracked, with 24/7 support if you need a hand choosing.",
        "Laclarc's {name} section is built for choice: {subs} — each sub-collection curated and refreshed as new stock lands. Free worldwide shipping and buyer protection come standard.",
    ],
    "intro_top": [
        "{name} is one of Laclarc's flagship sections — a world of {subs} and more, curated for a global audience. Whatever you pick, it ships free worldwide, insured and fully tracked.",
        "Start your {name} search here. Laclarc organizes this section into {subs} and more, so you can move from browsing to checkout in minutes — with free worldwide insured shipping and buyer protection behind every order.",
        "Welcome to {name} at Laclarc, where {subs} and hundreds of further picks live under one roof. Curated listings, honest prices, free worldwide delivery — that is the baseline.",
    ],
    "breadth": [
        "Not sure where to start? Jump into {subs}, or use the on-page filters to slice the section by price and newest arrivals.",
        "The fastest route: open {subs}, shortlist what stands out, and let the filters narrow the rest for you.",
    ],
    "selection_filled": [
        "Right now the counter sits at {count} live {name_l} products, running from {min_p} entry picks up to {max_p} premium builds — filters on the page help you land on the right one in seconds.",
        "The lineup is alive: {count} {name_l} pieces are in stock at this moment, with prices from {min_p} to {max_p} and new arrivals landing as sourcing deals close.",
        "There are {count} {name_l} options waiting right now — from {min_p} steals to {max_p} statement pieces — and the collection refreshes every sourcing cycle.",
    ],
    "selection_empty": [
        "New {name_l} drops land continuously as our sourcing team signs fresh deals with partner warehouses — check back often or ask the AI assistant what just arrived.",
    ],
    "quality": [
        "Curation comes first: listings are screened before they go live, supplier track records are reviewed, and product photos are checked against the actual items — so what you see is what ships.",
        "Every order is covered by Buyer Protection. If something arrives damaged or not as described, the 30-day return policy and the support team have you covered.",
        "Trust is engineered into the flow: secure checkout, clear pricing with no shipping surprises, and a refund policy that actually answers when things go wrong.",
    ],
    "shipping": [
        "Shipping is free worldwide and insured — Casablanca, Paris, New York, Dubai, anywhere in between. Once dispatched, live tracking follows your parcel from the international warehouse to your door.",
        "No shipping math at checkout: {name_l} orders ship worldwide for free, insurance included, with tracking updates at every stage of the journey.",
        "Wherever you are, the price you see is the price you pay — free worldwide insured shipping on every {name_l} order, tracked end to end.",
    ],
    "support": [
        "Undecided? The AI assistant answers instantly around the clock, real humans back it up, and order tracking keeps you posted from dispatch to delivery.",
        "Support never sleeps here: 24/7 automated and AI assistance plus a tracking page that shows exactly where your {name_l} parcel is right now.",
    ],
    "cta": [
        "Scroll the collection, save your favorites, and check out in seconds — your {name_l} picks ship free, worldwide, fully tracked.",
        "Ready when you are: pick your {name_l}, tune the filters, and let Laclarc handle shipping, insurance and tracking from there.",
        "Pick your favorites now — free worldwide insured shipping, buyer protection and 30-day returns do the rest.",
    ],
}

DESC_FILLED = [
    "Shop {count} {name_l} at Laclarc with free worldwide insured shipping, buyer protection and 24/7 AI support. Curated picks from {min_p} — order today, tracked to your door.",
    "Browse curated {name_l} at Laclarc — {count} live products from {min_p} to {max_p}. Free worldwide shipping, 30-day returns, secure checkout and full tracking on every order.",
    "Find your {name_l} at Laclarc: {count} hand-picked products, free worldwide insured shipping, buyer protection on every order and 24/7 support.",
]
DESC_EMPTY = [
    "Browse curated {name_l} at Laclarc — free worldwide insured shipping, buyer protection, 24/7 AI support and a 30-day return policy on every order.",
    "Discover {name_l} on Laclarc: hand-picked products shipped free worldwide, insured and tracked, with secure checkout and support around the clock.",
]
DESC_PADDING = [
    " Free worldwide shipping applies to every order.",
    " Every order ships free, insured and fully tracked.",
    " Buyer protection and 30-day returns included.",
]

FAQS = {
    "shipping": (
        "How much does shipping cost for {name}?",
        "Nothing — shipping is free worldwide on Laclarc, insurance included. Your {name_l} order is tracked from the international warehouse all the way to your door.",
    ),
    "time": (
        "How long does {name} delivery take?",
        "It depends on your country and the product's origin warehouse — most orders arrive within 1 to 3 weeks. The tracking page shows live status at every step, and the AI assistant can estimate delivery for your address.",
    ),
    "returns": (
        "What if my {name} arrives damaged or not as described?",
        "You are covered by Buyer Protection and the 30-day return policy. Reach support — or the 24/7 AI assistant — with your order number and photos, and the team will make it right.",
    ),
    "pay": (
        "Which payment methods can I use?",
        "Checkout supports major cards and digital payment options, all processed over a secure, encrypted connection. The full list of available methods is shown at checkout before you confirm.",
    ),
    "count": (
        "How many {name} products are available right now?",
        "{count} {name_l} products are live in this collection, priced from {min_p} to {max_p}. New arrivals are added every sourcing cycle.",
    ),
}

# ============================================================
# 🛠 أدوات مساعدة
# ============================================================

class Seeded:
    """RNG ثابت: نفس الـ seed = نفس النتيجة بالضبط (idempotent content)."""

    def __init__(self, seed_str: str):
        self.rng = random.Random("laclarc-seo-%s::%s" % (CONTENT_VERSION, seed_str))

    def pick(self, pool):
        return self.rng.choice(pool)

    def shuffle(self, items):
        out = list(items)
        self.rng.shuffle(out)
        return out

    def chance(self, p: float) -> bool:
        return self.rng.random() < p


def fill(template: str, mapping: dict) -> str:
    """تعويض {tokens} بأمان — الأطول أولاً حتى {name_l} ما تتاكل قبل {name}."""
    out = template
    for key in sorted(mapping.keys(), key=len, reverse=True):
        out = out.replace("{" + key + "}", str(mapping[key]))
    return out


def natural_join(names):
    """['A','B','C','D'] → 'A, B, C and D'"""
    names = [n for n in names if n]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return "%s and %s" % (names[0], names[1])
    return ", ".join(names[:-1]) + " and " + names[-1]


def money(v) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    if f == int(f):
        return "$%d" % int(f)
    return "$%.2f" % f


def fmt_count(n: int) -> str:
    return "{:,}".format(n)


def clamp_text(text: str, max_len: int, min_len: int = 0, rng=None) -> str:
    """قص آمن على حدود الكلمات + حشوة جمل صحيحة إذا قصير."""
    t = " ".join(text.split())  # normalize whitespace
    if len(t) > max_len:
        cut = t[:max_len]
        sp = cut.rfind(" ")
        if sp > max_len * 0.6:
            cut = cut[:sp]
        return cut.rstrip(" ,;:-—") + "."
    if min_len and len(t) < min_len and rng is not None:
        for pad in DESC_PADDING:
            t2 = t + pad
            if len(t2) >= min_len:
                break
        return t2[:max_len]
    return t


# ============================================================
# 🧠 مولّد المحتوى — deterministic per category
# ============================================================

class ContentBuilder:
    """كايبني كل حقول SEO لقسم معيّن من شجرة الأقسام + إحصائيات المنتجات."""

    def __init__(self, tree, stats):
        # tree: {id: cat_dict} — cat_dict فيه children (list of ids)
        self.tree = tree
        self.stats = stats  # {id: {'cnt':int,'min':float|None,'max':float|None}}

    # ----- جمع الحقائق الحقيقية -----
    def facts_for(self, cat):
        """عدد المنتجات + نطاق الأسعار (للورقة مباشرة، وللأب/الجذر مجموع الورثة)."""
        agg = {"cnt": 0, "min": None, "max": None}

        def merge(s):
            if not s or not s.get("cnt"):
                return
            agg["cnt"] += s["cnt"]
            for k in ("min", "max"):
                v = s.get(k)
                if v is None:
                    continue
                if agg[k] is None:
                    agg[k] = v
                elif k == "min":
                    agg[k] = min(agg[k], v)
                else:
                    agg[k] = max(agg[k], v)

        def walk(cid):
            s = self.stats.get(cid)
            if s:
                merge(s)
            for ch in self.tree[cid]["children"]:
                walk(ch)

        walk(cat["id"])
        return agg

    def child_names(self, cat, limit=4):
        kids = [self.tree[cid]["name"] for cid in cat["children"]]
        return kids[:limit], len(kids) > limit

    def sibling_slugs(self, cat, limit=6):
        parent = self.tree.get(cat["parent_id"]) if cat["parent_id"] else None
        sibs = [self.tree[cid]["slug"] for cid in (parent["children"] if parent else [])]
        sibs = [s for s in sibs if s != cat["slug"]]
        return sibs[:limit]

    # ----- الحقول -----
    def build_h1(self, rng, cat):
        return clamp_text(fill(rng.pick(H1_POOL), {"name": cat["name"]}), 70)

    def build_title(self, cat, parent_name):
        name, ctx = cat["name"], (parent_name or "Laclarc")
        if cat["level"] == 1:
            candidates = [
                "%s | Laclarc — Free Worldwide Shipping" % name,
                "Shop %s — Laclarc" % name,
                "%s | Laclarc" % name,
            ]
        else:
            candidates = [
                "%s — %s Collection | Laclarc" % (name, ctx),
                "Shop %s Online — Laclarc" % name,
                "%s | Free Worldwide Shipping" % name,
                "%s — Laclarc" % name,
            ]
        for c in candidates:
            if len(c) <= 60:
                return c
        base = "Shop %s | Laclarc" % name
        if len(base) <= 60:
            return base
        avail = 60 - len("Shop  | Laclarc")
        return ("Shop %s | Laclarc" % name[:max(avail, 1)].strip()).strip()

    def build_desc(self, rng, cat, facts):
        m = self.slots(cat, facts)
        pool = DESC_FILLED if facts["cnt"] > 0 else DESC_EMPTY
        text = fill(rng.pick(pool), m)
        return clamp_text(text, 160, min_len=120, rng=rng)

    def slots(self, cat, facts):
        names_l = cat["name"].lower()
        return {
            "name": cat["name"],
            "name_l": names_l,
            "count": fmt_count(facts["cnt"]) if facts["cnt"] else "",
            "min_p": money(facts["min"]) if facts["min"] is not None else "$0",
            "max_p": money(facts["max"]) if facts["max"] is not None else "$0",
        }

    def build_paragraphs(self, rng, cat, facts):
        m = self.slots(cat, facts)
        kids, more = self.child_names(cat)
        subs = natural_join(kids) + (" and more" if more else "")
        m["subs"] = subs if subs else "every corner of Laclarc"

        parent = self.tree.get(cat["parent_id"]) if cat["parent_id"] else None
        m["parent"] = parent["name"] if parent else "the Laclarc catalog"

        paras = []
        if cat["level"] == 1:
            paras.append(fill(rng.pick(PARAGRAPHS["intro_top"]), m))
            if kids:
                paras.append(fill(rng.pick(PARAGRAPHS["breadth"]), m))
        elif cat["level"] == 2 and kids:
            paras.append(fill(rng.pick(PARAGRAPHS["intro_mid"]), m))
        else:
            paras.append(fill(rng.pick(PARAGRAPHS["intro_leaf"]), m))

        if facts["cnt"] > 0:
            paras.append(fill(rng.pick(PARAGRAPHS["selection_filled"]), m))
        else:
            paras.append(fill(rng.pick(PARAGRAPHS["selection_empty"]), m))

        paras.append(fill(rng.pick(PARAGRAPHS["quality"]), m))
        paras.append(fill(rng.pick(PARAGRAPHS["shipping"]), m))
        if rng.chance(0.5):  # تنويع: بعض الأقسام فيها فقرة السبورت (deterministic)
            paras.append(fill(rng.pick(PARAGRAPHS["support"]), m))
        paras.append(fill(rng.pick(PARAGRAPHS["cta"]), m))
        return paras

    def build_faqs(self, rng, cat, facts):
        m = self.slots(cat, facts)
        chosen = [FAQS["shipping"], FAQS["returns"]]
        extras = ["time", "pay"] + (["count"] if facts["cnt"] > 0 else [])
        rng.shuffle(extras)
        chosen += [FAQS[k] for k in extras[:2]]
        return [
            {"q": fill(q, m), "a": fill(a, m)}
            for (q, a) in chosen
        ]

    def build_keywords(self, cat, parent_name, root_name):
        name_l = cat["name"].lower()
        kws = [
            name_l,
            "buy %s online" % name_l,
            "%s free shipping" % name_l,
            "laclarc %s" % name_l,
        ]
        if parent_name and parent_name.lower() != name_l:
            kws += [parent_name.lower(), "%s online" % parent_name.lower()]
        if root_name and root_name.lower() not in {name_l, (parent_name or "").lower()}:
            kws.append("%s collection" % root_name.lower())
        seen, out = set(), []
        for k in kws:
            if k and k not in seen:
                seen.add(k)
                out.append(k)
        return ", ".join(out)

    def build_related(self, rng, cat):
        rel = self.sibling_slugs(cat)
        parent = self.tree.get(cat["parent_id"]) if cat["parent_id"] else None
        if parent:
            rel = [parent["slug"]] + rel
        kids = [self.tree[cid]["slug"] for cid in cat["children"]][:6]
        rel += kids
        seen, out = set(), []
        for s in rel:
            if s and s != cat["slug"] and s not in seen:
                seen.add(s)
                out.append(s)
        return out[:10]

    # ----- الواجهة الرئيسية -----
    def build(self, cat):
        rng = Seeded("%s::%s" % (cat["id"], cat["slug"]))
        parent = self.tree.get(cat["parent_id"]) if cat["parent_id"] else None
        facts = self.facts_for(cat)
        parent_name = parent["name"] if parent else None
        root_name = cat["name"] if cat["level"] == 1 else None
        if root_name is None and parent:
            gp = self.tree.get(parent["parent_id"]) if parent["parent_id"] else None
            root_name = gp["name"] if gp else parent["name"]
        return {
            "seo_h1": self.build_h1(rng, cat),
            "seo_title": self.build_title(cat, parent_name),
            "seo_description": self.build_desc(rng, cat, facts),
            "seo_keywords": self.build_keywords(cat, parent_name, root_name),
            "seo_content": "\n\n".join(self.build_paragraphs(rng, cat, facts)),
            "seo_faqs": self.build_faqs(rng, cat, facts),
            "seo_related": self.build_related(rng, cat),
        }

# ============================================================
# 🗄 محوّل قاعدة البيانات — psycopg3 أو psycopg2 (كلاهما مدعوم)
#    autocommit=True + BEGIN/COMMIT يدوية → سلوك موحّد بين النسختين
# ============================================================

class Database:
    def __init__(self, url: str):
        self.url = normalize_url(url)
        self.conn = None
        self.driver = None

    def connect(self, retries=3):
        last_err = None
        for attempt in range(1, retries + 1):
            try:
                try:
                    import psycopg
                    from psycopg.rows import dict_row
                    self.driver = "psycopg3"
                    self.conn = psycopg.connect(
                        self.url, row_factory=dict_row,
                        autocommit=True, connect_timeout=20,
                    )
                except ImportError:
                    import psycopg2
                    import psycopg2.extras
                    self.driver = "psycopg2"
                    self.conn = psycopg2.connect(self.url)
                    self.conn.autocommit = True
                self.exec("SET application_name = '%s'" % APP_NAME)
                return
            except Exception as e:
                last_err = e
                if attempt < retries:
                    wait = attempt * 3
                    print("   ⚠️ فشل الاتصال (محاولة %d/%d): %s — إعادة بعد %ds..."
                          % (attempt, retries, short_err(e), wait))
                    time.sleep(wait)
        raise SystemExit("❌ ما قدرناش نتصلو بقاعدة البيانات: %s" % short_err(last_err))

    def close(self):
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass

    def cursor(self):
        return self.conn.cursor()

    def exec(self, sql, params=None):
        cur = self.conn.cursor()
        cur.execute(sql, params or ())
        return cur

    def query(self, sql, params=None):
        cur = self.exec(sql, params)
        if cur.description is None:
            return []
        rows = cur.fetchall()
        return [dict(r) for r in rows]

    def is_transient(self, err) -> bool:
        code = getattr(err, "pgcode", None) or getattr(err, "sqlstate", None) or ""
        if code in TRANSIENT_PGCODES:
            return True
        return isinstance(err, ConnectionError) or "connection" in str(err).lower()


def short_err(e) -> str:
    return str(e).split("\n")[0][:160]


def normalize_url(url: str) -> str:
    url = url.strip().strip('"').strip("'")
    if "sslmode=" not in url:
        local = ("@localhost" in url or "@127.0.0.1" in url or "@::1" in url
                 or "@[::1]" in url or "host=localhost" in url)
        if not local:
            url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def resolve_url(args) -> str:
    url = (args.database_url or "").strip()
    if not url:
        url = (args.positional_url or "").strip()
    if not url:
        import os
        url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        SystemExitMsg = (
            "❌ ما كاينش سلسلة الاتصال!\n"
            "   الاستعمال: python inject_categories_monster.py \"postgresql://user:pass@host/db?sslmode=require\"\n"
            "   أو: --database-url \"...\" أو متغير البيئة DATABASE_URL"
        )
        print(SystemExitMsg)
        sys.exit(2)
    return url


# ============================================================
# 🏗 Schema — أعمدة SEO (إضافية 100%، ما كتمس والو على الموجود)
# ============================================================

SCHEMA_COLUMNS = """
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_h1 TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_title VARCHAR(200);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_description VARCHAR(400);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_keywords TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_content TEXT;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_faqs JSONB;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_related JSONB;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_version VARCHAR(20);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS seo_injected_at TIMESTAMPTZ;
"""

UPDATE_SQL = """
UPDATE categories SET
  seo_h1 = %s, seo_title = %s, seo_description = %s, seo_keywords = %s,
  seo_content = %s, seo_faqs = %s::jsonb, seo_related = %s::jsonb,
  seo_version = %s, seo_injected_at = NOW()
WHERE id = %s
"""


def ensure_schema(db: Database):
    print("🏗 إضافة أعمدة SEO (IF NOT EXISTS — آمن 100% على إعادة التشغيل)...")
    for stmt in [s.strip() for s in SCHEMA_COLUMNS.split(";") if s.strip()]:
        db.exec(stmt)
    print("✅ الأعمدة جاهزة\n")


def seo_column_exists(db: Database) -> bool:
    rows = db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'categories' AND column_name = 'seo_injected_at' LIMIT 1"
    )
    return len(rows) > 0


# ============================================================
# 📊 تحميل الشجرة + الإحصائيات الحقيقية للمنتجات
# ============================================================

def load_tree(db: Database):
    # العمود seo_injected_at يمكن ما يكونش بعد (dry-run على قاعدة بلا حقن سابق)
    has_seo = seo_column_exists(db)
    sql = ("SELECT id, level, name, slug, parent_id" +
           (", seo_injected_at" if has_seo else "") +
           " FROM categories ORDER BY level ASC, name ASC")
    rows = db.query(sql)
    if not rows:
        raise SystemExit("❌ جدول categories خاوي — شغّل syncCategoriesFromCJ أولاً (massSync).")
    tree = {}
    for r in rows:
        tree[r["id"]] = {
            "id": r["id"], "level": r["level"], "name": r["name"],
            "slug": r["slug"], "parent_id": r["parent_id"],
            "seo_injected_at": r.get("seo_injected_at") if has_seo else None,
            "children": [],
        }
    for r in rows:
        pid = r["parent_id"]
        if pid and pid in tree:
            tree[pid]["children"].append(r["id"])
    return tree


def load_stats(db: Database):
    stats = {}
    # 1) عبر cj_category_id (الدقيق)
    try:
        rows = db.query(
            "SELECT cj_category_id, COUNT(*)::int AS cnt, MIN(price) AS mn, MAX(price) AS mx "
            "FROM products WHERE cj_category_id IS NOT NULL AND stock_status = true "
            "GROUP BY cj_category_id"
        )
        id_by_cj = {}
        for r in db.query("SELECT id, cj_category_id FROM categories WHERE cj_category_id IS NOT NULL"):
            id_by_cj[str(r["cj_category_id"])] = r["id"]
        for r in rows:
            cid = id_by_cj.get(str(r["cj_category_id"]))
            if cid is not None:
                stats[cid] = {"cnt": r["cnt"], "min": r["mn"], "max": r["mx"]}
    except Exception as e:
        print("⚠️ cj_category_id stats: %s" % short_err(e))
    # 2) fallback بالاسم (للأقسام اللي منتجاتها مربوطة بالاسم)
    try:
        rows = db.query(
            "SELECT LOWER(TRIM(category)) AS cat, COUNT(*)::int AS cnt, MIN(price) AS mn, MAX(price) AS mx "
            "FROM products WHERE category IS NOT NULL AND stock_status = true "
            "GROUP BY LOWER(TRIM(category))"
        )
        by_name = {r["cat"]: r for r in rows}
        for r in db.query("SELECT id, name FROM categories"):
            cid = r["id"]
            if cid not in stats:
                hit = by_name.get(r["name"].strip().lower())
                if hit:
                    stats[cid] = {"cnt": hit["cnt"], "min": hit["mn"], "max": hit["mx"]}
    except Exception as e:
        print("⚠️ name fallback stats: %s" % short_err(e))
    return stats


def collect_sections(tree):
    """الجذور = level 1 (أو orphan بلا أب موجود) — كل جذر = قسم رئيسي مستقل."""
    roots = []
    for cat in tree.values():
        pid = cat["parent_id"]
        if pid is None or pid not in tree:
            roots.append(cat)
    roots.sort(key=lambda c: (c["slug"] or "").lower())
    return roots


def collect_members(tree, root, level_filter):
    out = []

    def walk(cid):
        cat = tree[cid]
        if level_filter is None or cat["level"] in level_filter:
            out.append(cat)
        for ch in cat["children"]:
            walk(ch)

    walk(root["id"])
    return out


# ============================================================
# 💉 الحقن — قسم بقسم، transaction على مستوى كل قسم رئيسي
# ============================================================

def run_injection(db, builder, roots, args):
    level_filter = None
    if args.level:
        level_filter = {int(x) for x in args.level.split(",") if x.strip().isdigit()}
    want_sections = None
    if args.section:
        want_sections = {s.strip().lower() for s in args.section.split(",") if s.strip()}

    remaining = args.limit if args.limit else None
    report_sections, failures = [], []
    total_updated = total_skipped = 0

    for idx, root in enumerate(roots, 1):
        if want_sections and root["slug"].lower() not in want_sections:
            continue
        members = collect_members(tree_cache, root, level_filter)
        todo = [c for c in members if args.force or not c["seo_injected_at"]]
        skipped = len(members) - len(todo)
        if remaining is not None:
            todo = todo[:remaining]

        label = "%s (%s)" % (root["name"], root["slug"])
        head = "  [%d/%d] 🗂 %s — %d قسم | جديد: %d | مُحقن سابقاً: %d" % (
            idx, len(roots), label, len(members), len(todo), skipped)

        if not todo:
            print(head + " → ⏭ تخطى (كامل محقون)")
            report_sections.append({"slug": root["slug"], "members": len(members),
                                    "updated": 0, "skipped": skipped})
            total_skipped += skipped
            continue

        if remaining is not None:
            remaining -= len(todo)

        attempt, done = 0, False
        t0 = time.perf_counter()
        while attempt < 3 and not done:
            attempt += 1
            try:
                db.exec("BEGIN")
                for c in todo:
                    content = builder.build(c)
                    db.exec(UPDATE_SQL, (
                        content["seo_h1"], content["seo_title"], content["seo_description"],
                        content["seo_keywords"], content["seo_content"],
                        json.dumps(content["seo_faqs"], ensure_ascii=False),
                        json.dumps(content["seo_related"], ensure_ascii=False),
                        CONTENT_VERSION, c["id"],
                    ))
                db.exec("COMMIT")
                done = True
            except Exception as e:
                try:
                    db.exec("ROLLBACK")
                except Exception:
                    try:
                        db.close()
                        db.connect(retries=1)
                    except Exception:
                        pass
                if db.is_transient(e) and attempt < 3:
                    print("   ⚠️ خطأ عابر فـ %s (محاولة %d): %s — إعادة..." % (root["slug"], attempt, short_err(e)))
                    time.sleep(2 * attempt)
                    try:
                        db.close(); db.connect(retries=1)
                    except Exception:
                        pass
                else:
                    failures.append({"section": root["slug"], "error": short_err(e)})
                    print(head + " → ❌ فشل: %s" % short_err(e))
                    break
        if done:
            dur = time.perf_counter() - t0
            print(head + " → ✅ حقن %d قسم (%.1fs)" % (len(todo), dur))
            total_updated += len(todo)
            total_skipped += skipped
            report_sections.append({"slug": root["slug"], "name": root["name"],
                                    "members": len(members), "updated": len(todo),
                                    "skipped": skipped, "attempts": attempt})
        if remaining is not None and remaining <= 0:
            print("⏹ وصلنا لـ --limit — التشغيلة التالية كتكمّل من هنا (resume تلقائي).")
            break

    return total_updated, total_skipped, report_sections, failures


# ============================================================
# 🔍 فحص الجودة النهائي
# ============================================================

def verify(db, args):
    print("\n" + "=" * 52)
    print("🔍 فحص الجودة النهائي")
    print("=" * 52)
    totals = db.query(
        "SELECT COUNT(*)::int AS total, COUNT(seo_h1)::int AS h1, COUNT(seo_title)::int AS titles, "
        "COUNT(seo_description)::int AS descs, COUNT(seo_content)::int AS contents, "
        "COUNT(seo_faqs)::int AS faqs FROM categories"
    )[0]
    print("   الأقسام: %d | H1: %d | Titles: %d | Descriptions: %d | Content: %d | FAQs: %d"
          % (totals["total"], totals["h1"], totals["titles"], totals["descs"],
             totals["contents"], totals["faqs"]))

    lens = db.query(
        "SELECT MIN(LENGTH(seo_description)) AS dmin, MAX(LENGTH(seo_description)) AS dmax, "
        "ROUND(AVG(LENGTH(seo_description))::numeric, 1) AS davg, "
        "MIN(LENGTH(seo_content)) AS cmin, MAX(LENGTH(seo_content)) AS cmax, "
        "ROUND(AVG(LENGTH(seo_content))::numeric, 1) AS cavg "
        "FROM categories WHERE seo_content IS NOT NULL"
    )[0]
    if lens["dmin"] is not None:
        print("   وصف الميتا: %d–%d حرف (متوسط %s) | المحتوى: %d–%d حرف (متوسط %s)"
              % (lens["dmin"], lens["dmax"], lens["davg"], lens["cmin"], lens["cmax"], lens["cavg"]))

    dups = db.query(
        "SELECT seo_title, COUNT(*)::int AS n FROM categories "
        "WHERE seo_title IS NOT NULL GROUP BY seo_title HAVING COUNT(*) > 1 LIMIT 10"
    )
    if dups:
        print("   ⚠️ عناوين مكررة (%d):" % len(dups))
        for d in dups:
            print("      ×%d  %s" % (d["n"], d["seo_title"]))
    else:
        print("   ✅ صفر عناوين مكررة (كل قسم عنوان فريد)")

    sample_slugs = [s.strip() for s in (args.sample or "").split(",") if s.strip()]
    if sample_slugs:
        for s in sample_slugs:
            rows = db.query(
                "SELECT name, level, slug, seo_h1, seo_title, seo_description, seo_content, seo_faqs "
                "FROM categories WHERE slug = %s LIMIT 1", (s,))
            for r in rows:
                print("\n   📄 %s (L%d, %s)" % (r["name"], r["level"], r["slug"]))
                print("      H1:   %s" % r["seo_h1"])
                print("      Title(%d): %s" % (len(r["seo_title"] or ""), r["seo_title"]))
                print("      Desc(%d):  %s" % (len(r["seo_description"] or ""), r["seo_description"]))
                paras = (r["seo_content"] or "").split("\n\n")
                print("      Content: %d فقرة / %d حرف" % (len(paras), len(r["seo_content"] or "")))
                if r["seo_faqs"]:
                    print("      FAQ[0]: %s" % r["seo_faqs"][0]["q"])
    return totals


# ============================================================
# 🎬 main
# ============================================================

def main():
    global tree_cache
    ap = argparse.ArgumentParser(
        description="Laclarc Category Monster Injector — محتوى SEO كامل لكل الأقسام، قسم بقسم")
    ap.add_argument("positional_url", nargs="?", default="", help="postgresql://... (Neon)")
    ap.add_argument("--database-url", dest="database_url", default="")
    ap.add_argument("--dry-run", action="store_true", help="معاينة بلا كتابة")
    ap.add_argument("--section", default="", help="slug القسم/الأقسام مفصولين بفاصلة")
    ap.add_argument("--level", default="", help="مثال: 3 أو 1,2")
    ap.add_argument("--limit", type=int, default=None, help="أقصى عدد أقسام تُحقن")
    ap.add_argument("--force", action="store_true", help="إعادة الحقن حتى المحقون مسبقاً")
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--sample", default="", help="slugs للعرض في الفحص النهائي")
    ap.add_argument("--report", default="category_seo_report.json")
    args = ap.parse_args()

    print("=" * 52)
    print("  🦣 LACLARC CATEGORY MONSTER INJECTOR")
    print("  محتوى SEO كامل · قسم بقسم · idempotent · آمن")
    print("=" * 52)

    url = resolve_url(args)
    db = Database(url)
    db.connect()
    print("🔌 متصل (%s)\n" % db.driver)

    tree_cache = load_tree(db)
    print("🌳 الأقسام: %d مجموعاً" % len(tree_cache))

    schema_ready = seo_column_exists(db)
    if args.dry_run and not schema_ready:
        print("ℹ️  --dry-run: الأعمدة ما كايناش بعد — كانحسبو كلشي كـ 'جديد'\n")
        for c in tree_cache.values():
            c["seo_injected_at"] = None
    elif not schema_ready:
        ensure_schema(db)
    else:
        print("✅ أعمدة SEO موجودة مسبقاً (resume ممكن)\n")

    print("📊 قراءة إحصائيات المنتجات الحقيقية...")
    stats = load_stats(db)
    with_products = sum(1 for s in stats.values() if s.get("cnt"))
    total_products = sum(s.get("cnt", 0) for s in stats.values())
    print("   أقسام عندها منتجات: %d | مجموع الإحصائيات: %s منتج\n"
          % (with_products, fmt_count(total_products)))

    builder = ContentBuilder(tree_cache, stats)
    roots = collect_sections(tree_cache)

    if args.dry_run:
        print("👁 DRY-RUN — معاينة أول قسم كامل + ملخص باقي الأقسام:\n")
        shown = 0
        for root in collect_sections(tree_cache):
            members = collect_members(tree_cache, root, None)
            print("  🗂 %s — %d قسم" % (root["slug"], len(members)))
            if shown == 0:
                c = builder.build(members[0])
                print("     مثال [%s]:" % members[0]["slug"])
                print("       H1:  %s" % c["seo_h1"])
                print("       Title(%d): %s" % (len(c["seo_title"]), c["seo_title"]))
                print("       Desc(%d):  %s" % (len(c["seo_description"]), c["seo_description"]))
                print("       Content: %d فقرة / %d حرف | FAQs: %d | Related: %d"
                      % (c["seo_content"].count("\n\n") + 1, len(c["seo_content"]),
                         len(c["seo_faqs"]), len(c["seo_related"])))
                for p in c["seo_content"].split("\n\n")[:2]:
                    print("       ¶ %s..." % p[:110])
                shown = 1
        print("\n👁 dry-run انتهى — حتى كتابة ما حدثت. شغّل بلا --dry-run للحقن الفعلي.")
        db.close()
        return

    print("🚀 بدء الحقن قسم بقسم...\n")
    t0 = time.perf_counter()
    updated, skipped, sections, failures = run_injection(db, builder, roots, args)
    dur = time.perf_counter() - t0

    print("\n" + "=" * 52)
    print("🏁 انتهى الحقن: ✅ %d قسم مُحقن | ⏭ %d تخطاه | ⏱ %.1fs | فشل: %d"
          % (updated, skipped, dur, len(failures)))
    print("=" * 52)

    verify_res = None
    if not args.no_verify and updated >= 0:
        verify_res = verify(db, args)

    if args.report:
        rep = {
            "run_at": datetime.now(timezone.utc).isoformat(),
            "content_version": CONTENT_VERSION,
            "driver": db.driver,
            "dry_run": False,
            "sections_total": len(roots),
            "categories_total": len(tree_cache),
            "updated": updated, "skipped_existing": skipped,
            "failures": failures,
            "sections": sections,
            "verify": verify_res,
        }
        try:
            with open(args.report, "w", encoding="utf-8") as f:
                json.dump(rep, f, ensure_ascii=False, indent=2)
            print("\n📄 التقرير: %s" % args.report)
        except Exception as e:
            print("⚠️ ما قدرناش نكتبو التقرير: %s" % short_err(e))

    db.close()
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
