// backend/middleware/requireAdmin.js - Laclarc Enterprise Admin Guard
const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  // 1. قراءة التوكن من الكوكيز أولاً، أو من هيدر Authorization كـ Fallback
  let token = req.cookies?.admin_token;

  if (!token && req.headers['authorization']) {
    const parts = req.headers['authorization'].split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Access Denied: No authentication token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied: Administrative privileges required' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    // ✨ مسح الكوكي التالف بنفس الإعدادات الصارمة لمطابقة معايير المتصفحات الحديثة
    res.clearCookie('admin_token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    });
    
    return res.status(403).json({ error: 'Invalid or expired administrative token' });
  }
};
// ═══════════════════════════════════════════════════════════════
// 🛡️ ADMIN SURFACE ENFORCER — سياج مركزي (Defense in Depth)
// كل endpoint اسمه يبدأ بـ /api/admin/ لازم يكون محمياً بـ requireAdmin
// أو معلن كاستثناء صريح (login/logout + webhooks الموقعة)
// يُسجل كل محاولة وصول غير مصرح بها — Tenet #14
// ═══════════════════════════════════════════════════════════════
const ADMIN_PUBLIC_EXCEPTIONS = new Set([
  '/api/admin/login',
  '/api/admin/logout',
]);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/admin/') || ADMIN_PUBLIC_EXCEPTIONS.has(req.path)) {
    return next();
  }

  // تحقق مركزي — نفس منطق requireAdmin (JWT فقط)
  let token = req.cookies?.admin_token;
  if (!token && req.headers['authorization']) {
    const parts = req.headers['authorization'].split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') token = parts[1];
  }

  if (!token) {
    logger.logError('ADMIN-SURFACE VIOLATION', new Error(`${req.method} ${req.path} — IP: ${req.ip} — no token`));
    return res.status(401).json({ error: 'Access Denied: Administrative authentication required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      logger.logError('ADMIN-SURFACE VIOLATION', new Error(`${req.method} ${req.path} — IP: ${req.ip} — insufficient role`));
      return res.status(403).json({ error: 'Access Denied: Administrative privileges required' });
    }
    req.user = decoded;
    return next();
  } catch (err) {
    logger.logError('ADMIN-SURFACE VIOLATION', new Error(`${req.method} ${req.path} — IP: ${req.ip} — invalid token`));
    return res.status(403).json({ error: 'Access Denied: Invalid administrative token' });
  }
});