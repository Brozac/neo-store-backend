═══════════════════════════════════════════════════════════════════
 Kit 27 — CJ Live Shipping Estimate + CJ Points Monitor
 laclarc_cj_live_shipping_kit.zip
═══════════════════════════════════════════════════════════════════

🇲🇦 بالدارجة — شنو كيدير هاد الكيت؟
═══════════════════════════════════════════════
جوج إضافات فالـ backend (جراحية، backup تلقائي):

1) 🚚 endpoint جديد: GET /api/shipping/estimate?pid=123&country=MA
   - كيجيب ثمن الشحن الحقيقي و مدة التوصيل من CJ (freightCalculate)
     للمنتج pid و الدولة country — ماشي الأثمنة المسطحة $0/$15
   - cache 6 ساعات: 10 نقاط CJ غير على أول استدعاء لكل (منتج×دولة)
   - shipping_matrix كتفلتر قبل: دولة غير مدعومة = 0 نقطة
   - محدد IP: 30 طلب/10 دقايق — محمي من الاستهلاك المفتوح
   - استعملو: للدعم، للقرارات ديال التسعير، وكأساس للواجهة الجاية

2) 📊 مراقبة نقاط CJ (نظام النقاط الجديد من يوليوز 2026):
   - cjRequest ولّى كيقرا pointsInfo من كل response
   - سجل مرة فالساعة: used/total/remaining
   - فوراً تحذير [CJ Points LOW] إلا نقص لأقل من 15%
   - ما كيوقف حتى طلب — مراقبة صافية

⚠️ علاش ما زدتش الواجهة (PDP) فهاد الكيت؟
   لأنها خاصها قرار ديالك: أشمن دولة نديرو افتراضية (MA? DZ? US?)،
   وواش نبيّنو الثمن ولا غير التواريخ (الموقع واعد بـ Free Shipping).
   جاوبني ونديرها فالكيت الجاي.

📦 التركيب (5 دقايق):
   1. فك الـ ZIP — غادي تلقى 4 ملفات
   2. كوبيهم كاملين لـ جذر الـ backend (المجلد اللي فيه server.js)
   3. دوبل كليك: INSTALL_CJ_SHIPPING.bat
      (كيدير backup *.bak-cjkit27 + كيتأكد من الأنكورات + node --check)
   4. git add services/cjService.js server.js
      git commit -m "Kit27: live shipping estimate + CJ points monitor"
      git push   ← Render كيبني بوحدو
   5. من بعد ما يكمل الـ deploy (2-4 دقايق):
      python verify_shipping_estimate.py https://neo-store-backend.onrender.com <pid> MA

🧪 كيفاش تجرب بيدك (من بعد الـ deploy):
   المتصفح:
   https://neo-store-backend.onrender.com/api/shipping/estimate?pid=1&country=MA
   (بدل pid=1 برقم منتج حقيقي من عندك)

   مثال جواب ناجح:
   {
     "supported": true, "country": "MA",
     "cheapest": { "price": 4.28, "carrier": "CJPacket Ordinary", "aging": "12-18" },
     "fastest":  { "days": "7-12", "price": 6.10, "carrier": "..." },
     "agingDays": { "min": 12, "max": 18 },
     "carriersCount": 7, "source": "cj-live"
   }

📊 نقاط CJ — الحساب:
   - كل (منتج × دولة) جديد = 10 نقاط، وكيبقى فالكاش 6 ساعات
   - حتى لو 100 زائر فنفس اليوم على نفس المنتج/الدولة = 10 نقاط فقط
   - الأساس ديالك 50,000 نقطة/يوم — حتى باستعمال مكثف ما غاتوصلش
   - المراقبة الجديدة غادي تبين لك الاستهلاك فالـ Logs ديال Render

↩️ الرجوع للخلف (rollback):
   - ren services\cjService.js.bak-cjkit27 cjService.js
   - ren server.js.bak-cjkit27 server.js
   - git add/commit/push
   (ديرهم فقط من بعد ما تحقق أن الـ deploy الجديد مشى مزيان)

✅ التحقق النهائي قبل ما تمسح الـ backups:
   python verify_shipping_estimate.py → الحصيلة PASS=4 FAIL=0

🇨🇳 中文说明
═══════════════════════════════════════════════
本套件为后端添加两项（外科手术式补丁，自动备份）：
1) 新公开端点 GET /api/shipping/estimate?pid=123&country=MA
   - 调用 CJ freightCalculate 返回真实运费与时效（非固定 $0/$15）
   - 6 小时缓存（每 产品×国家 仅 10 积分），shipping_matrix 预过滤
     （不支持国家=0 积分），每 IP 30 请求/10 分钟限流
2) CJ 积分监控（2026 年 7 月起的积分制）：
   cjRequest 读取每个响应的 pointsInfo，每小时记录一次；
   低于 15% 时立即告警 [CJ Points LOW]；绝不影响请求本身
安装：解压后把 4 个文件拷到 backend 根目录 → 双击 INSTALL_CJ_SHIPPING.bat
     → git add/commit/push → Render 自动构建 → 运行 verify_shipping_estimate.py
回滚：把 *.bak-cjkit27 改回原文件名后 commit/push 即可。
未包含：PDP 前端接入（需先确定默认国家与是否展示价格），下次套件处理。
