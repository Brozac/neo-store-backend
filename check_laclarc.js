'use strict';
// check_laclarc.js — READ-ONLY state inspector (لمسة صفر)
const fs = require('fs'), vm = require('vm');
const B = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\';
function rdL(p){ return fs.readFileSync(B+p,'utf8').replace(/\r\n/g,'\n'); }

const sv = rdL('server.js');

// brace-aware extractor — كيسحب بلوك cron كامل حتى الـ }); ديالو
function extractBlock(txt, s){
  let i = txt.indexOf('{', s); if(i===-1) return null;
  let depth=0;
  for(let j=i; j<txt.length; j++){
    const c=txt[j];
    if(c==='\''||c==='"'||c==='`'){ const q=c; j++;
      while(j<txt.length){ if(txt[j]==='\\'){j+=2;continue;} if(txt[j]===q)break; j++; } continue; }
    if(c==='/'&&txt[j+1]==='/'){ while(j<txt.length&&txt[j]!=='\n')j++; continue; }
    if(c==='/'&&txt[j+1]==='*'){ const e=txt.indexOf('*/',j+2); if(e===-1)break; j=e+1; continue; }
    if(c==='{')depth++;
    else if(c==='}'){ depth--;
      if(depth===0){ let k=j+1; while(k<txt.length&&/\s/.test(txt[k]))k++;
        if(txt[k]===')'){k++; while(k<txt.length&&/\s/.test(txt[k]))k++; if(txt[k]===';')k++;}
        return txt.slice(s,k); } }
  }
  return null;
}

console.log('=========== LACLARC STATE INSPECTOR ===========\n');
try{ new vm.Script(sv,{filename:'server.js'}); console.log('[syntax] server.js: OK\n'); }
catch(e){ console.log('[syntax] server.js: BAD -> '+e.message+'\n'); }

const lim=(sv.match(/const trackLimiter/g)||[]).length;
console.log('[A] trackLimiter declarations: '+lim+(lim===1?'  OK':'  <<< PROBLEM'));
const lo=(sv.match(/let orderId = null/g)||[]).length;
const co=(sv.match(/const orderId = orderResult\.rows\[0\]\.id;/g)||[]).length;
console.log('[B] orphan: let-orderId='+lo+' (want 1) | old const-assign='+co+' (want 0)');
const wIdx=sv.indexOf("checkout.session.completed");
console.log('[C] Stripe WH orderId line:');
console.log(wIdx>-1 ? '    '+sv.slice(wIdx,wIdx+260).split('\n').slice(0,6).join('\n    ') : '    NOT FOUND');
console.log('[D] RECOVER10 in code: '+(sv.includes('RECOVER10')?'YES':'NO (fine - seeded via SQL)'));
console.log('[E] killers: '+((sv.match(/status = 'completed' WHERE id/g)||[]).length)+' (want 0)');
console.log('[F] getOrderDetail in server.js:');
let m; const gre=/axios\.(get|post)\(\s*['"`](https?:[^'"`]*getOrderDetail)/g;
let anyF=false; while((m=gre.exec(sv))){ anyF=true; console.log('    '+m[1].toUpperCase()+' @ '+sv.slice(Math.max(0,m.index-60),m.index).split('\n').pop().trim()+' ...'); }
if(!anyF) console.log('    NONE FOUND');

const rIdx=sv.indexOf("cron.schedule('*/15");
console.log('\n[G] ========== RECONCILE CRON (full) ==========');
if(rIdx===-1) console.log('NOT FOUND');
else{ const b=extractBlock(sv,rIdx);
  if(!b) console.log('EXTRACT FAILED');
  else{
    console.log('>> guard cj_order_number: '+(b.includes('cj_order_number')?'YES':'NO'));
    console.log('>> legacy reconciling write: '+(b.includes("SET status = 'reconciling'")?'YES':'NO'));
    console.log(b);
  }
}

const tIdx=sv.indexOf("cron.schedule('30 * * * *'");
console.log('\n[H] ========== TRACKING CRON (full) ==========');
if(tIdx===-1) console.log('NOT FOUND');
else{ const b=extractBlock(sv,tIdx);
  if(!b) console.log('EXTRACT FAILED');
  else{
    const mm=b.match(/axios\.(get|post)\(\s*['"`][^'"`]*getOrderDetail/);
    console.log('>> CJ call: '+(mm?mm[0].slice(0,80):'NO getOrderDetail CALL'));
    console.log('>> cj_order_number: '+(b.includes('cj_order_number')?'YES':'NO'));
    console.log('>> notifyShipment: '+(b.includes('notifyShipment')?'YES':'NO'));
    console.log(b);
    console.log('>> ---- 300 chars AFTER this cron ----');
    console.log(sv.slice(tIdx+b.length, tIdx+b.length+300));
  }
}

console.log('\n[I] notifyShipment in cjWebhookService.js:');
const cw=rdL('services\\cjWebhookService.js');
const nIdx=cw.indexOf('async function notifyShipment');
console.log(nIdx>-1 ? cw.slice(nIdx,nIdx+420) : 'NOT FOUND');

console.log('\n=========== END — صيفط الـ output كامل ===========');