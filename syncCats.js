require('dotenv').config();
const { syncCategoriesFromCJ } = require('./services/categoryService');

(async () => {
  try {
    console.log('⏳ Syncing categories to Neon...');
    const result = await syncCategoriesFromCJ();
    console.log('✅ Categories synced!', result);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
})();