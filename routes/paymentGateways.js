const express = require('express');
const router = express.Router();
const pool = require('../db');
const requireAdmin = require('../middleware/requireAdmin');

let gatewaysCache = null;
let cacheExpiry = 0;

async function getGatewaysFromDb() {
  const { rows } = await pool.query('SELECT gateway_key, display_name, enabled FROM payment_gateways ORDER BY id ASC');
  return rows;
}

// GET public
router.get('/api/payment/gateways', async (req, res) => {
  try {
    const now = Date.now();
    if (!gatewaysCache || now > cacheExpiry) {
      gatewaysCache = await getGatewaysFromDb();
      cacheExpiry = now + 30000;
    }
    const enabledKeys = gatewaysCache.filter(g => g.enabled).map(g => g.gateway_key);
    res.json({ enabled: enabledKeys });
  } catch (err) {
    res.json({ enabled: ['stripe', 'paysera', 'crypto', 'baridimob'] });
  }
});

// GET admin
router.get('/api/admin/payment-gateways', requireAdmin, async (req, res) => {
  try {
    const rows = await getGatewaysFromDb();
    // ✨ نرجع المصفوفة مباشرة لتتطابق مع الواجهة الأمامية
    res.json(rows); 
  } catch (err) {
    console.error('Error fetching admin payment gateways:', err);
    res.status(500).json({ error: 'Failed to fetch payment gateways.' });
  }
});

// PATCH admin
router.patch('/api/admin/payment-gateways/:key', requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }

  try {
    const { rows } = await pool.query(
      'UPDATE payment_gateways SET enabled = $1, updated_at = NOW() WHERE gateway_key = $2 RETURNING gateway_key, display_name, enabled',
      [enabled, key]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Payment gateway not found.' });
    }

    gatewaysCache = null;
    res.json(rows[0]);
  } catch (err) {
    console.error('Error updating payment gateway:', err);
    res.status(500).json({ error: 'Failed to update payment gateway.' });
  }
});

module.exports = router;