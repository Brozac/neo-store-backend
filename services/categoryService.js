require('dotenv').config();
const axios = require('axios');
// ✨ Pool مشترك بدل new Pool() محلي — يتفادى تكاثر الاتصالات (شوف db.js)
const pool = require('../db');
const { cjRequest } = require('./cjService');

// ==========================================
// 🔤 slugify بسيط: "Computer & Office" -> "computer-and-office"
// ==========================================
function slugify(name = '') {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ==========================================
// 🔎 find-or-create لعقدة واحدة فالشجرة
// ⚠️ ملاحظة مهمة: ما استعملناش ON CONFLICT بحال (parent_id, slug) لأن Postgres
// كيعتبر كل NULL "مختلف" على حدة فقيود UNIQUE — يعني صفوف المستوى 1 (parent_id = NULL)
// ماكانوش غادي يتعرفو كتكرار، وكل مزامنة كانت غادي تزيد نسخة جديدة بدل ما تحدث الموجودة.
// لهاذا درنا find-or-create يدوي بالمفتاح المناسب لكل مستوى.
// ==========================================
async function findOrCreateCategory(client, { level, name, slug, parentId, cjCategoryId }) {
  let existing;

  if (cjCategoryId) {
    // المستوى 3 (leaf): عندو ID حقيقي من CJ، نعتمدو عليه هو
    existing = await client.query('SELECT id FROM categories WHERE cj_category_id = $1', [cjCategoryId]);
  } else if (parentId === null) {
    // المستوى 1: مفتاحو الطبيعي هو (parent_id IS NULL + slug)
    existing = await client.query('SELECT id FROM categories WHERE parent_id IS NULL AND slug = $1', [slug]);
  } else {
    // المستوى 2: مفتاحو الطبيعي هو (parent_id + slug)
    existing = await client.query('SELECT id FROM categories WHERE parent_id = $1 AND slug = $2', [parentId, slug]);
  }

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await client.query('UPDATE categories SET name = $1 WHERE id = $2', [name, id]);
    return id;
  }

  const inserted = await client.query(
    `INSERT INTO categories (level, name, slug, parent_id, cj_category_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [level, name, slug, parentId, cjCategoryId || null]
  );
  return inserted.rows[0].id;
}

// ==========================================
// 🌳 كتجيب شجرة الفئات الرسمية كاملة من CJ وتعمر جدول categories محلياً
// (idempotent: تقدر تعاود تشغلها، غادي تحدث الأسماء بلا ما تكرر الصفوف)
// ==========================================
async function syncCategoriesFromCJ() {
  const response = await cjRequest((token, config) =>
    axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/getCategory', {
      ...config,
      headers: { 'CJ-Access-Token': token },
    })
  );

  if (response.data.code !== 200 || !Array.isArray(response.data.data)) {
    throw new Error('Unexpected response from CJ getCategory: ' + (response.data.message || 'unknown error'));
  }

  const client = await pool.connect();
  let level1Count = 0, level2Count = 0, level3Count = 0;

  try {
    await client.query('BEGIN');

    for (const first of response.data.data) {
      const l1Name = first.categoryFirstName || 'Uncategorized';
      const l1Id = await findOrCreateCategory(client, { level: 1, name: l1Name, slug: slugify(l1Name), parentId: null, cjCategoryId: null });
      level1Count++;

      for (const second of first.categoryFirstList || []) {
        const l2Name = second.categorySecondName || 'Uncategorized';
        const l2Id = await findOrCreateCategory(client, { level: 2, name: l2Name, slug: slugify(l2Name), parentId: l1Id, cjCategoryId: null });
        level2Count++;

        for (const leaf of second.categorySecondList || []) {
          if (!leaf.categoryId || !leaf.categoryName) continue; // ✨ تخطي أي صف ناقص بيانات
          await findOrCreateCategory(client, {
            level: 3,
            name: leaf.categoryName,
            slug: slugify(leaf.categoryName),
            parentId: l2Id,
            cjCategoryId: leaf.categoryId,
          });
          level3Count++;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { level1Count, level2Count, level3Count };
}

// ==========================================
// 🧭 كتبني الشجرة الكاملة (متداخلة) من جدول categories المحلي — للاستعمال فـ /api/categories
// ==========================================
async function getCategoryTree() {
  const res = await pool.query('SELECT id, level, name, slug, parent_id, cj_category_id FROM categories ORDER BY level ASC, name ASC');

  const byId = {};
  res.rows.forEach((row) => {
    byId[row.id] = { id: row.id, name: row.name, slug: row.slug, cjCategoryId: row.cj_category_id, children: [] };
  });

  const roots = [];
  res.rows.forEach((row) => {
    if (row.parent_id && byId[row.parent_id]) {
      byId[row.parent_id].children.push(byId[row.id]);
    } else if (!row.parent_id) {
      roots.push(byId[row.id]);
    }
  });

  return roots;
}

// ==========================================
// 🔗 كتحول categoryId (جاي من CJ مع منتج) للمسار الكامل ديال slugs عندنا
// كترجع null إلا الفئة ماكانتش موجودة محلياً (مثلا الشجرة ماتزامنتش بعد، ولا CJ زادو فئة جديدة)
// ==========================================
async function resolveCategoryByCjId(cjCategoryId) {
  if (!cjCategoryId) return null;

  const leafRes = await pool.query('SELECT * FROM categories WHERE cj_category_id = $1', [cjCategoryId]);
  if (leafRes.rows.length === 0) return null;

  const chain = [leafRes.rows[0]];
  let current = leafRes.rows[0];

  while (current.parent_id) {
    const parentRes = await pool.query('SELECT * FROM categories WHERE id = $1', [current.parent_id]);
    if (parentRes.rows.length === 0) break;
    current = parentRes.rows[0];
    chain.unshift(current);
  }

  return {
    leafSlug: chain[chain.length - 1].slug,
    slugPath: chain.map((c) => c.slug).join('/'),
    names: chain.map((c) => c.name),
  };
}

module.exports = { syncCategoriesFromCJ, getCategoryTree, resolveCategoryByCjId, slugify };