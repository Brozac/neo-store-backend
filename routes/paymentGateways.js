const express = require('express');
const router = express.Router();
const pool = require('../db'); // adapte le chemin vers ton pool pg existant
const requireAdmin = require('../middleware/requireAdmin');

// Cache mémoire simple pour éviter de taper la DB à chaque ouverture du modal checkout
let gatewaysCache = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000;

async function getGatewaysFromDb() {
  const { rows } = await pool.query(
    'SELECT gateway_key, display_name, enabled FROM payment_gateways ORDER BY id ASC'
  );
  return rows;
}

// GET public — consommé par PaymentModal.tsx côté storefront
router.get('/api/payment/gateways', async (req, res) => {
  try {
    const now = Date.now();
    if (!gatewaysCache || now > cacheExpiry) {
      gatewaysCache = await getGatewaysFromDb();
      cacheExpiry = now + CACHE_TTL_MS;
    }
    const enabledKeys = gatewaysCache.filter(g => g.enabled).map(g => g.gateway_key);
    res.json({ enabled: enabledKeys });
  } catch (err) {
    console.error('Error fetching payment gateways:', err);
    // Fail-open : si la DB tombe, on affiche tout plutôt que de bloquer le checkout
    res.json({ enabled: ['stripe', 'paysera', 'crypto', 'baridimob'] });
  }
});

// GET admin — liste complète avec statut, pour la page settings
router.get('/api/admin/payment-gateways', requireAdmin, async (req, res) => {
  try {
    const rows = await getGatewaysFromDb();
    res.json({ gateways: rows });
  } catch (err) {
    console.error('Error fetching admin payment gateways:', err);
    res.status(500).json({ error: 'Failed to fetch payment gateways.' });
  }
});

// PATCH admin — toggle une gateway
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

    gatewaysCache = null; // invalide le cache public direct

    res.json({ success: true, gateway: rows[0] });
  } catch (err) {
    console.error('Error updating payment gateway:', err);
    res.status(500).json({ error: 'Failed to update payment gateway.' });
  }
});

module.exports = router;