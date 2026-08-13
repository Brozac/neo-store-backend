require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const seedProduct = async () => {
  try {
    console.log('⏳ Adding sample product...');

    const query = `
      INSERT INTO products (title, description, price, image_url, cj_product_id, stock_status, colors, sizes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (cj_product_id) 
      DO UPDATE SET 
        price = EXCLUDED.price,
        stock_status = EXCLUDED.stock_status,
        image_url = EXCLUDED.image_url,
        colors = EXCLUDED.colors,
        sizes = EXCLUDED.sizes
      RETURNING *;
    `;

    const values = [
      'Smart Posture Corrector',
      'A smart wearable device to improve your back posture easily and effectively.',
      29.99, 
      '/placeholder.jpg', 
      'CJBNDTNS00012', 
      true,
      ['#8B78C6', '#357A8B', '#E38A8A'], // 🔥 الألوان الحقيقية
      ['S', 'M', 'L', 'XL']              // 🔥 المقاسات الحقيقية
    ];

    const result = await pool.query(query, values);
    console.log('✅ Sample product added successfully:', result.rows[0]);
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error seeding product:', err);
    process.exit(1);
  }
};

seedProduct();