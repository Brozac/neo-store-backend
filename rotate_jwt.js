/**
 * node rotate_jwt.js — تدوير آمن لـ JWT_SECRET
 * Flow:
 *  1. توليد سر جديد قوي (64 hex)
 *  2. طباعة التعليمات (التحديث اليدوي في Render — آمن من الأخطاء)
 *  3. تنبيه: كل sessions (أدمن+زبائن) تنكسر → re-login جماعي مقبول
 * ⚠️ التدوير عملية إنسانية مقصودة — لا يتلقى التلقائي (كل من فقد مفتاحه يخسر كل شيء)
 */
const crypto = require('crypto');
const fs = require('fs');
const newSecret = crypto.randomBytes(48).toString('hex');

// 🩹 SECURITY-FIX (audit 2026-11-18 B-L10): السر الجديد كان كيتطبع فstdout
//   (يبقى فterminal history / CI logs). الإصلاح: يتكتب فملف بصلاحيات 0600 فقط.
const OUT = './jwt-secret-' + new Date().toISOString().slice(0, 10) + '.txt';
fs.writeFileSync(OUT, newSecret + '\n', { mode: 0o600 });
console.log(`🔐 JWT ROTATION FLOW — السر الجديد مكتوب في: ${OUT} (chmod 0600)`);

console.log(`
🔐 JWT ROTATION FLOW — خطوات التنفيذ:

1. افتح الملف ${OUT} وانسخ السر (الملف بصلاحيات 0600 — لصاحب الماكينة فقط)

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