// backfill_videos.js - Tier-1 video backfill (queryVideosByProductId)
// Usage: node backfill_videos.js  (VIDEO_BACKFILL_LIMIT env optional, default 150)
require('dotenv').config();
const p = require('./db');
const { cjRequest } = require('./services/cjService');
const axios = require('axios');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
const LIMIT = parseInt(process.env.VIDEO_BACKFILL_LIMIT, 10) || 150;
const SLEEP_MS = 1300; // QPS=1

(async () => {
  const { rows } = await p.query(
    'SELECT id, cj_product_id, title FROM products WHERE cj_product_id IS NOT NULL AND (video_url IS NULL OR video_url = \'\') AND shipping_blocked = false ORDER BY is_sourced DESC NULLS LAST, sort_order ASC NULLS LAST, id DESC LIMIT $1',
    [LIMIT]
  );
  console.log('Video Backfill - ' + rows.length + ' products (Tier-1)\n');

  let found = 0, miss = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    await new Promise(r => setTimeout(r, SLEEP_MS));
    try {
      const res = await cjRequest((token, config) =>
        axios.post(CJ_API + '/product/queryVideosByProductId',
          { productId: String(row.cj_product_id) },
          { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 8000 }
        )
      );
      const ok = res.data && (res.data.code === 0 || res.data.code === 200 || res.data.success === true);
      const url = ok && Array.isArray(res.data.data) && res.data.data.length > 0
        ? (res.data.data[0].videoUrl || '') : '';

      if (url) {
        await p.query('UPDATE products SET video_url = $1, has_video = true WHERE id = $2', [url, row.id]);
        found++;
        console.log('[OK] ' + (i+1) + '/' + rows.length + ' ' + String(row.title).slice(0, 45));
      } else {
        miss++;
        console.log('[--] ' + (i+1) + '/' + rows.length + ' no video: ' + String(row.title).slice(0, 40));
      }
    } catch (e) {
      fail++;
      console.warn('[ERR] ' + (i+1) + ' ' + String(e.message || '').slice(0, 60));
    }
  }

  console.log('\n=====================');
  console.log('found: ' + found + ' | no-video: ' + miss + ' | failed: ' + fail);
  console.log('Reels library now: ' + (5 + found) + ' videos');
  await p.end();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
