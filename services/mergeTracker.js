// services/mergeTracker.js
/**
 * 🔗 F#79 — Merge Tracker — إغلاق دورة الدمج (دوك shopping 5.4)
 * ============================================================
 * الفجوة (F#78 audit): كرون الدمج كان كيصيفط submitMergeOrderBatchV3
 * ويطيح بالرد — الرد **متزامن** وكيرجع فيه:
 *   • newOrderCodeList  — أكواد الأوامر الأباء المدموجة (CJ...)
 *   • failGroupCount / failOrderCount / mergeFailOrderGroupList[] {errorCode, orderCodes}
 * بعد الدمج، كود الطفل كيموت عند CJ (1.16 كيتخطاه بصمت) → مزامنة الحالة
 * والتتبع كيتوقفا للطلبات المدموجة إلى الأبد.
 *
 * الحل هنا:
 *   1) نقراو الرد فعلاً — نجاح/فشل حقيقي فاللوج (ما بقاش "✅ completed" كاذب).
 *   2) propagation: كنجمعو رقم الأب فعمود جديد orders.cj_parent_order_number
 *      — وكل lookups (tracking/autoHeal/selfHeal/webhooks/دفع L2) كيتجاوزو للوالد.
 *   3) فشل الدمج (11001-11007/11100) = audit + تنبيه أدمن بالسبب الموثق.
 *
 * ملاحظة أمان: ما كنحيدوش ولا كنبدلوش cj_order_number (رقم الطفل يبقى
 * تاريخياً) — الأب كيتزاد فعمودو، والأولوية دائماً للوالد فالقراءة.
 * multi-parent (newOrderCodeList > 1) = ما نخمنوش — audit + تنبيه بشري.
 */
const axios = require('axios');
const pool = require('../db');
const { cjRequest, auditEvent, sendAdminAlert } = require('./cjService');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// دوك 5.4/5.6 — جدول أخطاء الدمج الموثقة
const MERGE_ERROR_MAP = {
  200: 'success',
  11001: 'only 1 order selected',
  11002: 'order exception',
  11003: 'empty order',
  11004: 'address mismatch',
  11005: 'no available logistics',
  11006: 'supplier self-shipped order',
  11007: 'order status changed',
  11100: 'other error',
};

let mergeColsEnsured = false;
async function ensureMergeColumns(db) {
  if (mergeColsEnsured) return;
  // ضمان ذاتي (نمط F54/F#77) — الكرون ما يرميش relation error إلا ما دارش الميغراسيون
  await (db || pool).query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cj_parent_order_number TEXT NOT NULL DEFAULT ''
  `);
  await (db || pool).query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_merged_at TIMESTAMPTZ`);
  mergeColsEnsured = true;
}

/**
 * 🔑 مفاتيح البحث CJ لطلب واحد — الوالد أولاً (بعد الدمج كود الطفل ما بقااش موجود).
 * يصلح أيضاً bug صامت قديم: الطلبات المنقسمة (cj_order_number = "SD1, SD2")
 * كانت كتستعمل السلسلة كاملة كمفتاح واحد → 1.16 كيتخطاها بصمت دايماً.
 * ترجع: { primary, all[] } — primary = أفضل مفتاح، all = المفاتيح كامل بلا تكرار.
 */
function cjLookupKeys(order) {
  const stored = String((order && order.cj_order_number) || '').trim();
  const parent = String((order && order.cj_parent_order_number) || '').trim();
  const all = [];
  if (parent) all.push(parent);
  if (stored && !/^STORE-/i.test(stored)) {
    for (const part of stored.split(',')) {
      const v = part.trim();
      if (v) all.push(v);
    }
  }
  if (!all.length) all.push(`STORE-${(order && order.id) || '?'}`);
  return { primary: all[0], all: [...new Set(all)] };
}

/**
 * 🧩 أطفال المجموعة — flatten(mergeShopOrderVOList[].orderCodeList)
 * الدوك 5.4: كل VO = طلب متجر ب orderCodeList[] تاع أكواد CJ + orderNumber.
 */
function extractChildrenFromGroup(group) {
  const children = [];
  const storeNumbers = [];
  const vos = (group && Array.isArray(group.mergeShopOrderVOList)) ? group.mergeShopOrderVOList : [];
  for (const vo of vos) {
    const nums = Array.isArray(vo && vo.orderCodeList) ? vo.orderCodeList : [];
    for (const n of nums) {
      const v = String(n || '').trim();
      if (v) children.push(v);
    }
    const on = String((vo && vo.orderNumber) || '').trim();
    if (on) storeNumbers.push(on);
  }
  return { children: [...new Set(children)], storeNumbers: [...new Set(storeNumbers)] };
}

/**
 * 📥 تطبيق نتيجة الرد المتزامن (5.4) — propagation + فشل موثق.
 * deps: { pool, auditEvent, sendAdminAlert } — defaults الإنتاج، الاختبار كيحقن.
 */
