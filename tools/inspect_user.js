// const sqlite3 = require('sqlite3').verbose();
// const id = process.argv[2] || 2;
// const db = new sqlite3.Database('./family.db', sqlite3.OPEN_READONLY, (err)=>{
//   if(err){ console.error('OPEN_ERR', err.message); process.exit(2); }
//   db.get('SELECT id,name,email,emails,parent_id,verified FROM users WHERE id = ?', [id], (e,row)=>{
//     if(e){ console.error('Q_ERR', e.message); process.exit(3); }
//     console.log(JSON.stringify(row, null, 2));
//     db.close();
//   });
// });
const { Pool } = require('pg');

const id = process.argv[2] || 2;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    const res = await pool.query(
      'SELECT id, name, email, emails, parent_id, verified FROM users WHERE id = $1',
      [id]
    );

    console.log(JSON.stringify(res.rows[0], null, 2));
  } catch (e) {
    console.error('QUERY_ERROR', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();