// backend/logger.js
const fs = require('fs');
const path = require('path');

module.exports = {
  logError: (context, error) => {
    const logMessage = `[${new Date().toISOString()}] ERROR in ${context}: ${error.message || error}\n`;
    fs.appendFileSync(path.join(__dirname, 'errors.log'), logMessage);
    console.error(logMessage); // اطبعها في الكونسول أيضاً
  }
};