// backend/utils/parser.js

// ==========================================
// 🎨 خريطة الألوان (colorMap) - أكثر من 90 لون
// ==========================================
const colorMap = {
  // ألوان أساسية
  red: '#FF0000', blue: '#0000FF', green: '#008000', black: '#000000',
  white: '#FFFFFF', purple: '#8B78C6', teal: '#357A8B', pink: '#FFC0CB',
  grey: '#808080', gray: '#808080', navy: '#000080', yellow: '#FFFF00',
  beige: '#F5F5DC', brown: '#964B00', orange: '#FFA500', gold: '#FFD700',
  silver: '#C0C0C0',

  // درجات الأحمر والوردي
  maroon: '#800000', burgundy: '#800020', wine: '#722F37', crimson: '#DC143C',
  scarlet: '#FF2400', rose: '#FF007F', 'rose gold': '#B76E79',
  'hot pink': '#FF69B4', fuchsia: '#FF00FF', magenta: '#FF00FF',
  salmon: '#FA8072', coral: '#FF7F50', peach: '#FFE5B4', apricot: '#FBCEB1',
  raspberry: '#E30B5D', ruby: '#E0115F', cherry: '#DE3163',

  // درجات البني والبيج
  tan: '#D2B48C', khaki: '#C3B091', camel: '#C19A6B', chocolate: '#7B3F00',
  coffee: '#6F4E37', mocha: '#967969', taupe: '#483C32', ecru: '#C2B280',
  sand: '#C2B280', nude: '#E3BC9A', rust: '#B7410E', copper: '#B87333',
  bronze: '#CD7F32', caramel: '#AF6E4D', chestnut: '#954535',

  // درجات الأخضر
  olive: '#808000', 'olive green': '#556B2F', 'army green': '#4B5320',
  'military green': '#4B5320', 'forest green': '#228B22', emerald: '#50C878',
  mint: '#98FF98', 'mint green': '#98FF98', lime: '#32CD32',
  sage: '#9CAF88', 'khaki green': '#78866B', jade: '#00A86B',

  // درجات الأزرق والفيروزي
  turquoise: '#40E0D0', cyan: '#00FFFF', aqua: '#00FFFF', 'sky blue': '#87CEEB',
  'baby blue': '#89CFF0', 'royal blue': '#4169E1', cobalt: '#0047AB',
  denim: '#1560BD', indigo: '#4B0082', 'teal blue': '#367588', 'ice blue': '#DBF9FF',

  // درجات البنفسجي
  violet: '#8F00FF', lavender: '#E6E6FA', lilac: '#C8A2C8', plum: '#8E4585',
  mauve: '#E0B0FF', orchid: '#DA70D6', amethyst: '#9966CC',

  // درجات الأصفر / الذهبي
  mustard: '#FFDB58', amber: '#FFBF00', champagne: '#F7E7CE', lemon: '#FFF44F',
  honey: '#EBA937',

  // درجات الرمادي / الأسود / الأبيض
  charcoal: '#36454F', slate: '#708090', ivory: '#FFFFF0', cream: '#FFFDD0',
  'off white': '#FAF9F6', pearl: '#EAE0C8', graphite: '#383838',
  'jet black': '#0A0A0A',
};

// ==========================================
// 🧵 خرائط الأنماط (patterns) - ما عندهاش لون واحد ثابت
// ==========================================
const patternMap = {
  multicolor: 'multicolor', 'multi color': 'multicolor', 'multi-color': 'multicolor',
  rainbow: 'rainbow', camo: 'camo', camouflage: 'camo', floral: 'floral',
  stripe: 'striped', striped: 'striped', 'polka dot': 'polka-dot',
  leopard: 'leopard', 'animal print': 'animal-print', 'snake print': 'snake-print',
  'tie dye': 'tie-dye', plaid: 'plaid', checkered: 'checkered',
  houndstooth: 'houndstooth', ombre: 'ombre', gradient: 'gradient',
  marble: 'marble', galaxy: 'galaxy', tartan: 'tartan',
};

