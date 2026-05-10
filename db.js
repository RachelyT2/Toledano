require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // חשוב ל-Neon
});

async function testDb() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('DB connected:', res.rows[0]);
  } catch (err) {
    console.error('DB error:', err);
  }
}

module.exports = { pool, testDb };
