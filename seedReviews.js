require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const authors = [
  "Olivia Martin", "Liam Smith", "Emma Johnson", "Noah Williams", "Ava Brown",
  "Ethan Jones", "Sophia Garcia", "Mason Miller", "Isabella Davis", "Lucas Rodriguez",
  "Mia Martinez", "Logan Hernandez", "Charlotte Lopez", "Elijah Gonzalez", "Amelia Wilson",
  "James Anderson", "Harper Thomas", "Benjamin Taylor", "Evelyn Moore", "Henry Jackson",
  "Abigail Lee", "Alexander Perez", "Emily White", "Sebastian Clark", "Elizabeth Lewis",
  "Jack Robinson", "Sofia Walker", "Daniel Young", "Avery Hall", "Matthew Allen",
  "Ella King", "Joseph Wright", "Scarlett Scott", "David Green", "Grace Adams",
  "Samuel Baker", "Chloe Nelson", "Owen Hill", "Victoria Mitchell", "Carter Roberts",
  "Aria Turner", "Wyatt Torres", "Lily Parker", "Julian Collins", "Aubrey Edwards",
  "Levi Murphy", "Zoey Bailey", "Isaac Rivera", "Nora Cooper", "Gabriel Ward"
];

const countries = [
  "United States", "United Kingdom", "Canada", "Australia", "Germany", 
  "France", "Spain", "Italy", "Netherlands", "Sweden"
];

// ✨ مكتبة تعليقات ذكية مقسمة حسب نوع المنتج
const reviewCategories = {
  default: [
    "Absolutely love this! Exactly as described and arrived quickly.",
    "Great quality for the price. Would definitely buy again.",
    "Exceeded my expectations! Highly recommend.",
    "Pretty good. Some minor flaws but overall a solid purchase.",
    "Better than I expected for the price point!"
  ],
  electronic: [
    "Battery life is amazing, lasts for days on a single charge.",
    "Setup was a breeze. Connected to my phone instantly.",
    "The sound quality is surprisingly good for the size.",
    "Works perfectly. I've been using it for a week now with no issues.",
    "Great gadget, but the instructions could be clearer. Still 5 stars."
  ],
  clothing: [
    "The material feels premium and very comfortable on the skin.",
    "Fits perfectly true to size. I ordered my usual size and it's great.",
    "Washed it twice now and the color hasn't faded at all.",
    "Looks exactly like the pictures. Very stylish!",
    "Soft fabric and well-stitched. Worth every penny."
  ],
  beauty: [
    "My skin feels so smooth after using this. Highly recommend!",
    "No irritation at all, very gentle on sensitive skin.",
    "Smells amazing and works wonders. Will buy again.",
    "A little goes a long way. This bottle will last months.",
    "Noticed results in just a few days. Very happy!"
  ],
  tool: [
    "Very sturdy and well-built. Doesn't feel cheap in the hand.",
    "Cuts through easily and saves me so much time.",
    "Powerful motor and quiet operation. Great tool for the price.",
    "Comes with all the attachments shown. Very handy.",
    "Makes DIY projects so much easier. 10/10."
  ],
  kitchen: [
    "Cooks food evenly and cleans up easily.",
    "This has made meal prep so much faster for my family.",
    "The non-stick coating works great, nothing sticks to it.",
    "Perfect size for my counter. Looks very sleek too.",
    "I use this every single day. A must-have for the kitchen!"
  ]
};

// ✨ دالة ذكية لاختيار التعليقات المناسبة بناءً على اسم المنتج
function getSmartReviews(productTitle) {
  const title = (productTitle || '').toLowerCase();
  let chosenCategory = 'default';

  if (/(shaver|clipper|trimmer|razor|haircut|shaving|epilator)/.test(title)) chosenCategory = 'tool';
  else if (/(dress|shirt|pants|jeans|jacket|coat|sweater|hoodie|bra|underwear|lingerie|skirt|socks|clothing|apparel|wear)/.test(title)) chosenCategory = 'clothing';
  else if (/(speaker|headphone|earbud|charger|cable|phone|smartwatch|camera|screen|monitor|keyboard|mouse|electronic|led|light|bluetooth|usb)/.test(title)) chosenCategory = 'electronic';
  else if (/(serum|cream|lotion|makeup|lipstick|mascara|skincare|beauty|nail|hair dryer|curling|straightener)/.test(title)) chosenCategory = 'beauty';
  else if (/(knife|pan|pot|cooker|blender|mixer|kettle|utensil|kitchen|baking|spatula|cutting board)/.test(title)) chosenCategory = 'kitchen';
  else if (/(drill|saw|wrench|hammer|screwdriver|tool|toolbox|plier)/.test(title)) chosenCategory = 'tool';

  // دمج التعليقات المحددة مع التعليقات العامة لزيادة التنوع
  return [...reviewCategories[chosenCategory], ...reviewCategories.default];
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function seedReviewsForAllProducts() {
  try {
    console.log('⏳ Fetching all products...');
    
    // مسح التقييمات القديمة
    await pool.query('DELETE FROM reviews');
    console.log('🗑️ All old reviews deleted!');

    const productsRes = await pool.query('SELECT id, title FROM products');
    const products = productsRes.rows;

    console.log(`Found ${products.length} products. Starting SMART review seeding...`);

    let totalReviewsAdded = 0;

    for (const product of products) {
      const targetReviews = Math.floor(Math.random() * 21) + 5; // 5 to 25

      // ✨ استدعاء الدالة الذكية لاختيار التعليقات بناءً على اسم المنتج
      let applicableContents = getSmartReviews(product.title);
      
      let shuffledAuthors = shuffleArray([...authors]);
      let shuffledContents = shuffleArray([...applicableContents]);

      for (let i = 0; i < targetReviews; i++) {
        // إذا احتجنا تقييمات أكثر من عدد التعليقات المتاحة، نعيد خلطها
        if (i >= shuffledContents.length) {
          shuffledContents = shuffleArray([...applicableContents]);
        }
        if (i >= shuffledAuthors.length) {
          shuffledAuthors = shuffleArray([...authors]);
        }

        const author = shuffledAuthors[i % shuffledAuthors.length];
        const country = countries[Math.floor(Math.random() * countries.length)];
        const content = shuffledContents[i % shuffledContents.length];
        
        const rating = Math.random() > 0.2 ? 5 : 4;
        const daysAgo = Math.floor(Math.random() * 90);
        const created_at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

        await pool.query(
          'INSERT INTO reviews (product_id, author, rating, content, country, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [product.id, author, rating, content, country, created_at]
        );
        totalReviewsAdded++;
      }
    }

    console.log(`🎉 Success! Added a total of ${totalReviewsAdded} SMART reviews across all products.`);
  } catch (err) {
    console.error('❌ Error seeding reviews:', err);
  } finally {
    await pool.end();
  }
}

seedReviewsForAllProducts();