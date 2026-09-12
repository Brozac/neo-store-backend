'use strict';
// fix_autoheal.js — المرحلة 1: إصلاح الشحن الأوتوماتيكي (1.13+1.14)
//   [A] autoRepairLogistics() فـ cjService + export
//   [B] الوقاية: fulfillCJOrder يصلح فوراً ملي logisticsMiss=true
//   [C] العلاج: كرون التتبع يكشف العالقين CREATED (>2س) ويصلحهم + إيميل عند الفشل
const fs = require('fs'), vm = require('vm');
const C = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjService.js';
const S = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\server.js';
let cs = fs.readFileSync(C, 'utf8');
let sv = fs.readFileSync(S, 'utf8');
const csB = cs, svB = sv;
const EOL_C = cs.includes('\r\n') ? '\r\n' : '\n';
const EOL_S = sv.includes('\r\n') ? '\r\n' : '\n';
const problems = [];

// ===== [A1] autoRepairLogistics — قبل module.exports =====
if (cs.includes('async function autoRepairLogistics')) {
  console.log('SKIP [A1] autoRepairLogistics موجود');
} else {
  const anchor = 'module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric };';
  if (!cs.includes(anchor)) { console.log('FAIL [A1] export anchor'); problems.push('A1'); }
  else {
    const fn = [
      '// ==========================================',
      '// \ud83e\udd16 autoRepairLogistics \u2014 1.13 + 1.14: bind cheapest available shipping',
      '// for orders stuck at CREATED with logisticsMiss (no logistics bound at CJ)',
      '// ==========================================',
      'async function autoRepairLogistics(cjOrderCode) {',
      '  try {',
      '    if (!cjOrderCode) return { repaired: false, reason: \'no_order_code\' };',
      '    const opt = await cjRequest((token) =>',
      '      axios.get(CJ_API + \'/shopping/order/getOrderLogisticsInfo\', {',
      '        params: { orderCode: cjOrderCode },',
      '        headers: { \'CJ-Access-Token\': token },',
      '      })',
      '    );',
      '    if (opt.data?.code !== 200) return { repaired: false, reason: \'query_\' + opt.data?.code };',
      '    const list = Array.isArray(opt.data.data) ? opt.data.data : [];',
      '    if (!list.length) return { repaired: false, reason: \'no_options\' };',
      '',
      '    const eligible = list.filter(function (o) { return o.hasStock !== false; });',
      '    if (!eligible.length) return { repaired: false, reason: \'no_stock_options\' };',
      '    const cheapest = eligible.slice().sort(function (a, b) { return a.postage - b.postage; })[0];',
      '',
      '    const tryFrom = (from) => cjRequest((token) =>',
      '      axios.post(CJ_API + \'/shopping/order/updateLogistics\',',
      '        { id: cheapest.id, orderCode: cjOrderCode, logisticsName: cheapest.logisticsName, from: from },',
      '        { headers: { \'CJ-Access-Token\': token, \'Content-Type\': \'application/json\' } })',
      '    );',
      '    let mod = await tryFrom(1); // 1 = complete order',
      '    if (mod.data?.code !== 200) mod = await tryFrom(0); // fallback: incomplete',
      '    if (mod.data?.code !== 200) return { repaired: false, reason: \'modify_\' + mod.data?.code };',
      '    return { repaired: true, logisticsName: cheapest.logisticsName, postage: cheapest.postage };',
      '  } catch (e) {',
      '    logger.logError(\'autoRepairLogistics\', e);',
      '    return { repaired: false, reason: e.message };',
      '  }',
      '}',
      ''
    ].join(EOL_C);
    cs = cs.replace(anchor, fn + anchor);
    console.log('OK   [A1] autoRepairLogistics محقونة');
  }
}

// ===== [A2] export =====
{
  const OLD = 'module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric };';
  const NEW = 'module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert };';
  if (cs.includes(NEW)) console.log('SKIP [A2] export');
  else if (!cs.includes(OLD)) { console.log('FAIL [A2] export line'); problems.push('A2'); }
  else { cs = cs.split(OLD).join(NEW); console.log('OK   [A2] exports + autoRepairLogistics + sendAdminAlert'); }
}

// ===== [B] الوقاية فـ fulfillCJOrder: logisticsMiss → إصلاح فوري =====
{
  const anchor = "successfulCJOrderNumber = extractCjNumber(cjResponse.data?.data) || targetOrderNumber;";
  if (!cs.includes(anchor)) { console.log('FAIL [B] fulfill anchor'); problems.push('B'); }
  else if (cs.includes('logisticsMiss === true')) console.log('SKIP [B] prevention موجود');
  else {
    const inject = [
      anchor,
      '          if (cjResponse.data?.data?.logisticsMiss === true) {',
      '            // \ud83e\udd16 logisticsMiss: CJ ma-kan-sh binda shipping — auto-repair tawa (1.13+1.14)',
      '            console.warn(\'[CJ] #\' + orderId + \' logisticsMiss=true — auto-repair...\');',
      '            const rep = await autoRepairLogistics(successfulCJOrderNumber);',
      '            if (rep.repaired) console.log(\'[CJ] #\' + orderId + \' logistics bound: \' + rep.logisticsName + \' ($\' + rep.postage + \')\');',
      '            else console.warn(\'[CJ] #\' + orderId + \' auto-repair failed: \' + rep.reason);',
      '          }'
    ].join(EOL_C);
    cs = cs.split(anchor).join(inject);
    console.log('OK   [B] الوقاية فـ fulfillCJOrder (logisticsMiss → repair فوري)');
  }
}

