// utils/couponHelper.js
// ✨ Helper موحد: تصادق الكوبون وتطبيقه على المجموع الآمن (Server-Side Only)
async function applyCouponToTotal(pool, code, secureTotal) {
  const fail = { total: secureTotal, applied: false, discount: 0, clamped: false, coupon: null };
  if (!code || typeof secureTotal !== 'number' || secureTotal <= 0) return fail;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coupons WHERE code = $1 AND is_active = true',
      [String(code).toUpperCase().trim().slice(0, 50)]
    );
    if (rows.length === 0) return fail;

    const coupon = rows[0];
    let discount = coupon.discount_type === 'percentage'
      ? (secureTotal * Number(coupon.discount_value)) / 100
      : Number(coupon.discount_value);

    if (!Number.isFinite(discount) || discount <= 0) return fail;

    // 🛡️ الحد الأدنى للدفع: Stripe/NowPayments كيرفضو أقل من $0.50
    const clamped = discount > secureTotal - 0.50;
    discount = Math.min(discount, Math.max(0, secureTotal - 0.50));

    return {
      total: parseFloat((secureTotal - discount).toFixed(2)),
      applied: true,
      discount: parseFloat(discount.toFixed(2)),
      clamped,
      coupon
    };
  } catch (err) {
    return fail; // ✅ Fail-closed: أي خطأ = بلا خصم (ماشي fail-open!)
  }
}

module.exports = { applyCouponToTotal };