async function applyMergeResult(children, submitData, deps = {}) {
  const db = deps.pool || pool;
  const audit = deps.auditEvent || auditEvent;
  const alert = deps.sendAdminAlert || sendAdminAlert;
  const out = { linked: [], parents: [], failures: [], skippedMultiParent: false };

  const parents = (Array.isArray(submitData && submitData.newOrderCodeList) ? submitData.newOrderCodeList : [])
    .map((p) => String(p || '').trim()).filter(Boolean);
  out.parents = parents;

  // نجاح: أب واحد معروف → ربط كل الأطفال بيه (guarded — ما كنغطيوش والداً قديماً)
  if (parents.length === 1 && children.length) {
    const parent = parents[0];
    const joinedComma = children.join(', ');
    const joinedTight = children.join(',');
    const upd = await db.query(
      `UPDATE orders
         SET cj_parent_order_number = $1, parent_merged_at = NOW()
       WHERE (cj_order_number = ANY($2::text[]) OR cj_order_number = $3 OR cj_order_number = $4)
         AND (cj_parent_order_number IS NULL OR cj_parent_order_number = '')
       RETURNING id`,
      [parent, children, joinedComma, joinedTight]
    );
    for (const r of upd.rows) out.linked.push(r.id);
    if (out.linked.length) {
      await audit('MERGE_PARENT_LINKED', null, {
        parent,
        orders: out.linked,
        children: children.slice(0, 20),
      }, 'info');
      console.log(`🔗 [MergeTracker] ${out.linked.length} طلب ربطو بالوالد ${parent}`);
    } else {
      // ما لقيناش الأطفال فDB — نداء CJ خارج سجلاتنا ولا سبق ربط. لوج برك، بلا فشل.
      console.warn(`🔗 [MergeTracker] الأب ${parent} ماعندو حتى طفل فDB (${children.join(', ').slice(0, 120)})`);
    }
  } else if (parents.length > 1) {
    // أباء متعددين بلا mapping صريح فالرد → ما نخمنوش (أمان البيانات)
    out.skippedMultiParent = true;
    await audit('MERGE_MULTI_PARENT_UNMAPPED', null, { parents: parents.slice(0, 10), children: children.slice(0, 20) }, 'warning');
    alert(
      '🔗 [Laclarc] دمج بقعة على عدة أباء — propagation يدوي مطلوب',
      `<p>submitMergeOrderBatchV3 رجع ${parents.length} أباء: <code>${parents.join(', ')}</code></p>
       <p>الأطفال: <code>${children.join(', ').slice(0, 300)}</code></p>
       <p>الرد ما كيعطيش mapping طفل→أب — الخمّن ممنوع. افتح تفاصيل الأباء فCJ وربط يدوياً.</p>`
    ).catch(() => {});
  }

  // الفشل الموثق — 11001-11007/11100
  const fails = (submitData && Array.isArray(submitData.mergeFailOrderGroupList)) ? submitData.mergeFailOrderGroupList : [];
  for (const f of fails) {
    const codeNum = Number(f && f.errorCode) || 0;
    const reason = MERGE_ERROR_MAP[codeNum] || `error ${codeNum || '?'}`;
    const codes = Array.isArray(f && f.orderCodes) ? f.orderCodes.map(String) : [];
    out.failures.push({ errorCode: codeNum, reason, orderCodes: codes });
    await audit('MERGE_GROUP_FAILED', null, { errorCode: codeNum, reason, orderCodes: codes.slice(0, 20) }, 'warning');
  }
  return out;
}

/**
 * 🚀 إرسال مجموعة دمج واحدة + تطبيق النتيجة — البديل الكامل للنداء الأعمى.
 * group = element من autoMatchMergeOrderListV3 (group.mergeShopOrderVOList يتصيفط كما هو).
 */
async function submitMergeGroup(group, deps = {}) {
  const db = deps.pool || pool;
  const audit = deps.auditEvent || auditEvent;
  const alert = deps.sendAdminAlert || sendAdminAlert;
  const { children } = extractChildrenFromGroup(group);
  const vos = (group && Array.isArray(group.mergeShopOrderVOList)) ? group.mergeShopOrderVOList : [];

  try {
    const res = await cjRequest((token) =>
      axios.post(`${CJ_BASE}/shopping/mergeOrder/submitMergeOrderBatchV3`,
        vos,
        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
      )
    );
    const env = res.data || {};
    if (env.code !== 200 || env.success === false) {
      // envelope-level فشل (شبكة CJ/صلاحيات) — audit + رجوع منظم، ما نحاولوش propagation
      const msg = env.message || `code_${env.code}`;
      await audit('MERGE_SUBMIT_ENVELOPE_FAIL', null, { message: String(msg).slice(0, 300), children: children.slice(0, 20) }, 'warning');
      return { ok: false, stage: 'envelope', message: msg, children };
    }
    const data = env.data || {};
    const applied = await applyMergeResult(children, data, { pool: db, auditEvent: audit, sendAdminAlert: alert });
    const okCount = Number(data.successGroupCount) || 0;
    const failCount = Number(data.failGroupCount) || 0;
    console.log(`🔗 [MergeTracker] submit: groups ok=${okCount} fail=${failCount} orders ok=${data.successOrderCount || 0}/${(Number(data.successOrderCount) || 0) + (Number(data.failOrderCount) || 0)} parents=[${applied.parents.join(', ')}] linked=${applied.linked.length}`);
    return { ok: true, data, ...applied, children };
  } catch (e) {
    await audit('MERGE_SUBMIT_THROW', null, { error: String(e.message || e).slice(0, 300) }, 'warning');
    return { ok: false, stage: 'throw', message: String(e.message || e), children };
  }
}

module.exports = {
  MERGE_ERROR_MAP,
  ensureMergeColumns,
  cjLookupKeys,
  extractChildrenFromGroup,
  applyMergeResult,
  submitMergeGroup,
};
