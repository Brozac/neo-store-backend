// node tools/cj-sign-calibrator.js '<rawBody>' '<signHeader>' [openId]
const crypto = require('crypto');
const [, , rawBody, sign, openIdArg] = process.argv;
const apiKey = process.env.CJ_API_KEY;
const openId = openIdArg || process.env.CJ_OPEN_ID || '';
const candidates = [];
const add = (name, val) => candidates.push({ name, val });

for (const [label, key] of [['apiKey', apiKey], ['openId', openId]]) {
  if (!key) continue;
  const h = (alg, msg) => crypto.createHmac(alg, key).update(msg);
  add(`HMAC-SHA256(${label}, body) hex`, h('sha256', rawBody).digest('hex'));
  add(`HMAC-SHA256(${label}, body) HEX`, h('sha256', rawBody).digest('hex').toUpperCase());
  add(`HMAC-SHA256(${label}, body) b64`, h('sha256', rawBody).digest('base64'));
  add(`HMAC-SHA256(${label}, body) b64url`, h('sha256', rawBody).digest('base64url'));
  if (openId) {
    const msg = Buffer.concat([Buffer.from(openId), rawBody]);
    add(`HMAC-SHA256(${label}, openId+body) hex`, h('sha256', msg).digest('hex'));
    add(`HMAC-SHA256(${label}, openId+body) b64`, h('sha256', msg).digest('base64'));
  }
  add(`HMAC-MD5(${label}, body) hex`, h('md5', rawBody).digest('hex'));
}
add('SHA256(body+apiKey)', crypto.createHash('sha256').update(Buffer.concat([rawBody, Buffer.from(apiKey)])).digest('hex'));
add('SHA256(apiKey+body)', crypto.createHash('sha256').update(Buffer.concat([Buffer.from(apiKey), rawBody])).digest('hex'));
add('MD5(body+apiKey)', crypto.createHash('md5').update(Buffer.concat([rawBody, Buffer.from(apiKey)])).digest('hex'));

const hit = candidates.find(c => c.val === String(sign).trim());
console.log(hit ? `✅ MATCH: ${hit.name}\n   ${hit.val}` : `❌ حتى مطابقة من ${candidates.length} — صيفط ليا sign+body كاملين للتحليل`);