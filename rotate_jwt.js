/**
 * node rotate_jwt.js — تدوير آمن لـ JWT_SECRET
 * Flow:
 *  1. توليد سر جديد قوي (64 hex)
 *  2. طباعة التعليمات (التحديث اليدوي في Render — آمن من الأخطاء)
 *  3. تنبيه: كل sessions (أدمن+زبائن) تنكسر → re-login جماعي مقبول
 * ⚠️ التدوير عملية إنسانية مقصودة — لا يتلقى التلقائي (كل من فقد مفتاحه يخسر كل شيء)
 */
const crypto = require('crypto');
const newSecret = crypto.randomBytes(48).toString('hex');

console.log(`
🔐 JWT ROTATION FLOW — خطوات التنفيذ:

1. انسخ السر الجديد:
   ${newSecret}

2. Render → neo-store-backend → Environment → JWT_SECRET → بدّل القيمة
3. Manual Deploy
4. النتيجة: كل الـ JWTs القديمة (أدمن + زبائن) تنكسر → 401 تلقائي
   → المستخدمون يعملوا login من جديد (مقبول أمنياً)

5. بعد التدوير — تحقق:
   curl -X POST https://neo-store-backend.onrender.com/api/admin/login \\
     -H "Content-Type: application/json" -d '{"email":"...","password":"..."}'
   → لازم يعطي token جديد بالسر الجديد

⚠️ لا تشارك السر في أي channel — Render env فقط.
`);