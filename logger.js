// backend/logger.js
// ✨ إصلاحات:
// 1. كنا نستعملو fs.appendFileSync (متزامن) — كيوقف الـ event loop ديال Node
//    كامل لكل خطأ يتسجل، وتحت ضغط (بزاف أخطاء فوقت قصير) هذا يبطّئ السيرفر كامل.
//    دابا نستعملو fs.appendFile (async) بلا ما ننتظروه.
// 2. الكتابة فملف محلي (errors.log) هي غير نسخة احتياطية: على منصات زي Render،
//    الـ disk ephemeral — الملف كيتمسح مع كل redeploy/restart. الكونسول (console.error)
//    هو المصدر الأساسي المضمون، حيت Render/معظم PaaS كيحتفظو بلوقات الكونسول.
//    إذا بغيتي لوقات دائمة عبر الـ deployments، استعمل خدمة خارجية (Sentry, Logtail, Better Stack...).
const fs = require('fs');
const path = require('path');

module.exports = {
  logError: (context, error) => {
    const detail = error?.stack || error?.message || String(error);
    const logMessage = `[${new Date().toISOString()}] ERROR in ${context}: ${detail}`;

    // المصدر الأساسي المضمون
    console.error(logMessage);

    // نسخة احتياطية محلية، بشكل async باش ما توقفش السيرفر
    fs.appendFile(path.join(__dirname, 'errors.log'), logMessage + '\n', (err) => {
      if (err) console.error('Failed to write to error log file:', err.message);
    });
  }
};