// seedReviews.js - Laclarc Smart Review Seeder (Enterprise)
require('dotenv').config();
const pool = require('./db'); // ✨ استخدام الـ Pool الموحد

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
    "Great gadget, highly recommend to anyone looking for quality."
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
    "A little goes a long way. This will last months.",
    "Noticed results in just a few days. Very happy!"
  ],
  tool: [
    "Very sturdy and well-built. Doesn't feel cheap in the hand.",
    "Cuts through easily and saves me so much time.",
    "Powerful and quiet operation. Great tool for the price.",
    "Comes with all the attachments shown. Very handy.",
    "Makes everyday tasks so much easier. 10/10."
  ],
  kitchen: [
    "Cooks food evenly and cleans up easily.",
    "This has made meal prep so much faster for my family.",
    "The non-stick coating works great, nothing sticks to it.",
    "Perfect size for my counter. Looks very sleek too.",
    "I use this every single day. A must-have for the kitchen!"
  ]
};

function getSmartReviews(productTitle) {
  const title = (productTitle || '').toLowerCase();
  let chosenCategory = 'default';

  if (/(shaver|clipper|trimmer|razor|haircut|shaving|epilator)/.test(title)) chosenCategory = 'tool';
  else if (/(dress|shirt|pants|jeans|jacket|coat|sweater|hoodie|bra|underwear|lingerie|skirt|socks|clothing|apparel|wear)/.test(title)) chosenCategory = 'clothing';
  else if (/(speaker|headphone|earbud|charger|cable|phone|smartwatch|camera|screen|monitor|keyboard|mouse|electronic|led|light|bluetooth|usb)/.test(title)) chosenCategory = 'electronic';
  else if (/(serum|cream|lotion|makeup|lipstick|mascara|skincare|beauty|nail|hair dryer|curling|straightener)/.test(title)) chosenCategory = 'beauty';
  else if (/(knife|pan|pot|cooker|blender|mixer|kettle|utensil|kitchen|baking|spatula|cutting board)/.test(title)) chosenCategory = 'kitchen';
  else if (/(drill|saw|wrench|hammer|screwdriver|tool|toolbox|plier)/.test(title)) chosenCategory = 'tool';

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
  const client = await pool.connect();
  try {
    console.log('\n==================================================');
    console.log('⏳ Starting Smart Review Seeding...');
    console.log('==================================================\n');
    
    // ✨ حماية تقييمات الزبائن الحقيقية: نحذف فقط التقييمات المزروعة تلقائياً (التي ليس لها user_id)
    await client.query('DELETE FROM reviews WHERE user_id IS NULL');
    console.log('🧹 Cleaned previous synthetic reviews (preserved real customer reviews).');

    const productsRes = await client.query('SELECT id, title FROM products WHERE stock_status = true');
    const products = productsRes.rows;

    console.log(`📊 Found ${products.length} active products. Generating smart social proof...\n`);

    let totalReviewsAdded = 0;
    let recordsToInsert = [];
    const BATCH_SIZE = 100; // دفعات سريعة وآمنة

    for (const product of products) {
      const targetReviews = Math.floor(Math.random() * 15) + 5; // من 5 إلى 20 تقييم
      let applicableContents = getSmartReviews(product.title);
      let shuffledAuthors = shuffleArray([...authors]);
      let shuffledContents = shuffleArray([...applicableContents]);

      for (let i = 0; i < targetReviews; i++) {
        const author = shuffledAuthors[i % shuffledAuthors.length];
        const country = countries[Math.floor(Math.random() * countries.length)];
        const content = shuffledContents[i % shuffledContents.length];
        const rating = Math.random() > 0.15 ? 5 : 4; // 85% تقييمات 5 نجوم و 15% تقييمات 4 نجوم
        const daysAgo = Math.floor(Math.random() * 60) + 1;
        const created_at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

        recordsToInsert.push([product.id, author, rating, content, country, created_at]);

        if (recordsToInsert.length >= BATCH_SIZE) {
          await insertBatch(client, recordsToInsert);
          totalReviewsAdded += recordsToInsert.length;
          recordsToInsert = [];
        }
      }
    }

    if (recordsToInsert.length > 0) {
      await insertBatch(client, recordsToInsert);
      totalReviewsAdded += recordsToInsert.length;
    }

    console.log('\n==================================================');
    console.log(`🎉 SUCCESS! Added ${totalReviewsAdded} Smart Reviews across ${products.length} products.`);
    console.log('==================================================\n');
  } catch (err) {
    console.error('❌ Error seeding reviews:', err.message);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
}

async function insertBatch(client, records) {
  const values = [];
  const placeholders = [];
  let paramIdx = 1;

  for (const r of records) {
    placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`);
    values.push(...r);
    paramIdx += 6;
  }

  const query = `INSERT INTO reviews (product_id, author, rating, content, country, created_at) VALUES ${placeholders.join(', ')}`;
  await client.query(query, values);
}

seedReviewsForAllProducts();