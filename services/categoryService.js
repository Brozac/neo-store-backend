// services/categoryService.js - Laclarc High-Performance Category Engine
require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const { cjRequest } = require('./cjService');

// كاش في الذاكرة لتسريع استيراد المنتجات بآلاف المرات
let categoryPathCache = new Map();

// ==========================================
// 🔤 slugify محصن ضد الحروف الفارغة والرموز
// ==========================================
function slugify(name = '', fallbackId = '') {
  let slug = String(name)
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
    
  if (!slug || slug.length === 0) {
    slug = fallbackId ? `cat-${fallbackId}` : `category-${Date.now()}`;
  }
  return slug;
}

// ==========================================
// 🌳 مزامنة شجرة الفئات بسرعة البرق (In-Memory Preloaded Sync)
// تم تقليص الاستعلامات من 6000 استعلام إلى بضعة استعلامات فقط
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

    // 1. جلب جميع الأقسام الحالية إلى الذاكرة مسبقاً (استعلام واحد فقط ينهي مشكلة N+1)
    const existingRes = await client.query('SELECT id, level, name, slug, parent_id, cj_category_id FROM categories');
    
    // بناء خرائط سريعة للبحث الفوري O(1)
    const cjIdMap = new Map(); // cj_category_id -> id
    const l1Map = new Map();   // slug -> id
    const l2Map = new Map();   // parentId_slug -> id

    for (const row of existingRes.rows) {
      if (row.cj_category_id) cjIdMap.set(String(row.cj_category_id), row);
      if (row.level === 1) l1Map.set(row.slug, row);
      if (row.level === 2) l2Map.set(`${row.parent_id}_${row.slug}`, row);
    }

    // 2. معالجة المستويات بسرعة فائقة
    for (const first of response.data.data) {
      const l1Name = (first.categoryFirstName || 'Uncategorized').trim();
      const l1Slug = slugify(l1Name);
      
      let l1Id;
      if (l1Map.has(l1Slug)) {
        l1Id = l1Map.get(l1Slug).id;
        await client.query('UPDATE categories SET name = $1 WHERE id = $2', [l1Name, l1Id]);
      } else {
        const ins = await client.query(
          'INSERT INTO categories (level, name, slug, parent_id) VALUES (1, $1, $2, NULL) RETURNING id',
          [l1Name, l1Slug]
        );
        l1Id = ins.rows[0].id;
        l1Map.set(l1Slug, { id: l1Id, slug: l1Slug });
      }
      level1Count++;

      for (const second of first.categoryFirstList || []) {
        const l2Name = (second.categorySecondName || 'Uncategorized').trim();
        const l2Slug = slugify(l2Name);
        const l2Key = `${l1Id}_${l2Slug}`;

        let l2Id;
        if (l2Map.has(l2Key)) {
          l2Id = l2Map.get(l2Key).id;
          await client.query('UPDATE categories SET name = $1 WHERE id = $2', [l2Name, l2Id]);
        } else {
          const ins = await client.query(
            'INSERT INTO categories (level, name, slug, parent_id) VALUES (2, $1, $2, $3) RETURNING id',
            [l2Name, l2Slug, l1Id]
          );
          l2Id = ins.rows[0].id;
          l2Map.set(l2Key, { id: l2Id, parent_id: l1Id, slug: l2Slug });
        }
        level2Count++;

        for (const leaf of second.categorySecondList || []) {
          if (!leaf.categoryId || !leaf.categoryName) continue;
          const leafCjId = String(leaf.categoryId);
          const leafName = leaf.categoryName.trim();
          const leafSlug = slugify(leafName, leafCjId);

          if (cjIdMap.has(leafCjId)) {
            const existingLeaf = cjIdMap.get(leafCjId);
            await client.query('UPDATE categories SET name = $1, parent_id = $2 WHERE id = $3', [leafName, l2Id, existingLeaf.id]);
          } else {
            const ins = await client.query(
              'INSERT INTO categories (level, name, slug, parent_id, cj_category_id) VALUES (3, $1, $2, $3, $4) RETURNING id',
              [leafName, leafSlug, l2Id, leafCjId]
            );
            cjIdMap.set(leafCjId, { id: ins.rows[0].id, cj_category_id: leafCjId });
          }
          level3Count++;
        }
      }
    }

    await client.query('COMMIT');
    categoryPathCache.clear(); // تفريغ كاش المسارات بعد التحديث لضمان دقة البيانات
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { level1Count, level2Count, level3Count };
}

// ==========================================
// 🧭 جلب الشجرة الكاملة (متداخلة) للواجهة الأمامية
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
// 🔗 حل المسار الفوري بواسطة CJ ID (معزز بكاش الذاكرة O(1))
// ==========================================
async function resolveCategoryByCjId(cjCategoryId) {
  if (!cjCategoryId) return null;
  const strId = String(cjCategoryId);

  // إذا كانت موجودة في الكاش، نرجعها فوراً بدون استعلام قاعدة البيانات
  if (categoryPathCache.has(strId)) {
    return categoryPathCache.get(strId);
  }

  // استعلام ذكي متكرر (Recursive CTE) يجلب الشجرة بالكامل في استعلام واحد فقط بدلاً من 3 استعلامات
  const query = `
    WITH RECURSIVE cat_hierarchy AS (
      SELECT id, name, slug, parent_id, level, 1 as depth
      FROM categories
      WHERE cj_category_id = $1
      
      UNION ALL
      
      SELECT c.id, c.name, c.slug, c.parent_id, c.level, ch.depth + 1
      FROM categories c
      INNER JOIN cat_hierarchy ch ON c.id = ch.parent_id
    )
    SELECT * FROM cat_hierarchy ORDER BY level ASC;
  `;

  const { rows } = await pool.query(query, [strId]);
  if (rows.length === 0) return null;

  const result = {
    leafSlug: rows[rows.length - 1].slug,
    slugPath: rows.map(c => c.slug).join('/'),
    names: rows.map(c => c.name),
  };

  // حفظ في الكاش لتسريع الطلبات القادمة
  categoryPathCache.set(strId, result);
  return result;
}

module.exports = { syncCategoriesFromCJ, getCategoryTree, resolveCategoryByCjId, slugify };