// ==========================================
// 🛠️ أدوات مساعدة لمطابقة الكلمات المفتاحية بحدود كلمة حقيقية
// (✅ الإصلاح: كنا نستعملو .includes() اللي كيقارن substring عادي،
//    وهادشي كان كيعطي نتائج غلط: مثلا "Titanium" فيها substring "tan" (لون بيج)،
//    و"Massage Gun" فيها substring "sage" (لون أخضر sage)، إلخ.
//    دابا كنبنيو \b...\b regex ديال كل كلمة، مرة وحدة عند تحميل الموديل، لأداء أحسن)
// ==========================================
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// نرتب من الأطول للأقصر باش "rose gold" يتكشف قبل "rose" و "gold" لوحدهم
const sortedColorKeys = Object.keys(colorMap).sort((a, b) => b.length - a.length);
const sortedPatternKeys = Object.keys(patternMap).sort((a, b) => b.length - a.length);

// نبنيو زوج ديال regex لكل كلمة: وحدة بلا /g لـ .test() (باش نتفاديو مشكلة lastIndex
// المعروفة فـ JS مع regex ديال /g لي كتعاود تتستعمل عبر عدة variants)، وواحدة بـ /g للـ replace.
function buildMatchers(keys) {
  return keys.map((key) => {
    const escaped = escapeRegex(key);
    return {
      key,
      testRegex: new RegExp(`\\b${escaped}\\b`, 'i'),
      replaceRegex: new RegExp(`\\b${escaped}\\b`, 'gi'),
    };
  });
}

const colorMatchers = buildMatchers(sortedColorKeys);
const patternMatchers = buildMatchers(sortedPatternKeys);

function parseVariants(variants = []) {
  const colorsSet = new Set();
  const sizesSet = new Set();
  const patternsSet = new Set();
  const sizeRegex = /\b(XXXL|XXL|XL|L|M|S|XS|One Size)\b/i;

  variants.forEach((v) => {
    const name = v.variantKey || v.variantNameEn || '';
    let lowerName = name.toLowerCase();

    // الأنماط أولاً (باش ما تدخلش فالتضارب مع الألوان)
    patternMatchers.forEach(({ key, testRegex, replaceRegex }) => {
      if (testRegex.test(lowerName)) {
        patternsSet.add(patternMap[key]);
        lowerName = lowerName.replace(replaceRegex, ' ');
      }
    });

    colorMatchers.forEach(({ key, testRegex, replaceRegex }) => {
      if (testRegex.test(lowerName)) {
        colorsSet.add(colorMap[key]);
        lowerName = lowerName.replace(replaceRegex, ' ');
      }
    });

    const match = name.match(sizeRegex);
    if (match) sizesSet.add(match[0].toUpperCase());
  });

  return {
    colors: Array.from(colorsSet),
    sizes: Array.from(sizesSet),
    patterns: Array.from(patternsSet),
  };
}

// ==========================================
// 🧠 محرك تصنيف المنتجات (Filter Monster v6 - rule engine)
// ==========================================
const FEMALE_REGEX = /\b(women|woman|womens|ladies|lady|girl|girls|female)\b/;
const MALE_REGEX = /\b(men|mens|man|male|boy|boys|gentleman)\b/;

// ✅ الإصلاح (لقيناه فالاختبار): "PC Case for iPhone" ماكانتش كتلقط لا من phoneAccRegex
// (كانت غير "phone case"/"iphone case" بالترتيب هاذاك بالضبط) ولا من الـ not ديال قاعدة 'pc'،
// فكانت كتوصل لـ 'pc' بالغلط بسبب كلمة "PC" فبداية الاسم. زدنا صيغة "case for iphone/samsung/phone".
// ✅ إصلاح إضافي: "tempered glass" بلا سياق كانت كتلقط منتجات حقيقية ديال قطع كمبيوتر
// (بحال "Computer Case RGB Tempered Glass" — واجهة جانبية زجاجية للكيسة، ماشي واقي شاشة هاتف).
// بدلناها بصيغ مرتبطة فعلا بواقيات شاشة الهاتف.
const phoneAccRegex = /\b(phone case|iphone case|samsung case|case for iphone|case for samsung|case for phone|phone cover|phone holder|phone mount|charger|earphone|headphone|screen protector|phone grip|phone ring|phone bag|phone strap|phone lanyard|phone stand|phone skin|cable|power bank|tempered glass film|tempered glass for iphone|tempered glass for samsung|iphone tempered glass|phone tempered glass|9h tempered glass|phone pouch|tripod|gimbal|stabilizer|selfie stick|popsocket|pop socket|sim card|memory card|otg adapter|phone charm)\b/;

