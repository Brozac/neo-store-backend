// utils/secureCheckout.js - Laclarc Bank-Grade Secure Checkout
// ✨ درع مالي محصن ضد: التلاعب بالأسعار، تفاوت أسعار المتغيرات، واستنزاف اتصالات قاعدة البيانات.

const MAX_ITEM_QUANTITY = 50; // أقصى كمية مسموح بها للمنتج الواحد في الطلب الفردي

// معادلة احتساب السعر الموحدة المطابقة لسياسة تسعير المتجر
function calculateSellPrice(cost) {
  const costNum = Number(cost) || 0;
  if (costNum <= 0) return 9.99;
  let sellingPrice = costNum <= 5 ? costNum * 3.5 : costNum <= 15 ? costNum * 2.8 : costNum <= 30 ? costNum * 2.2 : costNum * 1.8;
  sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
  return parseFloat(sellingPrice.toFixed(2));
}
// دالة خصم الكمية التلقائي للباقات (Tiered Pricing)
function applyTieredDiscount(price, quantity) {
  if (quantity >= 3) {
    return price * 0.75; // خصم 25% لـ 3 قطع فما فوق
  } else if (quantity >= 2) {
    return price * 0.85; // خصم 15% لقطعتين
  }
  return price;
}
// استبدال حساب السعر النهائي لدعم خصم الكمية:
const discountedUnitPrice = applyTieredDiscount(finalItemPrice, item.quantity);
const lineTotal = discountedUnitPrice * item.quantity;
serverTotal += lineTotal;

async function prepareSecureItems(pool, clientItems) {
  if (!clientItems || !Array.isArray(clientItems) || clientItems.length === 0) {
    throw new Error('Cart is empty');
  }

  // 1. تنظيف ودمج المنتجات المكررة في السلة (Consolidation)
  const consolidatedMap = new Map();
  for (const item of clientItems) {
    const rawId = parseInt(item.id, 10);
    if (!rawId || isNaN(rawId) || rawId <= 0) continue;

    const rawVid = item.vid ? String(item.vid).trim() : 'DEFAULT';
    const rawQty = Math.min(MAX_ITEM_QUANTITY, Math.max(1, parseInt(item.quantity, 10) || 1));
    const itemKey = `${rawId}_${rawVid}`;

    if (consolidatedMap.has(itemKey)) {
      const existing = consolidatedMap.get(itemKey);
      existing.quantity = Math.min(MAX_ITEM_QUANTITY, existing.quantity + rawQty);
    } else {
      consolidatedMap.set(itemKey, { id: rawId, vid: item.vid || null, quantity: rawQty });
    }
  }

  if (consolidatedMap.size === 0) {
    throw new Error('No valid items found in the cart');
  }

  const itemsToProcess = Array.from(consolidatedMap.values());
  const productIds = [...new Set(itemsToProcess.map(i => i.id))];

  // 2. استعلام ذري سريع يحل مشكلة N+1 ويجلب كل المنتجات دفعة واحدة
  const productRes = await pool.query(
    `SELECT id, title, price, image_url, variants 
     FROM products 
     WHERE id = ANY($1::int[]) AND stock_status = true`,
    [productIds]
  );

  if (productRes.rows.length === 0) {
    throw new Error('Requested products are currently unavailable');
  }

  const productMap = new Map(productRes.rows.map(p => [p.id, p]));
  const secureItems = [];
  let serverTotal = 0;

  // 3. التحقق من كل عنصر ومطابقة المتغيرات والتسعير
  for (const item of itemsToProcess) {
    const dbProduct = productMap.get(item.id);
    if (!dbProduct) {
      throw new Error(`Product #${item.id} is out of stock or does not exist`);
    }

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
    let finalItemPrice = parseFloat(dbProduct.price);

    if (Array.isArray(productVariants) && productVariants.length > 0) {
      const requestedVid = item.vid ? String(item.vid) : null;
      let matchedVariant = null;

      if (requestedVid) {
        matchedVariant = productVariants.find(v => String(v.vid) === requestedVid);
      }

      // إذا لم يتطابق الـ vid الممرر، نعتمد أول variant شرعي للمنتج
      if (!matchedVariant) {
        matchedVariant = productVariants[0];
      }

      safeVid = matchedVariant.vid || null;

      // ✨ حماية أرباح المتجر: إذا كان للمتغير سعر تكلفة أعلى في CJ، يتم اعتماد سعره الفعلي
      if (matchedVariant.variantSellPrice) {
        const variantCalculated = calculateSellPrice(matchedVariant.variantSellPrice);
        if (variantCalculated > finalItemPrice) {
          finalItemPrice = variantCalculated;
        }
      }
    }

    finalItemPrice = parseFloat(finalItemPrice.toFixed(2));
    const lineTotal = finalItemPrice * item.quantity;
    serverTotal += lineTotal;

    secureItems.push({
      id: dbProduct.id,
      title: dbProduct.title,
      image_url: dbProduct.image_url,
      price: finalItemPrice,
      quantity: item.quantity,
      vid: safeVid
    });
  }

  return {
    secureItems,
    serverTotal: parseFloat(serverTotal.toFixed(2))
  };
}

module.exports = { prepareSecureItems };