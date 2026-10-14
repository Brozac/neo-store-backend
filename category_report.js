require('dotenv').config();
const p = require('./db');

const q = `
SELECT
  COALESCE(NULLIF(split_part(category, '/', 1), ''), '(NO_CATEGORY)') AS l1_main,
  COALESCE(NULLIF(split_part(category, '/', 2), ''), '(direct)') AS l2_sub,
  COUNT(*)::int AS products
FROM products
WHERE stock_status = true
GROUP BY 1, 2
ORDER BY 1, 3 DESC
`;

p.query(q)
.then(r => {
  const grouped = {};
  r.rows.forEach(row => {
    if (!grouped[row.l1_main]) grouped[row.l1_main] = { total: 0, subs: [] };
    grouped[row.l1_main].total += row.products;
    grouped[row.l1_main].subs.push(`${row.l2_sub}: ${row.products}`);
  });

  const keys = Object.keys(grouped).sort((a, b) => grouped[b].total - grouped[a].total);
  keys.forEach(l1 => {
    const g = grouped[l1];
    const status = g.total >= 1000 ? '🟢' : g.total >= 100 ? '🟡' : '🔴';
    console.log(`\n${status} ${l1.toUpperCase()} — ${g.total} منتج`);
    g.subs.slice(0, 8).forEach(s => console.log(`   └─ ${s}`));
    if (g.subs.length > 8) console.log(`   ... +${g.subs.length - 8} أخرى`);
  });

  console.log(`\n📊 الإجمالي: ${keys.length} قسم L1 · ${r.rows.length} فئة فرعية`);
  return p.end();
})
.catch(e => { console.error('❌', e.message); process.exit(1); });