// ⚠️ هاد الـ regex معناها: "استثناءات لقاعدة 'pc' العامة فقط" — ماشي قاعدة تصنيف بحالها.
// كاينة باش تفادى حالتين: (1) "PC" كتبان فبزاف كاطيغوريات CJ كمرادف لمادة Polycarbonate
// (بحال "PC Case", "PC Cover")، (2) كلمة "Computer" كتبان فأسماء أثاث (Computer Desk/Chair/Table)
// ماشي فقطع كمبيوتر حقيقية. كتصدر برا باش تستعمل فمكان آخر (مثلا فلترة قبل الاستيراد فـ server.js).
// ✅ الإصلاح: قبل كانت مستعملة زوج مرات — مرة كـ "not" للقاعدة 'pc'، ومرة أخرى (بالغلط) كقاعدة
// بحالها كترجع 'electronics'. هادشي كان كيبلع "Wall Clock"، "Tool Set"، "Office Chair"... ديال
// أقسام أخرى (home, tools) قبل ما توصل ليهم القاعدة الصحيحة. تبقى هنا غير كـ "not".
const pcBlacklistRegex = /\b(pc chair|pc cushion|pc desk|pc table|pc lamp|pc stand|pc bag|pc sleeve|pc cover|pc skin|pc sticker|pc holder|pc mount|pc cleaning|pc protector|office chair|office cushion|seat cushion|desk cushion|office desk|office table|office lamp|tool set|tool kit|wall clock|desk clock|digital clock|decorative clock|clock|timer|stopwatch|alarm clock|furniture|decor|home decor)\b/;

