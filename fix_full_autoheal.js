'use strict';
// fix_full_autoheal.js — Auto-Heal الكامل: repair → delete+recreate (1.8) → autopay (2.2)
// شامل كلشي حتى إلا fix_autoheal ما كانش داز (idempotent بالكامل)
const fs = require('fs'), vm = require('vm');
const C = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjService.js';
const S = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\server.js';
let cs = fs.readFileSync(C, 'utf8');
let sv = fs.readFileSync(S, 'utf8');
const csB = cs, svB = sv;
const EOL_C = cs.includes('\r\n') ? '\r\n' : '\n';
const EOL_S = sv.includes('\r\n') ? '\r\n' : '\n';
const problems = [];

// ===== [A1] autoRepairLogistics (1.13+1.14) — إلا ما كانش =====
if (cs.includes('async function autoRepairLogistics')) {
  console.log('SKIP [A1] autoRepairLogistics موجود');
} else {
  const anchor = 'module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric };';
  if (!cs.includes(anchor)) { console.log('FAIL [A1] export anchor'); problems.push('A1'); }
  else {
    const fn = [
      '// ==========================================',
      '// \ud83e\udd16 autoRepairLogistics - 1.13+1.14: bind cheapest available shipping to a stuck order',
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
      '    const eligible = list.filter(function (o) { return o.hasStock !== false; });',
      '    if (!eligible.length) return { repaired: false, reason: \'no_stock_options\' };',
      '    const cheapest = eligible.slice().sort(function (a, b) { return a.postage - b.postage; })[0];',
      '    const tryFrom = (from) => cjRequest((token) =>',
      '      axios.post(CJ_API + \'/shopping/order/updateLogistics\',',
      '        { id: cheapest.id, orderCode: cjOrderCode, logisticsName: cheapest.logisticsName, from: from },',
      '        { headers: { \'CJ-Access-Token\': token, \'Content-Type\': \'application/json\' } })',
      '    );',
      '    let mod = await tryFrom(1);',
      '    if (mod.data?.code !== 200) mod = await tryFrom(0);',
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
    console.log('OK   [A1] autoRepairLogistics');
  }
}

// ===== [A2] deleteCJOrder (1.8) + payCJOrderBalance (2.2) =====
if (cs.includes('async function deleteCJOrder')) {
  console.log('SKIP [A2] deleteCJOrder موجود');
} else {
  const anchor = 'module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric';
  const i = cs.indexOf(anchor);
  if (i === -1) { console.log('FAIL [A2] exports anchor'); problems.push('A2'); }
  else {
    const fn = [
      '// ==========================================',
      '// \ud83d\uddd1\ufe0f deleteCJOrder - 1.8: DELETE (CREATED/IN_CART only, per docs)',
      '// ==========================================',
      'async function deleteCJOrder(...candidates) {',
      '  for (const v of candidates.filter(Boolean)) {',
      '    try {',
      '      const res = await cjRequest((token) =>',
      '        axios.delete(CJ_API + \'/shopping/order/deleteOrder\', {',
      '          params: { orderId: String(v) },',
      '          headers: { \'CJ-Access-Token\': token },',
      '        })',
      '      );',
      '      if (res.data?.code === 200) return { ok: true };',
      '    } catch (e) { /* next candidate */ }',
      '  }',
      '  return { ok: false, reason: \'delete_failed_all_candidates\' };',
      '}',
      '',
      '// ==========================================',
      '// \ud83d\udcb3 payCJOrderBalance - 2.2: pay unpaid order from CJ wallet',
      '// ==========================================',
      'async function payCJOrderBalance(...candidates) {',
      '  let lastReason = \'no_candidates\';',
      '  for (const v of candidates.filter(Boolean)) {',
      '    try {',
      '      const res = await cjRequest((token) =>',
      '        axios.post(CJ_API + \'/shopping/pay/payBalance\',',
      '          { orderId: String(v) },',
      '          { headers: { \'CJ-Access-Token\': token, \'Content-Type\': \'application/json\' } }',
      '        )',
      '      );',
      '      if (res.data?.code === 200) return { ok: true };',
      '      lastReason = (res.data?.message || \'code_\' + res.data?.code);',
      '    } catch (e) {',
      '      lastReason = (e.response && e.response.data && e.response.data.message) || e.message;',
      '    }',
      '  }',
      '  return { ok: false, reason: lastReason };',
      '}',
      ''
    ].join(EOL_C);
    cs = cs.slice(0, i) + fn + cs.slice(i);
    console.log('OK   [A2] deleteCJOrder + payCJOrderBalance');
  }
}

// ===== [A3] exports =====
{
  const FINAL_EXP = 'module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert, deleteCJOrder, payCJOrderBalance };';
  if (cs.includes(FINAL_EXP)) console.log('SKIP [A3] exports');
  else {
    const i = cs.indexOf('module.exports = { fulfillCJOrder');
    const j = cs.indexOf('};', i);
    if (i === -1 || j === -1) { console.log('FAIL [A3] exports locate'); problems.push('A3'); }
    else { cs = cs.slice(0, i) + FINAL_EXP + cs.slice(j + 2); console.log('OK   [A3] exports كاملين'); }
  }
}

// ===== [B] الوقاية فـ fulfillCJOrder: logisticsMiss → repair فوري =====
{
  if (cs.includes('logisticsMiss === true')) console.log('SKIP [B] prevention موجودة');
  else {
    const anchorB = "sampleOnce('V3-Create', cjResponse.data?.data);";
    const bIdx = cs.indexOf(anchorB);
    if (bIdx === -1) { console.log('FAIL [B] sampleOnce anchor'); problems.push('B'); }
    else {
      const lineEnd = cs.indexOf(EOL_C, bIdx) + EOL_C.length;
      const inject = [
        "          if (cjResponse.data?.data?.logisticsMiss === true) {",
        "            // \ud83e\udd16 logisticsMiss: CJ ma-bindat-sh shipping — auto-repair tawa (1.13+1.14)",
        "            console.warn('[CJ] #' + orderId + ' logisticsMiss=true - auto-repair...');",
        "            const repMiss = await autoRepairLogistics(extractCjNumber(cjResponse.data?.data) || targetOrderNumber);",
        "            if (repMiss.repaired) console.log('[CJ] #' + orderId + ' logistics bound: ' + repMiss.logisticsName + ' ($' + repMiss.postage + ')');",
        "            else console.warn('[CJ] #' + orderId + ' auto-repair failed: ' + repMiss.reason);",
        "          }"
      ].join(EOL_C) + EOL_C;
      cs = cs.slice(0, lineEnd) + inject + cs.slice(lineEnd);
      console.log('OK   [B] الوقاية: logisticsMiss → repair فوري فـ fulfillCJOrder');
    }
  }
}

// ===== [C1] import فـ server.js =====
{
  const FINAL_IMP = "const { fulfillCJOrder, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert, deleteCJOrder, payCJOrderBalance } = require('./services/cjService');";
  if (sv.includes(FINAL_IMP)) console.log('SKIP [C1] import');
  else {
    const i = sv.indexOf("const { fulfillCJOrder, cjRequest, parseNumeric");
    const j = i === -1 ? -1 : sv.indexOf("} = require('./services/cjService');", i);
    if (i === -1 || j === -1) { console.log('FAIL [C1] import locate'); problems.push('C1'); }
    else { sv = sv.slice(0, i) + FINAL_IMP + sv.slice(j + "} = require('./services/cjService');".length); console.log('OK   [C1] import كامل'); }
  }
}

// ===== [C2] كرون Auto-Heal جديد — بعد كرون التتبع (position-based) =====
if (sv.includes('Auto-Heal cron')) {
  console.log('SKIP [C2] كرون Auto-Heal موجود');
} else {
  const anchorErr = "logger.logError('CJ Logistics Cron', err);";
  const aIdx = sv.indexOf(anchorErr);
  if (aIdx === -1) { console.log('FAIL [C2] tracking cron anchor'); problems.push('C2'); }
  else {
    const endIdx = sv.indexOf('});', aIdx);
    if (endIdx === -1) { console.log('FAIL [C2] cron end'); problems.push('C2'); }
    else {
      const insertAt = endIdx + 3;
      const cron = [
        '',
        '// ==========================================',
        '// \ud83e\udd16 Auto-Heal cron - \u0627\u0644\u0633\u0644\u0651\u0645 \u0627\u0644\u0643\u0627\u0645\u0644 \u0644\u0644\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u0639\u0627\u0644\u0642\u0629 (1.13/1.14 \u2192 1.8 delete+recreate \u2192 2.2 autopay)',
        '// ==========================================',
        "cron.schedule('17,47 * * * *', async () => {",
        '  try {',
        '    const { rows: stuck } = await pool.query(`',
        '      SELECT id, status, customer_name, customer_email, customer_phone, total_amount, cj_order_number, created_at',
        '      FROM orders',
        "      WHERE status IN ('paid', 'fulfilled')",
        "        AND (tracking_number IS NULL OR tracking_number = '')",
        "        AND created_at <= NOW() - INTERVAL '2 hours'",
        "        AND created_at >= NOW() - INTERVAL '30 days'",
        '      LIMIT 10;',
        '    `);',
        '    if (!stuck.length) return;',
        '',
        '    const keys = stuck.map(function (o) {',
        "      const stored = String(o.cj_order_number || '').trim();",
        "      return { order: o, key: (stored && !/^STORE-/i.test(stored)) ? stored : ('STORE-' + o.id) };",
        '    });',
        '',
        '    const res = await cjRequest((token) =>',
        "      axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetailBatch',",
        '        { orderIds: keys.map(function (k) { return k.key; }) },',
        "        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }",
        '      )',
        '    );',
        '    if (res.data?.code !== 200) return;',
        '    const list = Array.isArray(res.data.data) ? res.data.data : [];',
        '    const byKey = new Map();',
        '    for (const d of list) {',
        '      if (d.orderNum) byKey.set(String(d.orderNum).toLowerCase(), d);',
        '      if (d.cjOrderCode) byKey.set(String(d.cjOrderCode).toLowerCase(), d);',
        '    }',
        '',
        '    for (const { order, key } of keys) {',
        '      const d = byKey.get(key.toLowerCase());',
        '      if (!d) continue;',
        "      const status = String(d.orderStatus || '').toUpperCase();",
        '      const hasLogi = !!d.logisticName;',
        '      const paid = !!d.paymentDate;',
        '',
        "      // 1) CREATED \u0639\u0627\u0644\u0642 \u0628\u0644\u0627 \u0634\u062d\u0646 \u0628\u0644\u0627 \u062f\u0641\u0639 \u2192 \u0627\u0644\u0633\u0644\u0651\u0645",
        "      if (status === 'CREATED' && !hasLogi && !paid) {",
        '        const rep = await autoRepairLogistics(d.cjOrderCode || key);',
        '        if (rep.repaired) {',
        "          console.log('[AutoHeal] #' + order.id + ' logistics bound: ' + rep.logisticsName + ' ($' + rep.postage + ')');",
        '          continue;',
        '        }',
        "        if (!global['_cjRecreate_' + order.id]) {",
        "          global['_cjRecreate_' + order.id] = true; // \u0645\u062d\u0627\u0648\u0644\u0629 recreate \u0648\u0627\u062d\u062f\u0629 \u0628\u0631\u0643 \u0644\u0643\u0644 session",
        "          console.warn('[AutoHeal] #' + order.id + ' repair failed (' + rep.reason + ') - delete + recreate...');",
        '          const del = await deleteCJOrder(d.orderId, d.cjOrderCode, key);',
        '          if (!del.ok) {',
        "            console.warn('[AutoHeal] delete failed #' + order.id + ': ' + del.reason);",
        "            if (typeof sendAdminAlert === 'function') sendAdminAlert('[CJ] Stuck order #' + order.id + ' - auto-repair & delete failed', '<p>repair: ' + rep.reason + ' | delete: ' + del.reason + '</p>').catch(function () {});",
        '            continue;',
        '          }',
        "          await pool.query(\"UPDATE orders SET cj_order_number = '' WHERE id = $1\", [order.id]).catch(function () {});",
        '          (async () => {',
        '            try {',
        "              const oRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);",
        '              const full = oRes.rows[0];',
        "              const iRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);",
        '              let addr = {};',
        "              try { addr = JSON.parse(full.shipping_address); } catch (e) { addr = { line1: full.shipping_address, country: 'US' }; }",
        '              const r = await fulfillCJOrder(order.id, full.customer_name, {',
        "                address: addr, phone: full.customer_phone || '', email: full.customer_email || '', name: full.customer_name",
        '              }, iRes.rows);',
        "              console.log('[AutoHeal] recreate #' + order.id + ' ->', JSON.stringify(r).slice(0, 200));",
        '            } catch (e) { logger.logError(\'AutoHeal recreate #\' + order.id, e); }',
        '          })();',
        '          continue;',
        '        }',
        '        // \u0633\u0628\u0642\u0646\u0627 recreate \u2014 \u062a\u0646\u0628\u064a\u0647 \u0645\u0631\u0629 \u0643\u0644 24\u0633',
        "        if (!global['_cjStuckAlert_' + order.id] || Date.now() - global['_cjStuckAlert_' + order.id] > 86400000) {",
        "          global['_cjStuckAlert_' + order.id] = Date.now();",
        "          if (typeof sendAdminAlert === 'function') sendAdminAlert('[CJ] Order #' + order.id + ' still stuck after recreate attempt', '<p>Status: CREATED, no logistics, no payment. Last repair reason: ' + rep.reason + '</p>').catch(function () {});",
        '        }',
        '        continue;',
        '      }',
        '',
        "      // 2) \u0634\u062d\u0646 \u0645\u062d\u062f\u062f \u0644\u0643\u0646 \u063a\u064a\u0631 \u0645\u062f\u0641\u0648\u0639 \u0639\u0646\u062f CJ \u2192 autopay \u0645\u0646 \u0627\u0644\u0645\u062d\u0641\u0638\u0629 (2.2)",
        '      if (hasLogi && !paid && (status === \'UNPAID\' || status === \'CREATED\')) {',
        "        if (!global['_cjPayTry_' + order.id] || Date.now() - global['_cjPayTry_' + order.id] > 3600000) {",
        "          global['_cjPayTry_' + order.id] = Date.now();",
        '          const pay = await payCJOrderBalance(d.orderId, d.cjOrderCode, key);',
        "          console.log('[AutoHeal] payBalance #' + order.id + ':', pay.ok ? 'PAID' : 'failed: ' + pay.reason);",
        '        }',
        '      }',
        '    }',
        '  } catch (err) {',
        "    logger.logError('AutoHeal Cron', err);",
        '  }',
        '});',
        ''
      ].join(EOL_S);
      sv = sv.slice(0, insertAt) + cron + sv.slice(insertAt);
      console.log('OK   [C2] كرون Auto-Heal محقون (17,47 * * * *)');
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