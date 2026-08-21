// utils/secureCheckout.js
// ✨ يمنع التلاعب بالأسعار والمتغيرات (variants) عند الدفع: يعيد حساب كل شيء
// من قاعدة البيانات بدل الوثوق بأي قيمة قادمة من المتصفح (item.price / item.vid / totalAmount).

async function prepareSecureItems(pool, clientItems) {
  if (!clientItems || !Array.isArray(clientItems) || clientItems.length === 0) {
    throw new Error('Cart is empty');
  }

  const secureItems = [];
  let serverTotal = 0;

  for (const item of clientItems) {
    // 1. نبحث عن المنتج في قاعدة البيانات باستخدام الـ ID فقط، ونجيب variants زادة
    const productRes = await pool.query(
      'SELECT id, title, price, image_url, variants FROM products WHERE id = $1 AND stock_status = true',
      [item.id]
    );

    if (productRes.rows.length === 0) {
      throw new Error(`Product ID ${item.id} not found or unavailable`);
    }

    const dbProduct = productRes.rows[0];

    // 2. نأخذ السعر الحقيقي من قاعدة البيانات وليس من المتصفح
    const realPrice = parseFloat(dbProduct.price);
    const quantity = Math.max(1, parseInt(item.quantity) || 1);

    // 3. ✨ إصلاح ثغرة أمنية حقيقية: نتحقق أن الـ vid (متغير المنتج: لون/مقاس) اللي
    //    بعثو المتصفح ينتمي فعلاً لهاذ المنتج بالذات (item.id)، وماشي لمنتج آخر.
    //
    //    قبل هاذ الإصلاح: الكود كان كياخذ item.vid مباشرة من المتصفح بلا أي تحقق.
    //    وحيت الطلب اللي كيتبعث لـ CJ (فـ fulfillCJOrder) فيه غير الـ vid بلا رقم
    //    المنتج، زبون خبيث كان يقدر يخلص على منتج رخيص (item.id = منتج بـ $9.99)
    //    ويبعث vid يخص منتج غالي بزاف عند CJ (بحال $80) — CJ توصل تشحن المنتج الغالي
    //    والزبون خلص غير ثمن الرخيص. دابا: الـ vid لازم يكون موجود فعلاً فقائمة
    //    variants ديال نفس المنتج المطلوب، وإلا كنرجعو لأول variant صالح فيه.
    let productVariants = [];
    if (dbProduct.variants) {
      try {
        productVariants = typeof dbProduct.variants === 'string'
          ? JSON.parse(dbProduct.variants)
          : dbProduct.variants;
      } catch (e) {
        productVariants = [];
      }
    }

    let safeVid = null;
    if (Array.isArray(productVariants) && productVariants.length > 0) {
      const requestedVid = item.vid;
      const matchedVariant = requestedVid
        ? productVariants.find((v) => String(v.vid) === String(requestedVid))
        : null;
      // إذا الـ vid المبعوث ماكانش صالح لهاذ المنتج، نرجعو لأول variant حقيقي فيه
      safeVid = matchedVariant ? matchedVariant.vid : productVariants[0].vid;
    }

    // 4. نضرب السعر في الكمية لحساب الإجمالي الحقيقي
    serverTotal += realPrice * quantity;

    // 5. نحفظ المنتج بالسعر والـ vid الحقيقيين (الاتنين من الداتابيز، ماشي من المتصفح)
    secureItems.push({
      id: dbProduct.id,
      title: dbProduct.title,
      image_url: dbProduct.image_url,
      price: realPrice,
      quantity,
      vid: safeVid
    });
  }

  return { secureItems, serverTotal: parseFloat(serverTotal.toFixed(2)) };
}

module.exports = { prepareSecureItems };