const CATEGORY_RULES = [
  // 1. استثناءات إكسسوارات الهاتف
  { slug: 'electronics', test: phoneAccRegex },

  // 2. أقسام عالية الدقة
  {
    slug: 'shavers', genderSlugs: { female: 'shavers-women', male: 'shavers-men' },
    test: /\b(shaver|shavers|clipper|clippers|trimmer|trimmers|razor|razors|shaving|epilator|hair removal)\b/,
  },
    {
    resolve: (cat) => {
      if (/\b(nostalg|retro|classic|old|flip|non-smartphone|elder|senior)\b/.test(cat)) return 'phones-nostalgie';
      if (/\b(simple|basic|feature phone|2g|3g)\b/.test(cat)) return 'phones-simple';
      if (/\b(smart|android|ios|iphone)\b/.test(cat)) return 'phones-smart';
      return 'phones';
    },
    test: /\b(phone|smartphone|mobile)\b/,
    // ✨ استثناء المنتجات التي تحتوي على كلمة هاتف ولكنها ليست هواتف
    not: /\b(app controlled|wall light|corner light|lamp|led light|light bulb|remote|holder|mount|case|cover|stand|charger|cable|screen protector|earphone|headphone|projector|camera|watch|band|tracker|grip|ring|pouch|bag|tripod|gimbal|stabilizer)\b/,
  },
  {
    slug: 'fitness-trackers',
    test: /\b(fitness tracker|activity tracker|smart band|heart rate monitor)\b/,
  },
  {
    slug: 'watches', genderSlugs: { female: 'watches-women', male: 'watches-men' },
    test: /\b(watch|watches|wristwatch|smartwatch|smart watch|watch band|watch strap)\b/,
  },
  { slug: 'eyewear', test: /\b(sunglasses|eyeglasses|eyewear|glasses frame|goggles|reading glasses|blue light glasses)\b/ },

  // ✅ الإصلاح: نقلنا "baby-gear" و"musical-instruments" لهنا (قبل قطع الكمبيوتر) —
  // كانوا فسكسيون 3 تحت، وهادشي كان كيخليهم يتبلعو من كلمات الكمبيوتر الواسعة:
  // "Baby Monitor" كانت توقف عند pc-monitor (كلمة "monitor")،
  // و"Piano Keyboard" كانت توقف عند pc-accessories (كلمة "keyboard").
  { slug: 'baby-gear', test: /\b(stroller|baby carrier|baby car seat|infant car seat|crib|baby monitor|diaper bag)\b/ },
  { slug: 'musical-instruments', test: /\b(guitar|piano|violin|drum|musical instrument|ukulele|keyboard instrument)\b/ },

  // قطع الكمبيوتر
  { slug: 'pc-ram', test: /\b(ram|memory|ddr|sodimm|dimm)\b/ },
  // ✅ الإصلاح: حيدنا كلمة "storage" لوحدها (واسعة بزاف — كتلقط "Storage Box", "Closet Storage"...)
  // وزدنا صيغ أدق بدلها
  { slug: 'pc-ssd-hdd', test: /\b(ssd|hdd|hard drive|nvme|external storage|storage device|flash drive|usb drive)\b/ },
  { slug: 'pc-gpu', test: /\b(gpu|graphics card|rtx|gtx|radeon|video card)\b/ },
  { slug: 'pc-cpu', test: /\b(cpu|processor|ryzen|intel core|amd)\b/ },
  { slug: 'pc-motherboard', test: /\b(motherboard|mainboard)\b/ },
  // ✅ الإصلاح: حيدنا "screen" و"display" لوحدهم (واسعين بزاف — "Fireplace Screen",
  // "Jewelry Display Stand"...) وبقينا غير بصيغ مرتبطة فعلا بالكمبيوتر
  { slug: 'pc-monitor', test: /\b(monitor|computer screen|computer display|lcd monitor|led monitor|gaming monitor)\b/ },
  { slug: 'pc-accessories', test: /\b(mouse|keyboard|webcam|headset|mousepad|cooler pad|laptop cooler|pc accessories|computer accessories|microphone|mic stand|gaming chair|rgb light)\b/ },
  {
    slug: 'pc', test: /\b(pc|computer|desktop|gaming pc|laptop parts|personal computer)\b/,
    not: /\b(shaver|clipper|trimmer|kitchen|toy|pet|jewelry|beauty|phone|chair|cushion|desk|table|lamp|stand|clock|tool|decor|home|furniture|car|automobile|watch|vase|bag|holder|mount|cleaning|protector|sticker|skin|sleeve|cover|office)\b/,
  },

  // 3. أقسام دقيقة (لازم تتحقق قبل الأقسام العامة باش ما تبلعهمش)
  { slug: 'smart-home', test: /\b(smart home|smart plug|smart bulb|smart switch|home automation|voice assistant)\b/ },
  { slug: 'security-cameras', test: /\b(security camera|cctv|surveillance|doorbell camera|ip camera|dash cam)\b/ },
  { slug: 'drones', test: /\b(drone|quadcopter|fpv)\b/ },
  { slug: 'hair-styling-tools', test: /\b(hair dryer|hair straightener|curling iron|hair styling|flat iron|hair curler)\b/ },
  { slug: 'nail-care', test: /\b(nail polish|nail art|manicure|pedicure|nail care)\b/ },
  { slug: 'party-costume', test: /\b(costume|cosplay|halloween|party supply|wig|party decoration|seasonal decoration|christmas decor)\b/ },
  
  // ✨ (تم النقل هنا للأعلى) قسم Sportswear & Fitness
  { slug: 'sportswear-fitness', test: /\b(sport|sports|fitness|gym|yoga|activewear|running|cycling|bicycle|swimming|football|soccer|basketball|tennis|golf|dumbbell|treadmill|resistance band|exercise|workout|skateboard|quick-drying|sports bag|duffel bag|leggings|sports bra)\b/ },

  { slug: 'garden-outdoor', test: /\b(garden|gardening|outdoor|patio|camping|hiking|fishing|bbq|grill|solar light)\b/ },
  { slug: 'office-stationery', test: /\b(office|stationery|pen|pencil|notebook|paper|printer|stapler|desk accessory|book|magazine|school supply|backpack school)\b/ },

  // 4. أقسام عامة (تتحقق بعد الأقسام الدقيقة فوق)
  { slug: 'entertainment', test: /\b(entertainment|gaming|projector|home theater|console|console game|vr headset|arcade|dj equipment)\b/ },
  { slug: 'automobile', test: /\b(automobile|car|auto part|truck|vehicle|tire|wheel|dashboard|car accessory|motorcycle|car parts|seat cover|floor mat|car charger|license plate)\b/ },
  { slug: 'tools', test: /\b(tool|tools|wrench|screwdriver|hammer|drill|saw|plier|measuring tape|toolbox|power tool|hand tool|home improvement|hardware|inverter|generator|level tool|chisel|sandpaper|welding|work gloves)\b/ },
  { slug: 'cleaning-supplies', test: /\b(cleaning|mop|broom|vacuum cleaner|duster|cleaning brush|detergent|cleaning spray)\b/ },
  { slug: 'home', test: /\b(home|decor|furniture|rug|curtain|pillow|bedding|lighting|lamp|wall art|vase|storage|organization|clock|mirror|candle|planter|shower curtain|bath mat)\b/ },

  // 4. الأقسام الأساسية الأخرى
  { slug: 'kitchen', test: /\b(kitchen|cookware|dinnerware|utensil|bakeware|kitchen tool|blender|mixer|kettle|toaster|air fryer|coffee maker|kitchen appliance|cutting board|knife set|food storage)\b/ },
  { slug: 'toys', test: /\b(toy|toys|game|puzzle|doll|playset|kids toy|action figure|building blocks|lego|stuffed animal|plush|board game|rc car|toy drone)\b/ },
  { slug: 'pet', test: /\b(pet|dog|cat|animal|puppy|kitten|pet supply|leash|collar|pet bed|pet toy|aquarium|fish tank|bird cage)\b/ },
  { slug: 'jewelry', test: /\b(jewelry|jewellery|necklace|ring|bracelet|earring|pendant|anklet|brooch|cufflink|jewelry box)\b/ },
  { slug: 'electronics', test: /\b(electronic|tech gadget|audio|camera|appliance|smart home device|vlog|telescope|monocular|binoculars|lens)\b/ },
  { slug: 'bags', test: /\b(bag|wallet|luggage|handbag|purse|backpack|tote|duffel|crossbody|fanny pack|messenger bag|cosmetic bag)\b/ },
  { slug: 'footwear', test: /\b(shoe|footwear|sneaker|boot|sandal|slipper|heels|flats|loafers|socks)\b/ },

  // 5. الجمال والصحة والأطفال
  { slug: 'beauty', test: /\b(beauty|health|personal care|makeup|skincare|sweat|supplement|vitamin|first aid|thermometer|face mask)\b/ },
  { slug: 'kids', test: /\b(kid|baby|child|infant)\b/ },

  // 6. الملابس (مع فصل حسب الجنس)
  {
    genderSlugs: { female: 'clothing-women', male: 'clothing-men' }, slug: 'clothing',
    test: /\b(shirt|t-shirt|tshirt|hoodie|sweater|sweatshirt|jacket|coat|blazer|suit|dress|skirt|pants|jeans|shorts|leggings|jumpsuit|romper|tracksuit|underwear|lingerie|swimwear|bikini|clothing|apparel)\b/,
  },
];

function getCategorySlug(cjCategoryName = '') {
  const cat = (cjCategoryName || '').toLowerCase().trim();
  if (!cat) return 'other';

  for (const rule of CATEGORY_RULES) {
    if (rule.not && rule.not.test(cat)) continue;
    if (!rule.test.test(cat)) continue;

    if (rule.resolve) return rule.resolve(cat);

    if (rule.genderSlugs) {
      if (FEMALE_REGEX.test(cat)) return rule.genderSlugs.female;
      if (MALE_REGEX.test(cat)) return rule.genderSlugs.male;
    }

    return rule.slug;
  }

  // آخر ملاذ: تصنيف حسب الجنس فقط
  if (FEMALE_REGEX.test(cat)) return 'women';
  if (MALE_REGEX.test(cat)) return 'men';

  return 'other';
}

module.exports = { parseVariants, getCategorySlug, phoneAccRegex, pcBlacklistRegex };