// ===== [C1] import فـ server.js =====
{
  const OLD = "const { fulfillCJOrder, cjRequest, parseNumeric } = require('./services/cjService');";
  const NEW = "const { fulfillCJOrder, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert } = require('./services/cjService');";
  if (sv.includes(NEW)) console.log('SKIP [C1] import');
  else if (!sv.includes(OLD)) { console.log('FAIL [C1] import anchor'); problems.push('C1'); }
  else { sv = sv.split(OLD).join(NEW); console.log('OK   [C1] import autoRepairLogistics + sendAdminAlert'); }
}

// ===== [C2] كرون التتبع: SELECT + created_at =====
{
  const OLD = 'SELECT id, status, customer_name, customer_email, customer_phone, total_amount, cj_order_number';
  const NEW = 'SELECT id, status, customer_name, customer_email, customer_phone, total_amount, cj_order_number, created_at';
  if (sv.includes(NEW)) console.log('SKIP [C2] SELECT');
  else {
    const cnt = sv.split(OLD).length - 1;
    if (cnt !== 1) { console.log('FAIL [C2] occurrences=' + cnt); problems.push('C2'); }
    else { sv = sv.split(OLD).join(NEW); console.log('OK   [C2] SELECT + created_at'); }
  }
}

// ===== [C3] فرع CREATED العالق — قبل فرع DELIVERED =====
{
  const anchor = "} else if (status === 'DELIVERED') {";
  if (sv.includes("status === 'CREATED' && !d.logisticName && !d.paymentDate")) {
    console.log('SKIP [C3] فرع CREATED موجود');
  } else {
    const cnt = sv.split(anchor).length - 1;
    if (cnt !== 1) { console.log('FAIL [C3] DELIVERED anchor occurrences=' + cnt); problems.push('C3'); }
    else {
      const branch = [
        "} else if (status === 'CREATED' && !d.logisticName && !d.paymentDate) {",
        "        // \ud83e\udd16 \u0637\u0644\u0628 \u0639\u0627\u0644\u0642: CREATED \u0628\u0644\u0627 \u0634\u062d\u0646 \u0628\u0644\u0627 \u062f\u0641\u0639 — auto-repair \u0625\u0644\u0627 \u0639\u062f\u0627 2\u0633",
        "        const ageMs = order.created_at ? Date.now() - new Date(order.created_at).getTime() : 0;",
        "        if (ageMs > 2 * 3600 * 1000) {",
        "          const rep = await autoRepairLogistics(d.cjOrderCode || key);",
        "          if (rep.repaired) {",
        "            console.log('[AutoHeal] #' + order.id + ': shipping bound ' + rep.logisticsName + ' ($' + rep.postage + ')');",
        "          } else if (!global['_cjStuck_' + order.id]) {",
        "            global['_cjStuck_' + order.id] = true;",
        "            sendAdminAlert(",
        "              '[CJ] Stuck order (no logistics) #' + order.id + ' - ' + (d.cjOrderCode || key),",
        "              '<p>Status CREATED, no logistics, no payment at CJ. Auto-repair failed: ' + rep.reason + '</p>'",
        "            );",
        "          }",
        "        }"
      ].join(EOL_S);
      sv = sv.split(anchor).join(branch + EOL_S + anchor);
      console.log('OK   [C3] كرون: كتاشف العالقين + auto-heal + إيميل dedup');
    }
  }
}

fs.writeFileSync(C, cs, 'utf8');
fs.writeFileSync(S, sv, 'utf8');

console.log('\n[syntax]:');
try { new vm.Script(cs, { filename: 'cjService.js' }); console.log('  OK   cjService.js'); }
catch (e) { console.log('  BAD  ' + e.message); fs.writeFileSync(C, csB, 'utf8'); problems.push('syntax-cs'); }
try { new vm.Script(sv, { filename: 'server.js' }); console.log('  OK   server.js'); }
catch (e) { console.log('  BAD  ' + e.message); fs.writeFileSync(S, svB, 'utf8'); problems.push('syntax-sv'); }

console.log('\n========== RESULT ==========');
console.log(problems.length ? '⚠️ PROBLEMS: ' + problems.join(' | ') + ' — صيفط الـ output' : '✅ FIXED — commit & push');