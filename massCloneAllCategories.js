// massCloneAllCategories.js - Laclarc Enterprise Mass Clone Engine
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pool = require('./db');
const { cjRequest } = require('./services/cjService');
const { buildProductRow, upsertProductRow } = require('./services/productImportService');

const PROGRESS_FILE = path.join(__dirname, '.clone-progress.json');

// قراءة مكان التوقف السابق إن وجد
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return data.lastCompletedIndex || 0;
    }
  } catch (e) {}
  return 0;
}

// حفظ التقدم لحظياً بعد كل قسم
function saveProgress(index, categoryName) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
      lastCompletedIndex: index,
      lastCategoryName: categoryName,
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {}
}

let isTerminating = false;

// التقاط أمر الإيقاف Ctrl+C لحفظ الموقع بأمان
process.on('SIGINT', async () => {
  if (isTerminating) process.exit(0);
  console.log('\n\n⏳ Pausing Mass Clone safely... Progress is saved. You can resume anytime!');
  isTerminating = true;
  await pool.end();
  process.exit(0);
});

async function runMassClone() {
  console.log(`\n==================================================`);
  console.log(`🚀 Laclarc Enterprise Mass Clone Engine (Resumable)`);
  console.log(`==================================================\n`);

  try {
    // 1. جلب جميع الأقسام التحتية من قاعدة البيانات
    const catsRes = await pool.query(
      "SELECT cj_category_id, name, slug FROM categories WHERE level = 3 AND cj_category_id IS NOT NULL ORDER BY id ASC"
    );
    const categories = catsRes.rows;

    if (categories.length === 0) {
      console.log('⚠️ No Level 3 categories found. Please run category sync first!');
      process.exit(0);
    }

    const startIndex = loadProgress();
    if (startIndex > 0 && startIndex < categories.length) {
      console.log(`🔄 Resuming clone from category #${startIndex + 1}: "${categories[startIndex].name}"...`);
    } else {
      console.log(`🎯 Starting fresh clone for ${categories.length} categories...`);
    }

    let totalImported = 0;

    // 2. المرور على الأقسام انطلاقاً من نقطة التوقف
    for (let i = startIndex; i < categories.length; i++) {
      if (isTerminating) break;

      const category = categories[i];
      const percent = (((i + 1) / categories.length) * 100).toFixed(1);
      console.log(`\n📂 [${i + 1}/${categories.length} - ${percent}%] Category: ${category.name} (${category.slug})`);

      const pagesToFetch = 2; // صفحتان (40 منتجاً كحد أقصى لكل قسم تحتي)
      let categoryImported = 0;

      for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
        if (isTerminating) break;

        try {
          await new Promise(r => setTimeout(r, 1200)); // احترام معدل QPS=1

          const listRes = await cjRequest((token, config) =>
            axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
              ...config,
              headers: { 'CJ-Access-Token': token },
              params: { pageNum, pageSize: 20, categoryId: category.cj_category_id }
            })
          );

          const cjProducts = listRes.data?.data?.list || [];
          if (cjProducts.length === 0) break;

          for (const cjItem of cjProducts) {
            if (isTerminating) break;

            const productId = cjItem.pid ? String(cjItem.pid) : null;
            if (!productId) continue;

            try {
              await new Promise(r => setTimeout(r, 1200));

              const detailRes = await cjRequest((token, config) =>
                axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
                  ...config,
                  headers: { 'CJ-Access-Token': token },
                  params: { pid: productId }
                })
              );

              const details = detailRes.data?.data;
              if (!details) continue;

              // ✨ استخدام خيارات الاستيراد الصحيحة (مع تعطيل الفيديو لتسريع النسخ مرتين)
              const productRow = await buildProductRow(details, {
                fallbackCategoryId: category.cj_category_id,
                fetchVideo: false,
                isSourced: false
              });

              if (productRow) {
                await upsertProductRow(pool, productRow);
                totalImported++;
                categoryImported++;
              }
            } catch (productErr) {
              // تخطي أي منتج يتعثر والتقدم دون إيقاف السكربت
            }
          }
        } catch (pageErr) {
          console.warn(`⚠️ Warning: Failed to fetch page ${pageNum} for ${category.name}. Skipping page.`);
        }
      }

      console.log(`✅ Completed "${category.name}". (${categoryImported} products imported).`);
      saveProgress(i + 1, category.name);
    }

    if (!isTerminating) {
      console.log(`\n==================================================`);
      console.log(`🎉 ALL CATEGORIES CLONED SUCCESSFULLY!`);
      console.log(`Total Products Synced: ${totalImported}`);
      console.log(`==================================================\n`);
      // حذف ملف التقدم عند اكتمال كامل الأقسام
      if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
    }

  } catch (err) {
    console.error('❌ Fatal error in Mass Clone execution:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

runMassClone();