// syncCats.js - Quick CJ Category Tree Syncer
require('dotenv').config();
const pool = require('./db');
const { syncCategoriesFromCJ } = require('./services/categoryService');

(async () => {
  try {
    console.log('\n⏳ Starting high-speed category sync to Neon DB...');
    const result = await syncCategoriesFromCJ();
    console.log('🎉 Categories Synced Successfully:', result);
  } catch (err) {
    console.error('❌ Sync Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
    process.exit(0);
  }
})();