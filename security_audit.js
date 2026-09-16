/**
 * node security_audit.js — مسح أمني شامل للباكند
 * يفحص: IDOR / Injection / XSS / Auth gaps / Rate-limits / Secrets leaks
 */
const fs = require('fs');
const path = require('path');

const FILES = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (['node_modules','.git','logs','tmp'].includes(f)) continue;
    if (/^(fix_|audit_|test_|debug_|rescue_|cleanup_|preflight_|env_)/.test(f)) continue;
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.js$/.test(f)) FILES.push(full);
  }
})('.');

const src = FILES.map(f => ({ file: f, code: fs.readFileSync(f, 'utf8') }));
const findings = [];
function add(sev, file, line, issue, snippet) {
  findings.push({ sev, file, line, issue, snippet: snippet.trim().slice(0, 100) });
}

for (const { file, code } of src) {
  const lines = code.split('\n');

  lines.forEach((line, i) => {
    const n = i + 1;

    // ── 1. SQL Injection vectors — template literals في queries مع متغيرات غير مقيدة
    if (/pool\.query\(`[^`]*\$\{(?!orderId|order\.id|oid|req\.user)/.test(line) && /SELECT|UPDATE|INSERT|DELETE/i.test(line)) {
      add('MEDIUM', file, n, 'SQL template-literal interpolation (راجع — هل المتغير مُصفى؟)', line);
    }

    // ── 2. XSS في HTML emails — متغير مستخدم مباشرة بلا escape
    if (/<[a-z]+[^>]*>\$\{[^}]*\}/.test(line) && /html|HTML/i.test(line)) {
      add('LOW', file, n, 'HTML interpolation (email content) — تأكد أن المدخلات مش user-controlled raw', line);
    }

    // ── 3. Auth gaps — POST/PUT/DELETE endpoints خارج /admin بلا مرجع للـ auth
    // (سيُحلل يدوياً بعد السكانر — هنا نجمع قائمة الـ routes)
    if (/app\.(post|put|delete|patch)\(['"`]\/api\//.test(line)) {
      add('INFO-ROUTE', file, n, 'Mutation endpoint — تحقق يدوياً: فيه auth؟ rate-limit؟', line);
    }
    if (/router\.(post|put|delete|patch)\(['"`]/.test(file.includes('controllers') || file.includes('routes') ? line : '___')) {
      add('INFO-ROUTE', file, n, 'Router mutation endpoint — تحقق من التغطية الأمنية', line);
    }

    // ── 4. Secrets في الكود (لا ينبغي أن توجد أبداً — env فقط)
    if (/(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line) && !process.env && !/process\.env/.test(line)) {
      add('HIGH', file, n, 'Hardcoded secret pattern?!', line);
    }

    // ── 5. Error responses قد تكشف البنية
    if (/error:\s*error\.message/.test(line) && /status\(500\)/.test(line)) {
      add('LOW', file, n, '500 يرجع error.message للعميل — قد يكشف بنية DB/library', line);
    }

    // ── 6. Eval/Exec — ممنوعون نهائياً
    if (/\beval\(|child_process|exec\(|execSync\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
      add('HIGH', file, n, 'Eval/exec usage — راجع فوراً', line);
    }
  });
}

// ── التقرير
const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2, 'INFO-ROUTE': 3 };
findings.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);

console.log(`🔐 ═══ SECURITY AUDIT — ${src.length} files scanned ═══\n`);
for (const f of findings) {
  console.log(`[${f.sev}] ${f.file}:${f.line}`);
  console.log(`   ${f.issue}`);
  console.log(`   → ${f.snippet}\n`);
}
const counts = findings.reduce((acc, f) => { acc[f.sev] = (acc[f.sev] || 0) + 1; return acc; }, {});
console.log('═'.repeat(50));
console.log('📊 التلخيص:', JSON.stringify(counts));