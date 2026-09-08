// backend/services/whatsappService.js - Laclarc Automated WhatsApp Engine
const axios = require('axios');
const logger = require('../logger');

// ✨ دالة لتنظيف وتوحيد أرقام الهواتف للصيغة الدولية (E.164)
function formatToInternationalPhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/\D/g, ''); // إزالة كل الرموز والمسافات

  // معالجة الأرقام الجزائرية (مثال: 0555... أو 0666... تحول إلى 213555...)
  if (cleaned.startsWith('0') && (cleaned.length === 10)) {
    cleaned = '213' + cleaned.substring(1);
  }

  // إذا لم يحتوي على كود دولة افتراضي وكان 9 أرقام، نرجح أنه جزائري
  if (cleaned.length === 9) {
    cleaned = '213' + cleaned;
  }

  return cleaned.length >= 8 ? cleaned : null;
}

/**
 * إرسال رسالة تتبع الطلب التلقائية للزبون عبر WhatsApp
 */
async function sendOrderTrackingWhatsApp({ phone, customerName, orderId, trackingNumber, email }) {
  const cleanPhone = formatToInternationalPhone(phone);
  if (!cleanPhone) {
    console.warn(`⚠️ [WhatsApp Engine] Skipped: Invalid phone format for Order #${orderId}`);
    return false;
  }

  const frontendUrl = process.env.FRONTEND_URL || 'https://laclarc.com';
  const trackingLink = `${frontendUrl}/track-order?orderId=${orderId}&email=${encodeURIComponent(email || '')}`;
  
  const customerFirstName = (customerName || 'Valued Customer').split(' ')[0];

  // نص الرسالة الاحترافي بلغتين (العربية والإنجليزية لضمان وصول المعنى لأي زبون)
  const messageText = 
`🎉 *Great news from Laclarc!*
Hello ${customerFirstName}, your order *#${orderId}* has officially been shipped and is on its way to you! ✈️

📦 *Tracking Number:* ${trackingNumber}
🚚 *Track Your Parcel Live:* 
${trackingLink}

---
مرحباً ${customerFirstName}، تم شحن طلبك رقم *#${orderId}* من متجر Laclarc بنجاح وهو في طريقه إليك الآن! 
يمكنك تتبع حركة الشحنة خطوة بخطوة عبر الرابط أعلاه.

Thank you for choosing *Laclarc*! ✨`;

  // 1. الإرسال الرسمي عبر Meta WhatsApp Cloud API إذا توفرت المفاتيح
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

  if (WHATSAPP_TOKEN && WHATSAPP_PHONE_ID) {
    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanPhone,
          type: 'text',
          text: { body: messageText }
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`📲 [WhatsApp Sent] Official tracking notification dispatched to +${cleanPhone}`);
      return true;
    } catch (apiErr) {
      logger.logError('WhatsApp Cloud API Dispatch', apiErr.response?.data || apiErr.message);
    }
  }

  // 2. تسجيل رابط الإرسال المباشر في السجلات (Fallback)
  console.log(`💬 [WhatsApp Direct Link Generated for Order #${orderId}]: https://wa.me/${cleanPhone}?text=${encodeURIComponent(messageText)}`);
  return true;
}

module.exports = { sendOrderTrackingWhatsApp, formatToInternationalPhone };