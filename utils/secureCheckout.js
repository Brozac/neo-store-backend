// utils/secureCheckout.js
// ✨ يمنع التلاعب بالأسعار عند الدفع: يعيد حساب كل شيء من قاعدة البيانات
// بدل الوثوق بالأسعار القادمة من المتصفح (item.price / totalAmount).

async function prepareSecureItems(pool, clientItems) {
  if (!clientItems || !Array.isArray(clientItems) || clientItems.length === 0) {
    throw new Error('Cart is empty');
  }

  const secureItems = [];
  let serverTotal = 0;

  for (const item of clientItems) {
    // 1. نبحث عن المنتج في قاعدة البيانات باستخدام الـ ID فقط
    const productRes = await pool.query(
      'SELECT id, title, price, image_url FROM products WHERE id = $1 AND stock_status = true',
      [item.id]
    );

    if (productRes.rows.length === 0) {
      throw new Error(`Product ID ${item.id} not found or unavailable`);
    }

    const dbProduct = productRes.rows[0];

    // 2. نأخذ السعر الحقيقي من قاعدة البيانات وليس من المتصفح
    const realPrice = parseFloat(dbProduct.price);
    const quantity = Math.max(1, parseInt(item.quantity) || 1);

    // 3. نضرب السعر في الكمية لحساب الإجمالي الحقيقي
    serverTotal += realPrice * quantity;

    // 4. نحفظ المنتج بالسعر الحقيقي لاستخدامه لاحقاً في قاعدة البيانات و Stripe/Paysera/CJ
    secureItems.push({
      id: dbProduct.id,
      title: dbProduct.title,
      image_url: dbProduct.image_url,
      price: realPrice,
      quantity,
      vid: item.vid || null
    });
  }

  return { secureItems, serverTotal: parseFloat(serverTotal.toFixed(2)) };
}

module.exports = { prepareSecureItems };