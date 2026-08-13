const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  // ✨ قراءة التوكن من الكوكيز بدلاً من الهيدر
  const token = req.cookies.admin_token;

  if (!token) {
    return res.status(403).json({ error: 'Access Denied: No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error('Not an admin');
    req.user = decoded;
    next();
  } catch (err) {
    res.clearCookie('admin_token'); // مسح الكوكي التالف
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};