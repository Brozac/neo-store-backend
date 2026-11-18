// utils/couponHelper.js
// ✨ Helper موحد: تصادق الكوبون وتطبيقه على المجموع الآمن (Server-Side Only)
//
// 🩹 SECURITY-FIX (audit 2026-11-18 B-M5): كان الفحص is_active فقط — كوبون نشط يعمل
//   للأبد وبلا سقف استعمال. الإصلاح:
//   · expires_at (nullable) — منتهي الصلاحية = مرفوض
//   · max_uses / used_count (nullable) — سقف استعمال مع حجز ذري (race-safe)
//   الأعمدة الجديدة nullable → الكوبونات القديمة تخدم بلا تغيير (NULL = بلا حد).
//   دلالة used_count: يحجز عند إنشاء الطلب (checkout/manual) — إعادة المحاولة
//   بتغيير الدفع تحجز أكثر من مرة (سلوك موثق في تقرير الإصلاح).
async function applyCouponToTotal(pool, code, secureTotal) {
  const fail = { total: secureTotal, applied: false, discount: 0, clamped: false, coupon: null };
  if (!code || typeof secureTotal !== 'number' || secureTotal <= 0) return fail;
  const cleanCode = String(code).toUpperCase().trim().slice(0, 50);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coupons
       WHERE code = $1
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (max_uses IS NULL OR used_count < max_uses)`,
      [cleanCode]
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

    // 🩹 B-M5 — حجز ذري للاستعمال: يتزاحم 2Checkout على آخر استعمال متاح، واحد برك يربح.
    //   يشتغل فقط إذا العمود used_count موجود (migration) — إلا لا، نسكت (توافق مع DB قديم).
    if (coupon.max_uses !== undefined && coupon.max_uses !== null) {
      const reserved = await pool.query(
        `UPDATE coupons SET used_count = used_count + 1
         WHERE code = $1 AND (max_uses IS NULL OR used_count < max_uses)
         RETURNING id`,
        [cleanCode]
      );
      if (reserved.rows.length === 0) return fail;
    }

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
