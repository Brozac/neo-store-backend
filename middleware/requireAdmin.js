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
