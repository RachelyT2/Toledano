const express = require('express');
const bodyParser = require('body-parser');
// const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const path = require('path');
// const { open } = require('sqlite');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
require('dotenv').config();
const { Pool } = require('pg');
async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // חשוב ל-Neon
});
const app = express();
// app.use(bodyParser.json());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
// const DB_PATH = process.env.DB_PATH || './family.db';
function sanitizeHtml(html){
  return html
    .replace(/<script.*?>.*?<\/script>/gi, '')
    .replace(/on\w+=".*?"/g, '');
}
function getBaseUrl(req) {
  return process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
}
async function testDb() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('DB connected:', res.rows[0]);
  } catch (err) {
    console.error('DB error:', err);
  }
}

testDb();
// async function initDb() {
//   const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS users (
//       id INTEGER PRIMARY KEY AUTOINCREMENT,
//       name TEXT NOT NULL,
//       email TEXT UNIQUE NOT NULL,
//       password_hash TEXT NOT NULL,
//       is_admin INTEGER DEFAULT 0,
//       verified INTEGER DEFAULT 0,
//       verification_token TEXT,
//       parent TEXT,
//       grandparent TEXT
//     );
//   `);
//   // ensure columns exist (for upgrades)
//   try { await db.run('ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0'); } catch(e){}
//   try { await db.run('ALTER TABLE users ADD COLUMN verification_token TEXT'); } catch(e){}
//   try { await db.run('ALTER TABLE users ADD COLUMN parent TEXT'); } catch(e){}
//   try { await db.run('ALTER TABLE users ADD COLUMN grandparent TEXT'); } catch(e){}
//   try { await db.run('ALTER TABLE users ADD COLUMN parent_id INTEGER'); } catch(e){}
//   try { await db.run("ALTER TABLE users ADD COLUMN parents TEXT"); } catch(e){}
//   try { await db.run("ALTER TABLE users ADD COLUMN emails TEXT"); } catch(e){}
//   try { await db.run("CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, details TEXT, extra TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed INTEGER DEFAULT 0, processed_by INTEGER, processed_at DATETIME, result TEXT)"); } catch(e){}
//   return db;
// }

// Helpers for parents array and cycle prevention
// async function loadAllUsers(){
//   const result = await pool.query('SELECT id, name, parent_id, parents FROM users');
//   const rows = result.rows;
//   // parse parents JSON
//   rows.rows.forEach(r=>{ try{ r.parents = r.parents ? JSON.parse(r.parents) : []; }catch(e){ r.parents = []; } });
//   return rows.rows;
// }
async function loadAllUsers() {
  const result = await pool.query('SELECT id, name, parent_id, parents FROM users');
  const rows = result.rows;

  // parse parents JSON
  rows.forEach(r => {
    try {
      r.parents = r.parents ? JSON.parse(r.parents) : [];
    } catch(e) {
      r.parents = [];
    }
  });

  return rows;
}
function buildAdjacency(rows){
  const map = {};
  rows.forEach(r=>{ 
    const parentsList = (Array.isArray(r.parents) && r.parents.length>0) ? r.parents : (r.parent_id ? [r.parent_id] : []);
    map[r.id] = { id: r.id, parents: parentsList, children: [] };
  });
  // build children lists
  Object.values(map).forEach(n=>{
    (n.parents||[]).forEach(p=>{ if(map[p]) map[p].children.push(n.id); });
  });
  return map;
}

function isDescendant(map, ancestorId, descendantId){
  // DFS from ancestorId to see if reachable descendantId
  const stack = [ancestorId];
  const seen = new Set();
  while(stack.length){
    const cur = stack.pop();
    if(seen.has(cur)) continue;
    seen.add(cur);
    const node = map[cur];
    if(!node) continue;
    for(const c of node.children){ if(c === descendantId) return true; stack.push(c); }
  }
  return false;
}

// async function validateParents(userId, parents){
//   // parents: array of ids (may be undefined/null)
//   if(!parents) return { ok:true, parents: [] };
//   if(!Array.isArray(parents)) return { ok:false, error:'parents must be array' };
//   // dedupe
//   const uniq = Array.from(new Set(parents.map(x=>parseInt(x)).filter(x=>!Number.isNaN(x))));
//   // check existence
//   if(uniq.length>0){
//     // const placeholders = uniq.map(()=>'?').join(',');
//     const placeholders = uniq.map((_, i) => `$${i+1}`).join(',');
//     // const found = await db.all(`SELECT id FROM users WHERE id IN (${placeholders})`, uniq);
//     const found = await pool.query(`SELECT id FROM users WHERE id = ANY($1)`,[uniq]);
//     // if(found.length !== uniq.length) return { ok:false, error:'one or more parents not found' };
//     if(found.rows.length !== uniq.length)
//       return { ok:false, error:'one or more parents not found' };
//   }
//   // load graph and ensure no cycles: none of the parents may be a descendant of userId
//   // const rows = await loadAllUsers(db);
//   const rows = await loadAllUsers();
//   const map = buildAdjacency(rows);
//   // include pending parents in map for userId
//   if(!map[userId]) map[userId] = { id: userId, parents: uniq||[], children: [] };
//   // rebuild children for safety
//   Object.values(map).forEach(n=>{ n.children = []; });
//   Object.values(map).forEach(n=>{ (n.parents||[]).forEach(p=>{ if(map[p]) map[p].children.push(n.id); }); });
//   for(const p of uniq){
//     if(p === userId) return { ok:false, error:'cannot set self as parent' };
//     if(isDescendant(map, userId, p)) return { ok:false, error:'cycle detected' };
//   }
//   return { ok:true, parents: uniq };
// }
async function validateParents(userId, parents){
  // console.log('VALIDATE PARENTS INPUT:', parents);
  if(!parents) return { ok:true, parents: [] };
  if(!Array.isArray(parents)) return { ok:false, error:'parents must be array' };
  // console.log('VALIDATE uniq');

  const uniq = Array.from(new Set(
    parents.map(x=>parseInt(x)).filter(x=>!Number.isNaN(x))
  ));
  // console.log('VALIDATE uniq result:', uniq);

  if(uniq.length > 0){
    const result = await pool.query(
      `SELECT id FROM users WHERE id = ANY($1)`,
      [uniq]
    );
  // console.log('3');

    const found = result.rows;
    // console.log('4', found);

    if(found.length !== uniq.length)
      return { ok:false, error:'one or more parents not found' };
  }
  // console.log('5');

  const rows = await loadAllUsers();
  // console.log('6');

  const map = buildAdjacency(rows);
  if(!map[userId])
    map[userId] = { id: userId, parents: uniq || [], children: [] };
  // console.log('MAP VALUES:', Object.values(map));

  // Object.values(map).forEach(n=>{ n.children = []; });
  Object.values(map).forEach(n => {
    if(n) {
      n.children = [];
    }
  });
  // Object.values(map).forEach(n=>{
  //   (n.parents||[]).forEach(p=>{
  //     if(map[p]) map[p].children.push(n.id);
  //   });
  // });


  // Object.values(map).forEach(n=>{
  //   if(!n) return;

  //   (n.parents || []).forEach(p=>{
  //     if(map[p] && map[p].children){
  //       map[p].children.push(n.id);
  //     }
  //   });
  // });

  Object.values(map).forEach(n => {

    if(!n) return;

    if(!Array.isArray(n.parents)) {
      n.parents = [];
    }

    if(!Array.isArray(n.children)) {
      n.children = [];
    }

    n.parents.forEach(p => {

      if(map[p]) {

        if(!Array.isArray(map[p].children)) {
          map[p].children = [];
        }

        map[p].children.push(n.id);
      }

    });

  });
  for(const p of uniq){
    if(p === userId)
      return { ok:false, error:'cannot set self as parent' };

    if(isDescendant(map, userId, p))
      return { ok:false, error:'cycle detected' };
  }

  return { ok:true, parents: uniq };
}
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  email = email.trim();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

async function getTransport() {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transport;
}
async function safeSendMail(mailOptions){
  try{
    const transport = await getTransport();
    return await transport.sendMail(mailOptions);
  }catch(e){
    console.error('SMTP send failed:', e);
    throw e;
  }
}
// async function safeSendMail(mailOptions){
//   try{
//     const transport = await getTransport();
//     const info = await transport.sendMail(mailOptions);
//     return info;
//   }catch(e){
//     console.error('Primary SMTP send failed:', e && e.message ? e.message : e);
//     try{
//       const testAccount = await nodemailer.createTestAccount();
//       const testTransport = nodemailer.createTransport({
//         host: testAccount.smtp.host,
//         port: testAccount.smtp.port,
//         secure: testAccount.smtp.secure,
//         auth: { user: testAccount.user, pass: testAccount.pass }
//       });
//       const info = await testTransport.sendMail(mailOptions);
//       const preview = nodemailer.getTestMessageUrl(info);
//       if(preview) console.log('Ethereal preview URL:', preview);
//       return info;
//     }catch(err){
//       console.error('Fallback test account send failed:', err && err.message ? err.message : err);
//       throw err;
//     }
//   }
// }

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing auth' });
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Invalid auth' });
  try { 
    const payload = jwt.verify(parts[1], JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
app.post('/api/register', async (req, res) => {
  const { name, email, password, parent, grandparent } = req.body;
  const is_admin = false;
  const parent_id = req.body.parent_id || null;
  const parentsInput = req.body.parents;
  const emailsInput = req.body.emails;

  if (!name || !email || !password)
    return res.status(400).json({ error: 'name,email,password required' });

  if (!isValidEmail(email))
    return res.status(400).json({ error: 'invalid email' });

  const hash = await bcrypt.hash(password, 10);
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');

  try {
    let parentsToStore = [];

    if (parentsInput !== undefined) {
      // const v = await validateParents({ query: (q) => pool.query(q) }, null, parentsInput);
      const v = await validateParents(null, parentsInput);
      if (!v.ok) return res.status(400).json({ error: v.error });
      parentsToStore = v.parents;
    }

    let emailsToStore = [];

    if (emailsInput !== undefined) {
      if (!Array.isArray(emailsInput))
        return res.status(400).json({ error: 'emails must be array' });

      for (const em of emailsInput) {
        if (!isValidEmail(em))
          return res.status(400).json({ error: 'invalid email in emails' });
      }

      emailsToStore = Array.from(new Set(emailsInput.map(s => String(s).trim())));
    } else {
      emailsToStore = [String(email).trim().toLowerCase()];
    }

    const result = await pool.query(
      `INSERT INTO users 
      (name,email,password_hash,is_admin,verified,verification_token,parent,grandparent,parent_id,parents,emails)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id`,
      [
        name,
        emailsToStore[0],
        hash,
        is_admin ? 1 : 0,
        0,
        token,
        parent || null,
        grandparent || null,
        parent_id,
        JSON.stringify(parentsToStore),
        JSON.stringify(emailsToStore)
      ]
    );

    const base = getBaseUrl(req);
    await sendVerificationEmail(emailsToStore[0], name, token, base);
    await notifyAdmin(`${name} <${emailsToStore[0]}> was added to the family list.`);

    res.json({ id: result.rows[0].id });

  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Could not create user' });
  }
});

// app.post('/api/register', async (req, res) => {
//   const { name, email, password, is_admin, parent, grandparent } = req.body;
//   const parent_id = req.body.parent_id || null;
//   const parentsInput = req.body.parents;
//   const emailsInput = req.body.emails;
//   if (!name || !email || !password) return res.status(400).json({ error: 'name,email,password required' });
//   if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
//   const db = await initDb();
//   const hash = await bcrypt.hash(password, 10);
//   const crypto = require('crypto');
//   const token = crypto.randomBytes(24).toString('hex');
//   try {
//     // validate parents array if provided
//     let parentsToStore = [];
//     if(parentsInput !== undefined){
//       const v = await validateParents(db, null, parentsInput);
//       if(!v.ok) return res.status(400).json({ error: v.error });
//       parentsToStore = v.parents;
//     }
//     // emails: allow either single email or array
//     let emailsToStore = [];
//     if(emailsInput !== undefined){
//       if(!Array.isArray(emailsInput)) return res.status(400).json({ error: 'emails must be array' });
//       for(const em of emailsInput){ if(!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
//       emailsToStore = Array.from(new Set(emailsInput.map(s=>String(s).trim())));
//     } else {
//       if(!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
//       emailsToStore = [String(email).trim()];
//     }
//     // validate parent_id if provided
//     if(parent_id){
//       const v2 = await validateParents(db, null, [parent_id]);
//       if(!v2.ok) return res.status(400).json({ error: v2.error });
//     }
//     const result = await db.run('INSERT INTO users (name,email,password_hash,is_admin,verified,verification_token,parent,grandparent,parent_id,parents,emails) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [name, emailsToStore[0], hash, is_admin ? 1 : 0, 0, token, parent || null, grandparent || null, parent_id, JSON.stringify(parentsToStore), JSON.stringify(emailsToStore)]);
//     // send verification email
//     const base = getBaseUrl(req);
//     await sendVerificationEmail(email, name, token, base);
//     await notifyAdmin(`${name} <${email}> was added to the family list.`);
//     res.json({ id: result.lastID });
//   } catch (e) {
//     res.status(400).json({ error: 'Could not create user', detail: e.message });
//   }
// });

// Admin creates a user (sends verification). Returns temporary password so admin can share it.
app.post('/api/users', authMiddleware, async (req, res) => {
  // console.log('CREATE USER BODY:', req.body);
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { name, email, is_admin, parent, grandparent } = req.body;
  const parent_id = req.body.parent_id || null;
  const parentsInput = req.body.parents;
  const emailsInput = req.body.emails;
  if (!name || !email) return res.status(400).json({ error: 'name,email required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
  // const db = await initDb();
  const crypto = require('crypto');
  const tempPassword = crypto.randomBytes(6).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);
  const token = crypto.randomBytes(24).toString('hex');
  try {
    let parentsToStore = [];
    if(parentsInput !== undefined){
      const v = await validateParents(null, parentsInput);
      if(!v.ok) return res.status(400).json({ error: v.error });
      parentsToStore = v.parents;
    }
    let emailsToStore = [];
    if(emailsInput !== undefined){
      if(!Array.isArray(emailsInput)) return res.status(400).json({ error: 'emails must be array' });
      for(const em of emailsInput){ if(!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
      emailsToStore = Array.from(new Set(emailsInput.map(s=>String(s).trim())));
    } else {
      if(!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
      emailsToStore = [String(email).trim()];
    }
    // validate parent_id if provided
    if(parent_id){
      const v2 = await validateParents(null, [parent_id]);
      if(!v2.ok) return res.status(400).json({ error: v2.error });
    }
    // const result = await db.run('INSERT INTO users (name,email,password_hash,is_admin,verified,verification_token,parent,grandparent,parent_id,parents,emails) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [name, emailsToStore[0], hash, is_admin ? 1 : 0, 0, token, parent || null, grandparent || null, parent_id, JSON.stringify(parentsToStore), JSON.stringify(emailsToStore)]);
    // console.log('BEFORE INSERT');
    let result;
    try {
    const adminValue = (is_admin === true || is_admin === 'true' || is_admin === 1);
    result = await pool.query(
    `INSERT INTO users 
    (name,email,password_hash,is_admin,verified,verification_token,parent,grandparent,parent_id,parents,emails)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id`,
    [
      name,
      emailsToStore[0],
      hash,
      adminValue ? 1 : 0,
      0,
      token,
      parent || null,
      grandparent || null,
      parent_id,
      JSON.stringify(parentsToStore),
      JSON.stringify(emailsToStore)
    ]
  );
    } catch (e) {
      console.error('DB ERROR:', e);
    }
  // console.log('AFTER INSERT');
    const base = getBaseUrl(req);
    // console.log('A - before email');
    // send welcome email with temporary password to the new user (do not return password to admin)
    try {
    await sendNewUserWelcomeEmail(emailsToStore[0], name, tempPassword, token, base);
    } catch (e) {
      console.error('EMAIL FAILED:', e);
    }

    try {
    await notifyAdmin(`Admin ${req.user.email} added: ${name} <${emailsToStore[0]}>`);
    } catch (e) {      console.error('NOTIFY FAILED:', e);    }
    res.json({ id: result.rows[0].id }); 
   } catch (e) {
    res.status(400).json({ error: 'Could not create user', detail: e.message });
  }

});

// app.post('/api/resend-verification', authMiddleware, async (req, res) => {
//   const db = await initDb();
//   const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
//   if (!user) return res.status(404).json({ error: 'not found' });
//   if (user.verified) return res.status(400).json({ error: 'already verified' });
//   const crypto = require('crypto');
//   const token = crypto.randomBytes(24).toString('hex');
//   await db.run('UPDATE users SET verification_token=? WHERE id=?', [token, user.id]);
//   const base = getBaseUrl(req);
//   await sendVerificationEmail(user.email, user.name, token, base);
//   res.json({ ok: true });
// });
app.post('/api/resend-verification', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'not found' });
    }

    if (user.verified) {
      return res.status(400).json({ error: 'already verified' });
    }

    const crypto = require('crypto');
    const token = crypto.randomBytes(24).toString('hex');

    await pool.query(
      'UPDATE users SET verification_token = $1 WHERE id = $2',
      [token, user.id]
    );

    const base = getBaseUrl(req);

    await sendVerificationEmail(user.email, user.name, token, base);

    res.json({ ok: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// app.get('/verify', async (req, res) => {
//   const { token } = req.query;
//   if (!token) return res.status(400).send('Missing token');
//   const db = await initDb();
//   const user = await db.get('SELECT * FROM users WHERE verification_token = ?', [token]);
//   if (!user) return res.status(400).send('<h3>טוקן לא תקין</h3>');
//   await db.run('UPDATE users SET verified=1, verification_token=NULL WHERE id=?', [user.id]);
//   res.send('<h3>האימייל אושר בהצלחה — ניתן לסגור חלון זה.</h3>');
// });
app.get('/verify', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('Missing token');
  }

  try {
    // 1. שליפת המשתמש לפי הטוקן
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE verification_token = $1',
      [token]
    );

    const user = rows[0];

    if (!user) {
      return res.status(400).send('<h3>טוקן לא תקין</h3>');
    }

    // 2. עדכון המשתמש לאומת
    await pool.query(
      'UPDATE users SET verified = 1, verification_token = NULL WHERE id = $1',
      [user.id]
    );

    // 3. תשובה לדפדפן
    res.send('<h3>האימייל אושר בהצלחה — ניתן לסגור חלון זה.</h3>');

  } catch (err) {
    console.error('VERIFY ERROR:', err);
    res.status(500).send('server error');
  }
});
// app.post('/api/login', async (req, res) => {
//   const { email, password } = req.body;
//   if (!email || !password) return res.status(400).json({ error: 'email,password required' });
//   const db = await initDb();
//   const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
//   if (!user) return res.status(401).json({ error: 'Invalid credentials' });
//   const ok = await bcrypt.compare(password, user.password_hash);
//   if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
//   const token = jwt.sign({ id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin, verified: !!user.verified }, JWT_SECRET, { expiresIn: '12h' });
//   res.json({ token });
// });
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email,password required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    const user = rows[0];


    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        is_admin: !!user.is_admin,
        verified: !!user.verified
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});
app.post('/api/users/:id/resend', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  // const db = await initDb();
  // const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  const { rows } = await pool.query(
  'SELECT * FROM users WHERE id = $1',
    [id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.verified) return res.status(400).json({ error: 'already verified' });
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  // await db.run('UPDATE users SET verification_token=? WHERE id=?', [token, user.id]);
  await pool.query(
  'UPDATE users SET verification_token = $1 WHERE id = $2',
  [token, user.id]
  );
  const base = getBaseUrl(req);
  await sendVerificationEmail(user.email, user.name, token, base);
  res.json({ ok: true });
});

// app.get('/api/users', authMiddleware, async (req, res) => {
//   const db = await initDb();
//   const q = req.query.q;
//   const parent_id = req.query.parent_id;
//   let rows;
//   if (parent_id) {
//     // return direct children of given parent_id (lazy-load)
//     rows = await db.all('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users WHERE parent_id = ? ORDER BY name', [parent_id]);
//   } else if (q) {
//     rows = await db.all("SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users WHERE name LIKE '%'||?||'%' OR email LIKE '%'||?||'%' ORDER BY name", [q, q]);
//   } else {
//     rows = await db.all('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users ORDER BY name');
//   }
//   // parse parents JSON for each row
//   rows.forEach(r=>{ try{ r.parents = r.parents ? JSON.parse(r.parents) : []; }catch(e){ r.parents = []; } try{ r.emails = r.emails ? JSON.parse(r.emails) : (r.email ? [r.email] : []); }catch(e){ r.emails = r.email ? [r.email] : []; } r.email = r.emails && r.emails.length ? r.emails[0] : r.email; });
//   res.json(rows);
// });
app.get('/api/users', authMiddleware, async (req, res) => {
  const q = req.query.q;
  const parent_id = req.query.parent_id;

  let result;

  if (parent_id) {
    result = await pool.query(
      `SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails 
       FROM users 
       WHERE parent_id = $1 
       ORDER BY name`,
      [parent_id]
    );
  } else if (q) {
    result = await pool.query(
      `SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails 
       FROM users 
       WHERE name ILIKE '%' || $1 || '%' 
       OR email ILIKE '%' || $1 || '%' 
       ORDER BY name`,
      [q]
    );
  } else {
    result = await pool.query(
      `SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails 
       FROM users 
       ORDER BY name`
    );
  }

  const rows = result.rows;

  rows.forEach(r => {
    try { r.parents = r.parents ? JSON.parse(r.parents) : []; } catch { r.parents = []; }
    try { r.emails = r.emails ? JSON.parse(r.emails) : (r.email ? [r.email] : []); } catch { r.emails = r.email ? [r.email] : []; }
    r.email = r.emails && r.emails.length ? r.emails[0] : r.email;
  });

  res.json(rows);
});
app.put('/api/users/:id', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  const { name, email, is_admin, parent, grandparent } = req.body;
  const parent_id = req.body.parent_id === undefined ? undefined : req.body.parent_id;
  const parentsInput = req.body.parents === undefined ? undefined : req.body.parents;
  const emailsInput = req.body.emails === undefined ? undefined : req.body.emails;
  // const db = await initDb();
  try {
    // const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    const { rows } = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [id]
    );
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: 'not found' });
    const newEmail = email || existing.email;
    const willChangeEmail = newEmail !== existing.email;
    let token = null;
    if (willChangeEmail) {
      const crypto = require('crypto');
      token = crypto.randomBytes(24).toString('hex');
    }
    // validate parents if provided
    let parentsToStore = existing.parents ? (typeof existing.parents === 'string' ? JSON.parse(existing.parents) : existing.parents) : [];
    let emailsToStore = existing.emails ? (typeof existing.emails === 'string' ? JSON.parse(existing.emails) : existing.emails) : (existing.email ? [existing.email] : []);
    if(parentsInput !== undefined){
      const v = await validateParents(parseInt(id), parentsInput);
      if(!v.ok) return res.status(400).json({ error: v.error });
      parentsToStore = v.parents;
    }
    // validate parent_id if provided
    if(parent_id !== undefined){
      const v2 = await validateParents(parseInt(id), parent_id ? [parent_id] : []);
      if(!v2.ok) return res.status(400).json({ error: v2.error });
      // if parent_id is provided and parents not provided, keep parentsToStore unchanged
    }
    if(emailsInput !== undefined){
      if(!Array.isArray(emailsInput)) return res.status(400).json({ error: 'emails must be array' });
      for(const em of emailsInput){ if(!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
      emailsToStore = Array.from(new Set(emailsInput.map(s=>String(s).trim())));
    }
    // await db.run('UPDATE users SET name=?, email=?, is_admin=?, verified=?, verification_token=?, parent=?, grandparent=?, parent_id=?, parents=?, emails=? WHERE id=?', [name || existing.name, newEmail, is_admin ? 1 : 0, willChangeEmail ? 0 : existing.verified, willChangeEmail ? token : existing.verification_token, parent===undefined?existing.parent:parent, grandparent===undefined?existing.grandparent:grandparent, parent_id===undefined?existing.parent_id:parent_id, JSON.stringify(parentsToStore), JSON.stringify(emailsToStore), id]);
    await pool.query(`UPDATE users SET name=$1,email=$2,is_admin=$3,verified=$4,verification_token=$5,parent=$6,grandparent=$7,parent_id=$8,parents=$9,emails=$10 WHERE id=$11`,
      [
        name || existing.name,
        newEmail,
        is_admin ? 1 : 0,
        willChangeEmail ? 0 : existing.verified,
        willChangeEmail ? token : existing.verification_token,
        parent === undefined ? existing.parent : parent,
        grandparent === undefined ? existing.grandparent : grandparent,
        parent_id === undefined ? existing.parent_id : parent_id,
        JSON.stringify(parentsToStore),
        JSON.stringify(emailsToStore),
        id
      ]
    );
    if (willChangeEmail) {
      const base = getBaseUrl(req);
      if (!isValidEmail(newEmail)) return res.status(400).json({ error: 'invalid email' });
      await sendVerificationEmail(newEmail, name || existing.name, token, base);
    }
    await notifyAdmin(`User updated: ${name || existing.name} <${newEmail}>`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  // const db = await initDb();
  // const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  const { rows } = await pool.query(
  'SELECT * FROM users WHERE id = $1',
  [id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'not found' });
  // If this user has children, do NOT delete the row. Instead clear email(s) so UI shows "no email".
  try{
    // const all = await db.all('SELECT id,parent_id,parents FROM users');
    const { rows: all } = await pool.query('SELECT id, parent_id, parents FROM users');
    let hasChildren = false;
    for(const r of all){
      if(String(r.parent_id) === String(id)) { hasChildren = true; break; }
      if(r.parents){
        try{
          const arr = typeof r.parents === 'string' ? JSON.parse(r.parents) : r.parents;
          if(Array.isArray(arr) && arr.map(x=>String(x)).includes(String(id))){ hasChildren = true; break; }
        }catch(e){}
      }
    }

    if(hasChildren){
      // keep the user row, but set a unique placeholder email and clear emails so UI shows "no email"
      try{
        const placeholder = `deleted+${id}+${Date.now()}@example.invalid`;
        // await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder, JSON.stringify([]), id]);
        await pool.query('UPDATE users SET email = $1, emails = $2 WHERE id = $3',[placeholder, JSON.stringify([]), id]);
        await notifyAdmin(`User marked no-email (has children): ${user.name} (id:${id})`);
        return res.json({ ok:true, replaced:true });
      }catch(updErr){
        console.error('Failed to mark user no-email (fallback):', updErr && updErr.message ? updErr.message : updErr);
        // If update fails due to UNIQUE constraint, try alternative placeholder with random suffix
        // if(String(updErr && updErr.message || '').includes('UNIQUE constraint')){
        //   const placeholder2 = `deleted+${id}+${Date.now()}+${Math.floor(Math.random()*100000)}@example.invalid`;
        //   await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder2, JSON.stringify([]), id]);
        //   await notifyAdmin(`User marked no-email (has children, fallback): ${user.name} (id:${id})`);
        //   return res.json({ ok:true, replaced:true });
        // }
        if(String(updErr && updErr.message || '').includes('UNIQUE constraint')){
          const placeholder2 = `deleted+${id}+${Date.now()}+${Math.floor(Math.random()*100000)}@example.invalid`;

          await pool.query('UPDATE users SET email = $1, emails = $2 WHERE id = $3',[placeholder2, JSON.stringify([]), id]);
          await notifyAdmin(`User marked no-email (has children, fallback): ${user.name} (id:${id})`);
          return res.json({ ok:true, replaced:true });
      }
        throw updErr;
      }
    }

    // No children -> proceed to orphan any references and delete
    // await db.run('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [id]);
    await pool.query('UPDATE users SET parent_id = NULL WHERE parent_id = $1',[id]);
    // remove from parents JSON arrays
    // const children = await db.all('SELECT id, parents FROM users WHERE parents IS NOT NULL');
    const { rows: children } = await pool.query('SELECT id, parents FROM users WHERE parents IS NOT NULL');
    for(const c of children){
      try{
        const arr = c.parents ? JSON.parse(c.parents) : [];
        const newArr = arr.filter(x=>String(x) !== String(id));
        if(newArr.length !== arr.length) 
          await pool.query('UPDATE users SET parents = $1 WHERE id = $2',[JSON.stringify(newArr), c.id]);
          // await db.run('UPDATE users SET parents = ? WHERE id = ?', [JSON.stringify(newArr), c.id]);
      }catch(e){}
    }
    try{
      // await db.run('DELETE FROM users WHERE id = ?', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }catch(delErr){
      // handle potential UNIQUE constraint issues (e.g., duplicate empty emails)
      console.error('Delete user failed, attempting fallback cleanup:', delErr && delErr.message ? delErr.message : delErr);
      // if(String(delErr && delErr.message || '').includes('UNIQUE constraint')){
      //   try{
      //     const placeholder = `deleted+${id}+${Date.now()}@example.invalid`;
      //     await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder, JSON.stringify([]), id]);
      //     await db.run('DELETE FROM users WHERE id = ?', [id]);
      //   }catch(fallbackErr){
      //     console.error('Fallback delete also failed:', fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
      //     throw fallbackErr;
      if(String(delErr && delErr.message || '').includes('UNIQUE constraint')){
        try{
          const placeholder = `deleted+${id}+${Date.now()}@example.invalid`;
          await pool.query(
          'UPDATE users SET email = $1, emails = $2 WHERE id = $3',
          [placeholder, JSON.stringify([]), id]
          );
          await pool.query('DELETE FROM users WHERE id = $1',[id]);

      }catch(fallbackErr){
        console.error('Fallback delete also failed:', fallbackErr?.message || fallbackErr);
        throw fallbackErr;
      }
    } else {
        throw delErr;
      }
    }
  } catch(e){
    return res.status(500).json({ error: e.message });
  }
  await notifyAdmin(`User removed: ${user.name} <${user.email}>`);
  res.json({ ok: true });
});

app.post('/api/send', authMiddleware, upload.array('files'), async (req, res) => {  let { recipients, subject, message } = req.body;
  // when using multipart/form-data (FormData) recipients may arrive as a JSON string
  try{
    if (typeof recipients === 'string'){
      try{ recipients = JSON.parse(recipients); }
      catch(_){ // fallback: allow comma-separated ids
        recipients = recipients.split(',').map(s=>s.trim()).filter(Boolean);
      }
    }
  }catch(e){ /* ignore */ }
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ error: 'recipients required' });
  // normalize ids to simple values for the SQL placeholders
  recipients = recipients.map(r=>{ if(typeof r === 'string' && r.match(/^\d+$/)) return parseInt(r); return r; });
  const files = req.files || [];
  // const db = await initDb();
  const{ rows } = await pool.query(`SELECT id,emails,name,email FROM users WHERE id= ANY($1)`, [recipients]);
  if (!rows || rows.length === 0) return res.status(400).json({ error: 'no recipients found' });

  // ensure sender is verified
  const { rows: senderRows } = await pool.query('SELECT * FROM users WHERE id = $1',[req.user.id]);
  const sender = senderRows[0];
  // const sender = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!sender) return res.status(404).json({ error: 'sender not found' });
  if (!sender.verified) return res.status(403).json({ error: 'sender email not verified' });

  try {
    // flatten emails arrays and dedupe
    let sendTo = [];
    rows.forEach(r=>{
      try{ const arr = r.emails ? JSON.parse(r.emails) : (r.email?[r.email]:[]); sendTo = sendTo.concat(arr); }catch(e){ if(r.email) sendTo.push(r.email); }
    });
    sendTo = Array.from(new Set(sendTo.map(s=>String(s).trim())));
    // if no actual email addresses resolved, return a clear error
    if(!sendTo || sendTo.length === 0){
      console.error('No resolved recipient email addresses for recipients:', recipients);
      return res.status(400).json({ error: 'no recipient emails resolved' });
    }
    const serverFrom = process.env.SMTP_USER || 'no-reply@example.com';
    const replyTo = `${req.user.name} <${req.user.email}>`;
    const fromDisplay = `${req.user.name} דרך המשפחה <${serverFrom}>`;
    const senderLineText = `נשלח על ידי: ${req.user.name} <${req.user.email}>\n\n`;
    const senderLineHtml = `<p><strong>נשלח על ידי: ${escapeHtml(req.user.name)} &lt;${escapeHtml(req.user.email)}&gt;</strong></p>`;
    // sanitize and wrap message for RTL display
    const safeMessage = sanitizeHtml(message || '');
    const htmlBody = `
      <div dir="rtl" style="font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; text-align:right; direction:rtl;">
        ${senderLineHtml}
        <div>
          ${safeMessage}
        </div>
      </div>
    `;
    await safeSendMail({
      from: fromDisplay,
      to: sendTo.join(','),
      replyTo,
      subject: subject || '(no subject)',
      text: senderLineText + (message || ''),
      html: htmlBody,
      attachments: files.map(f => ({ filename: f.originalname, path: f.path }))
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Sending failed', detail: e.message });
  }
});

// return prepared hierarchical tree (server-side) to simplify frontend
app.get('/api/tree', authMiddleware, async (req, res) => {
  // const db = await initDb();
  // const rows = await db.all('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users ORDER BY name');
  const { rows } = await pool.query('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users ORDER BY name');
  rows.forEach(r=>{ try{ r.parents = r.parents ? JSON.parse(r.parents) : []; }catch(e){ r.parents = []; } try{ r.emails = r.emails ? JSON.parse(r.emails) : (r.email?[r.email]:[]); }catch(e){ r.emails = r.email?[r.email]:[]; } r.email = r.emails && r.emails.length ? r.emails[0] : r.email; });
  // choose primary parent for tree building: parent_id if present, else first of parents array
  const map = {};
  rows.forEach(r=>{ r.children = []; map[r.id] = r; });
  const roots = [];
  rows.forEach(r=>{
    const p = r.parent_id || (r.parents && r.parents.length ? r.parents[0] : null);
    if(p && map[p]) map[p].children.push(r);
    else roots.push(r);
  });
  res.json(roots);
});

// Export hierarchical Excel file (admin: all users, non-admin: user's subtree)
app.get('/api/export-xlsx', authMiddleware, async (req, res) => {
  try{
    // const db = await initDb();
    const { rows } = await pool.query('SELECT id,name,email,phone,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users');
    // const rows = await db.all('SELECT id,name,email,phone,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users');
    rows.forEach(r=>{ try{ r.parents = r.parents ? JSON.parse(r.parents) : []; }catch(e){ r.parents = []; } try{ r.emails = r.emails ? JSON.parse(r.emails) : (r.email?[r.email]:[]); }catch(e){ r.emails = r.email?[r.email]:[]; } r.email = r.emails && r.emails.length ? r.emails[0] : r.email; });
    const map = {};
    rows.forEach(r=>{ r.children = []; map[r.id] = r; });
    // build tree using parent_id if present, else first element of parents array
    rows.forEach(r=>{
      const p = r.parent_id || (r.parents && r.parents.length ? r.parents[0] : null);
      if(p && map[p]) map[p].children.push(r);
    });

    // choose roots depending on admin
    let roots = [];
    if(req.user.is_admin){
      rows.forEach(r=>{ const p = r.parent_id || (r.parents && r.parents.length ? r.parents[0] : null); if(!(p && map[p])) roots.push(r); });
    } else {
      const me = map[req.user.id];
      if(!me) return res.status(404).json({ error: 'user not found' });
      roots = [me];
    }

    // prepare workbook
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Family Hierarchy');
    // Simplified Hebrew headers: Level, Name, Email, Phone, Parent Chain
    sheet.columns = [
      { header: 'רמה', key: 'level', width: 8 },
      { header: 'שם', key: 'name', width: 40 },
      { header: 'מייל', key: 'email', width: 36 },
      { header: 'טלפון', key: 'phone', width: 18 },
      { header: 'שרשרת הורים', key: 'parent_chain', width: 60 }
    ];
    // style header row (bold + colored background)
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
    // right-align Hebrew text for name and parent chain
    sheet.getColumn('name').alignment = { horizontal: 'right' };
    sheet.getColumn('parent_chain').alignment = { horizontal: 'right' };

    // helper to map parent ids to names
    const idToName = {};
    Object.values(map).forEach(n=>{ idToName[n.id] = n.name; });

    // DFS traversal
    function addNode(node, level, parentChainIds){
      const parentChainNames = (parentChainIds||[]).map(id=> idToName[id] || String(id)).join(' > ');
      const indent = Array(Math.max(0, level-1)).fill('—').join(' ');
      const row = sheet.addRow({ level, name: (indent ? indent + ' ' : '') + (node.name||''), email: (node.emails||[]).length ? (node.emails||[])[0] : (node.email||''), phone: node.phone||'', parent_chain: parentChainNames });
      // apply coloring by hierarchy level (soft pastels)
      const levelColors = {
        1: 'FFE8F4FF', // light blue
        2: 'FFECFDF5', // light green
        3: 'FFFFF7ED', // light yellow
        4: 'FFF5F3FF', // light purple
        5: 'FFFFFBEB'  // light peach
      };
      const color = levelColors[level] || levelColors[5];
      const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
      row.eachCell((cell, colNumber) => {
        cell.fill = fill;
        // align name and parent_chain to right for Hebrew
        const colKey = sheet.getColumn(colNumber).key;
        if(colKey === 'name' || colKey === 'parent_chain') cell.alignment = { horizontal: 'right', vertical: 'middle' };
        else cell.alignment = { horizontal: 'left', vertical: 'middle' };
      });
      if(node.children && node.children.length){
        // sort children by name
        node.children.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
        for(const c of node.children){ addNode(c, level+1, (parentChainIds||[]).concat(node.id)); }
      }
    }

    // sort roots by name
    roots.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
    roots.forEach(r=> addNode(r, 1, r.parents && r.parents.length ? r.parents.slice(0) : []));

    const filename = `family-hierarchy-${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  }catch(e){
    console.error('export-xlsx failed', e && e.message ? e.message : e);
    res.status(500).json({ error: 'failed to generate excel', detail: e.message });
  }
});

async function notifyAdmin(text) {
  try {
    if (!process.env.ADMIN_EMAIL) return;
    await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: process.env.ADMIN_EMAIL, subject: 'Family list notification', text: text });
  } catch (e) {
    console.error('notifyAdmin failed', e.message);
  }
}

// Allow users to send requests to admin (add/edit/remove) via site
app.post('/api/request-admin', authMiddleware, async (req, res) => {
  const { action, details } = req.body || {};
  console.log('REQUEST HIT /api/request-admin');
  if (!process.env.ADMIN_EMAIL) return res.status(500).json({ error: 'ADMIN_EMAIL not configured' });
  const user = req.user;
  const subj = `בקשת מנהל: ${action || 'כללי'} - ${user.name}`;
  const extra = req.body.extra || {};
  let text = `User: ${user.name} <${user.email}>\nAction: ${action || ''}\n\nDetails:\n${details || ''}`;
  if(extra.father_id) text += `\nFather ID: ${extra.father_id}`;
  if(extra.grandfather_id) text += `\nGrandfather ID: ${extra.grandfather_id}`;
  try{
    // const db = await initDb();
    // store request for admin review
    // const insert = await db.run('INSERT INTO requests (user_id, action, details, extra) VALUES (?,?,?,?)', [user.id, action || '', details || '', JSON.stringify(extra || {})]);
    const { rows } = await pool.query(`INSERT INTO requests (user_id, action, details, extra) VALUES ($1, $2, $3, $4) RETURNING id`,
    [user.id, action || '', details || '', JSON.stringify(extra || {})]
    );
    console.log('INSERT RESULT:', rows[0].id);
    const requestId = rows[0].id;
  
    await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: process.env.ADMIN_EMAIL, subject: subj, text, replyTo: `${user.name} <${user.email}>` });
    // res.json({ ok: true, requestId: insert.lastID });
    res.json({ ok: true, requestId });

  }catch(e){ res.status(500).json({ error: 'failed to send', detail: e.message }); }
});

// List pending requests (admin)
// app.get('/api/requests', authMiddleware, async (req, res) => {
//   if(!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
//   const db = await initDb();
//   const rows = await db.all('SELECT r.id, r.user_id, u.name as requester_name, u.email as requester_email, r.action, r.details, r.extra, r.created_at FROM requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.processed = 0 ORDER BY r.created_at DESC');
//   rows.forEach(r=>{ try{ r.extra = r.extra ? JSON.parse(r.extra) : {}; }catch(e){ r.extra = {}; } });
//   res.json(rows);
// });
app.get('/api/requests', authMiddleware, async (req, res) => {
  // console.log('🔥 ENTER REQUESTS API');
  // console.log('params:', req.params);
  // console.log('query:', req.query);
  // console.log('user:', req.user);
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });

  try {
    const result = await pool.query(`
      SELECT 
        r.id,
        r.user_id,
        u.name as requester_name,
        u.email as requester_email,
        r.action,
        r.details,
        r.extra,
        r.created_at
      FROM requests r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.processed = 0
      ORDER BY r.created_at DESC
    `);

    const rows = result.rows;

    rows.forEach(r => {
      try {
        r.extra = r.extra ? JSON.parse(r.extra) : {};
      } catch (e) {
        r.extra = {};
      }
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Approve a request (admin) - will perform add/edit/delete based on action
app.post('/api/requests/:id/approve', authMiddleware, async (req, res) => {
  if(!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  // const { id } = req.params;
  // const db = await initDb();
  const id = req.params.id;
  // const row = await db.get('SELECT * FROM requests WHERE id = ?', [id]);
  const { rows } = await pool.query('SELECT * FROM requests WHERE id = $1',[id]);
  const row = rows[0];
  if(!row) return res.status(404).json({ error: 'request not found' });
  if(row.processed) return res.status(400).json({ error: 'already processed' });
  let extra = {};
  try{ extra = row.extra ? JSON.parse(row.extra) : {}; }catch(e){ extra = {}; }
  const actorId = req.user.id;
  try{
    if(row.action === 'add_user' || extra.add_user){
      // create user using fields in extra (support either extra.add_user or extra flattened)
      const data = extra.add_user || extra || {};
      const name = data.name || extra.name || (row.details?String(row.details).split('\n')[0]: '');
      const emailsArr = Array.isArray(data.emails) ? data.emails : (extra.emails || []);
      const emailPrimary = emailsArr && emailsArr.length ? emailsArr[0] : (extra.email || null);
      const phone = data.phone || extra.phone || null;
      const is_admin = data.is_admin ? 1 : 0;
      if(!emailPrimary) throw new Error('missing primary email for new user');
      const crypto = require('crypto');
      const tempPassword = crypto.randomBytes(6).toString('hex');
      const hash = await bcrypt.hash(tempPassword, 10);
      const token = crypto.randomBytes(24).toString('hex');
      // determine parent_id from several possible fields (parent_id, father_id)
      const requestedParentId = (data.parent_id !== undefined && data.parent_id !== null) ? data.parent_id : (data.father_id || extra.parent_id || extra.father_id || null);
      let parent_id = null;
      let parentName = null;
      let grandparentName = null;
      let parentsToStoreArr = [];
      if(requestedParentId){
        // const pRow = await db.get('SELECT id,name,parent_id,parents FROM users WHERE id = ?', [requestedParentId]);
        const { rows } = await pool.query('SELECT id, name, parent_id, parents FROM users WHERE id = $1',[requestedParentId]);
        const pRow = rows[0];
        if(pRow){
          parent_id = pRow.id;
          parentName = pRow.name;
          // compute grandparent name: try pRow.parent (name) else use parent_id of parent
          if(pRow.parent_id){
            // const gp = await db.get('SELECT name FROM users WHERE id = ?', [pRow.parent_id]);
            const { rows: gpRows } = await pool.query('SELECT name FROM users WHERE id = $1',[pRow.parent_id]);
            const gp = gpRows[0];
            if(gp) grandparentName = gp.name;
          } else if(pRow.parent){
            grandparentName = pRow.parent;
          }
          // build parents array: take parent's parents if present, then append parent id
          try{ parentsToStoreArr = pRow.parents ? (typeof pRow.parents === 'string' ? JSON.parse(pRow.parents) : pRow.parents) : []; }catch(e){ parentsToStoreArr = []; }
          parentsToStoreArr = Array.isArray(parentsToStoreArr) ? parentsToStoreArr.slice() : [];
          if(!parentsToStoreArr.map(String).includes(String(pRow.id))) parentsToStoreArr.push(pRow.id);
        } else {
          // requested parent not found; ignore
          parent_id = null;
        }
      } else {
        // no parent requested; use any provided parent name strings
        parentName = data.parent || extra.parent || null;
        grandparentName = data.grandparent || extra.grandparent || null;
        parentsToStoreArr = data.parents || extra.parents || [];
      }
      const parentsToStore = JSON.stringify(parentsToStoreArr || []);
      // const result = await db.run('INSERT INTO users (name,email,password_hash,is_admin,verified,verification_token,parent,grandparent,parent_id,parents,emails,phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [name, emailPrimary, hash, is_admin, 0, token, parentName || null, grandparentName || null, parent_id, parentsToStore, JSON.stringify(emailsArr||[emailPrimary]), phone]);
      const result = await pool.query(
          `INSERT INTO users (
            name, email, password_hash, is_admin, verified,
            verification_token, parent, grandparent, parent_id,
            parents, emails, phone
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id`,
          [
            name,
            emailPrimary,
            hash,
            is_admin ? 1 : 0,
            0,
            token,
            parentName || null,
            grandparentName || null,
            parent_id,
            parentsToStore,
            JSON.stringify(emailsArr || [emailPrimary]),
            phone
          ]
        );
      const base = getBaseUrl(req);
      await sendNewUserWelcomeEmail(emailPrimary, name, tempPassword, token, base);
      const resultMsg = 'approved: created user id '+result.lastID;
      await pool.query(`UPDATE requests SET processed = 1,processed_by = $1,processed_at = NOW(),result = $2 WHERE id = $3`,[actorId, resultMsg, id]);
      // await db.run('UPDATE requests SET processed=1, processed_by=?, processed_at=CURRENT_TIMESTAMP, result=? WHERE id=?', [actorId, resultMsg, id]);
      try{

        // const requester = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
        const requesterRes = await pool.query('SELECT * FROM users WHERE id = $1',[row.user_id]);
        const requester = requesterRes.rows[0];
        if(requester && requester.email){
          await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: requester.email, subject: 'בקשתך אושרה', text: `שלום ${requester.name || ''},\n\nבקשתך ליצור משתמש אושרה. נוצר משתמש עם מזהה ${result.lastID}.\n\nבברכה, מנהל המערכת.` });
        }
      }catch(_){ }
      return res.json({ ok:true, createdId: result.lastID });
    }
    if(row.action === 'edit_user' || extra.edit_user){
      const data = extra.edit_user || extra || {};
      // allow requests that don't include explicit target id (e.g. self-edit): fall back to requester id
      const targetId = data.id || extra.id || row.user_id;
      if(!targetId) throw new Error('missing target id for edit');
      // const existing = await db.get('SELECT * FROM users WHERE id = ?', [targetId]);
      const existingRes = await pool.query('SELECT * FROM users WHERE id = $1',[targetId]);
      const existing = existingRes.rows[0];
      if(!existing) throw new Error('target user not found');
      // prepare potential parent updates
      let parent_id = null;
      let parentName = null;
      let grandparentName = null;
      let parentsToStoreArr = [];
      // accept either parent_id or father_id (and fall back to extra fields)
      if(data.parent_id !== undefined || data.father_id !== undefined || extra.parent_id !== undefined || extra.father_id !== undefined){
        const requestedParentId = (data.parent_id !== undefined && data.parent_id !== null) ? data.parent_id : (data.father_id || extra.parent_id || extra.father_id || null);
        if(requestedParentId){
          const { rows } = await pool.query('SELECT id,name,parent_id,parents,parent,grandparent FROM users WHERE id = $1',[requestedParentId]);
          const pRow = rows[0];
          if(pRow){
            parent_id = pRow.id;
            parentName = pRow.name;
            if(pRow.parent_id){
              const { rows: gpRows } = await pool.query('SELECT name FROM users WHERE id = $1',[pRow.parent_id]);
              const gp = gpRows[0];
              if(gp) grandparentName = gp.name;
            } else if(pRow.parent){
              grandparentName = pRow.parent;
            }
            try{ parentsToStoreArr = pRow.parents ? (typeof pRow.parents === 'string' ? JSON.parse(pRow.parents) : pRow.parents) : []; }catch(e){ parentsToStoreArr = []; }
            parentsToStoreArr = Array.isArray(parentsToStoreArr) ? parentsToStoreArr.slice() : [];
            if(!parentsToStoreArr.map(String).includes(String(pRow.id))) parentsToStoreArr.push(pRow.id);
          } else {
            parent_id = null;
          }
        } else {
          parent_id = null;
        }
      }
      // debug log for parent update
      if(data.parent_id !== undefined || data.father_id !== undefined || extra.parent_id !== undefined || extra.father_id !== undefined){
        console.log('approve-edit: applying parent update for target', targetId, '-> parent_id=', parent_id, 'parentName=', parentName, 'parents=', parentsToStoreArr);
      }

      const updates = {};
      if(data.name) updates.name = data.name;
      if(data.emails) updates.emails = JSON.stringify(data.emails);
      if(data.phone !== undefined) updates.phone = data.phone;
      if(data.parent_id !== undefined){ updates.parent_id = parent_id; updates.parent = parentName; updates.grandparent = grandparentName; updates.parents = JSON.stringify(parentsToStoreArr || []); }
      if(data.is_admin !== undefined) updates.is_admin = data.is_admin;      // build SET clause
      // const sets = Object.keys(updates).map(k=> `${k} = ?`).join(', ');
      // const vals = Object.keys(updates).map(k=> updates[k]);
      // if(sets.length) await db.run(`UPDATE users SET ${sets} WHERE id = ?`, [...vals, targetId]);
      const keys = Object.keys(updates);
      if(keys.length){
        const setClause = keys.map((k,i)=> `${k} = $${i+1}`).join(', ');
        const values = keys.map(k=> updates[k]);

        await pool.query(
          `UPDATE users SET ${setClause} WHERE id = $${values.length + 1}`,
          [...values, targetId]
        );
      }
      const resultMsg = 'approved: edited user '+targetId;
      // mark request processed
      await pool.query(
        `UPDATE requests 
        SET processed = 1,
            processed_by = $1,
            processed_at = CURRENT_TIMESTAMP,
            result = $2
        WHERE id = $3`,
        [actorId, resultMsg, id]
      );
      try{
        // const requester = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
        const requesterRes = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [row.user_id]
        );
        const requester = requesterRes.rows[0];
        if(requester && requester.email){ await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: requester.email, subject: 'בקשתך אושרה', text: `שלום ${requester.name || ''},\n\nבקשתך לערוך משתמש (${targetId}) אושרה והעדכונים בוצעו.\n\nבברכה, מנהל המערכת.` }); }
      }catch(_){ }
      return res.json({ ok:true, editedId: targetId });
    }
    if(row.action === 'delete_user' || extra.delete_user){
      const data = extra.delete_user || extra || {};
      const targetId = data.id || extra.id;
      if(!targetId) throw new Error('missing target id for delete');
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1',[targetId]);
      const user = userRes.rows[0];
      // const user = await db.get('SELECT * FROM users WHERE id = ?', [targetId]);
      if(!user) throw new Error('user not found');
      // determine children
      // const all = await db.all('SELECT id,parent_id,parents FROM users');
      const allRes = await pool.query('SELECT id,parent_id,parents FROM users');
      const all = allRes.rows;
      let hasChildren = false;
      for(const r of all){ if(String(r.parent_id) === String(targetId)) { hasChildren = true; break; } if(r.parents){ try{ const arr = typeof r.parents === 'string' ? JSON.parse(r.parents) : r.parents; if(Array.isArray(arr) && arr.map(x=>String(x)).includes(String(targetId))){ hasChildren = true; break; } }catch(e){} } }
      if(hasChildren){
        const placeholder = `deleted+${targetId}+${Date.now()}@example.invalid`;
        // await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder, JSON.stringify([]), targetId]);
        await pool.query(`UPDATE users SET email = $1, emails = $2 WHERE id = $3`,[placeholder, JSON.stringify([]), targetId]);
        const resultMsg = 'approved: marked no-email (has children)';
        // await db.run('UPDATE requests SET processed=1, processed_by=?, processed_at=CURRENT_TIMESTAMP, result=? WHERE id=?', [actorId, resultMsg, id]);
        await pool.query(
          `UPDATE requests 
          SET processed = 1,
              processed_by = $1,
              processed_at = CURRENT_TIMESTAMP,
              result = $2
          WHERE id = $3`,
          [actorId, resultMsg, id]
        );
        try{ 
          // const requester = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
          const requesterRes = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [row.user_id]
          );
          const requester = requesterRes.rows[0];
          if(requester && requester.email){ await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: requester.email, subject: 'בקשתך אושרה', text: `שלום ${requester.name || ''},\n\nבקשתך להסיר משתמש אושרה. המשתמש שסומן מכיל ילדים ולכן הוסר כתובת המייל והועלה למצב 'ללא מייל'.\n\nבברכה, מנהל המערכת.` }); } }catch(_){ }
        return res.json({ ok:true, replaced:true });
      }
      // orphan children and delete
      
      // await db.run('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [targetId]);
      await pool.query(
          'UPDATE users SET parent_id = NULL WHERE parent_id = $1',
          [targetId]
        );
      // const children = await db.all('SELECT id, parents FROM users WHERE parents IS NOT NULL');
      const childrenRes = await pool.query(
          'SELECT id, parents FROM users WHERE parents IS NOT NULL'
        );
      const children = childrenRes.rows;
      // await db.run('UPDATE users SET parents = ? WHERE id = ?', [JSON.stringify(newArr), c.id]);

      for(const c of children){ try{ const arr = c.parents ? JSON.parse(c.parents) : []; const newArr = arr.filter(x=>String(x) !== String(targetId)); if(newArr.length !== arr.length) await pool.query('UPDATE users SET parents = $1 WHERE id = $2',[JSON.stringify(newArr), c.id]);}catch(e){} }
      try{ 
        await pool.query('DELETE FROM users WHERE id = $1',[targetId]);
        // await db.run('DELETE FROM users WHERE id = ?', [targetId]);
       }
      catch(delErr){
        if(String(delErr && delErr.message || '').includes('UNIQUE constraint')){
          const placeholder = `deleted+${targetId}+${Date.now()}@example.invalid`;
          await pool.query(`UPDATE users SET email = $1, emails = $2 WHERE id = $3`,[placeholder, JSON.stringify([]), id]);
          // await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder, JSON.stringify([]), targetId]);
          await pool.query('DELETE FROM users WHERE id = $1',[targetId]);
          // await db.run('DELETE FROM users WHERE id = ?', [targetId]);
        } else throw delErr;
      }
      const resultMsg = 'approved: deleted user '+targetId;
      // await db.run('UPDATE requests SET processed=1, processed_by=?, processed_at=CURRENT_TIMESTAMP, result=? WHERE id=?', [actorId, resultMsg, id]);
      await pool.query(
        `UPDATE requests 
        SET processed = 1,
            processed_by = $1,
            processed_at = CURRENT_TIMESTAMP,
            result = $2
        WHERE id = $3`,
        [actorId, resultMsg, id]
      );
      try{ 
        // const requester = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]); 
        const requesterRes = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [row.user_id]
        );
        const requester = requesterRes.rows[0];
        if(requester && requester.email){ await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: requester.email, subject: 'בקשתך אושרה', text: `שלום ${requester.name || ''},\n\nבקשתך למחוק את המשתמש (id: ${targetId}) אושרה והמשתמש הוסר.\n\nבברכה, מנהל המערכת.` }); } }catch(_){ }
      return res.json({ ok:true, deletedId: targetId });
    }

    // unknown action: mark processed but no-op
    const resultMsg = 'approved: no-op (unknown action)';
    // await db.run('UPDATE requests SET processed=1, processed_by=?, processed_at=CURRENT_TIMESTAMP, result=? WHERE id=?', [actorId, resultMsg, id]);
    await pool.query(
      `UPDATE requests 
      SET processed = 1,
          processed_by = $1,
          processed_at = CURRENT_TIMESTAMP,
          result = $2
      WHERE id = $3`,
      [actorId, resultMsg, id]
    );
    try{ 
      // const requester = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]); 
      const requesterRes = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [row.user_id]
      );
      const requester = requesterRes.rows[0];
      if(requester && requester.email){ await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: requester.email, subject: 'בקשתך אושרה', text: `שלום ${requester.name || ''},\n\nבקשתך אושרה (לאבצע פעולה ספציפית).\n\nבברכה, מנהל המערכת.` }); } }catch(_){ }
    return res.json({ ok:true });
  }catch(err){
    console.error('approve request failed', err && err.message ? err.message : err);
    // await db.run('UPDATE requests SET processed=1, processed_by=?, processed_at=CURRENT_TIMESTAMP, result=? WHERE id=?', [actorId, 'failed: '+(err && err.message?err.message:String(err)), id]);
    await pool.query(
        `UPDATE requests 
        SET processed = 1,
            processed_by = $1,
            processed_at = CURRENT_TIMESTAMP,
            result = $2
        WHERE id = $3`,
        [
          actorId,
          'failed: ' + (err && err.message ? err.message : String(err)),
          id
        ]
      );
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// Deny a request (admin)
app.post('/api/requests/:id/deny', authMiddleware, async (req, res) => {
  if(!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  const reason = req.body && req.body.reason ? String(req.body.reason) : '';
  // const db = await initDb();
  // const row = await db.get('SELECT * FROM requests WHERE id = ?', [id]);
  const rowRes = await pool.query(
      'SELECT * FROM requests WHERE id = $1',
      [id]
    );
  const row = rowRes.rows[0];
  if(!row) return res.status(404).json({ error: 'request not found' });
  if(row.processed) return res.status(400).json({ error: 'already processed' });
  const resultMsg = 'denied' + (reason ? (': ' + reason) : '');
  // await db.run('UPDATE requests SET processed=1, processed_by=?, processed_at=CURRENT_TIMESTAMP, result=? WHERE id=?', [req.user.id, resultMsg, id]);
  await pool.query(
    `UPDATE requests 
    SET processed = 1,
        processed_by = $1,
        processed_at = CURRENT_TIMESTAMP,
        result = $2
    WHERE id = $3`,
    [req.user.id, resultMsg, id]
  );
  try{
    // const ruser = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
    const ruserRes = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [row.user_id]
      );
    const ruser = ruserRes.rows[0];
    if(ruser && ruser.email){
      const subject = 'בקשת מנהל נדחתה';
      let text = `שלום ${ruser.name || ''},\n\nבקשתך נדחתה על ידי המנהל.`;
      if(reason) text += `\n\nסיבת הדחיה:\n${reason}`;
      text += '\n\nאם ברצונך לקבל הבהרות נוספות, פנה למנהל.';
      await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: ruser.email, subject, text });
    }
  }catch(_){ }
  res.json({ ok:true });
});

// Allow authenticated user to update their own profile
// app.put('/api/me', authMiddleware, async (req, res) => {
//   const uid = req.user.id;
//   const { name, emails } = req.body || {};
//   const db = await initDb();
//   try{
//     const existing = await db.get('SELECT * FROM users WHERE id = ?', [uid]);
//     if(!existing) return res.status(404).json({ error: 'not found' });
//     let emailsToStore = existing.emails ? (typeof existing.emails === 'string' ? JSON.parse(existing.emails) : existing.emails) : (existing.email ? [existing.email] : []);
//     if(emails !== undefined){
//       if(!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be array' });
//       for(const em of emails){ if(!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
//       emailsToStore = Array.from(new Set(emails.map(s=>String(s).trim())));
//     }
//     const primary = emailsToStore && emailsToStore.length ? emailsToStore[0] : existing.email;
//     await db.run('UPDATE users SET name=?, email=?, emails=? WHERE id=?', [ name || existing.name, primary, JSON.stringify(emailsToStore), uid ]);
//     await notifyAdmin(`User updated themself: ${name || existing.name} <${primary}>`);
//     res.json({ ok:true });
//   }catch(e){ res.status(500).json({ error: e.message }); }
// });
app.put('/api/me', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const { name, emails } = req.body || {};

  try {
    const existingResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [uid]
    );

    if (existingResult.rows.length === 0)
      return res.status(404).json({ error: 'not found' });

    const existing = existingResult.rows[0];

    let emailsToStore =
      existing.emails
        ? (typeof existing.emails === 'string'
            ? JSON.parse(existing.emails)
            : existing.emails)
        : (existing.email ? [existing.email] : []);

    if (emails !== undefined) {
      if (!Array.isArray(emails))
        return res.status(400).json({ error: 'emails must be array' });

      for (const em of emails) {
        if (!isValidEmail(em))
          return res.status(400).json({ error: 'invalid email in emails' });
      }

      emailsToStore = Array.from(
        new Set(emails.map(s => String(s).trim()))
      );
    }

    const primary =
      emailsToStore && emailsToStore.length
        ? emailsToStore[0]
        : existing.email;

    await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           emails = $3
       WHERE id = $4`,
      [name || existing.name, primary, JSON.stringify(emailsToStore), uid]
    );

    await notifyAdmin(
      `User updated themself: ${name || existing.name} <${primary}>`
    );

    res.json({ ok: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Allow authenticated user to delete their own account (with optional reason)
// app.delete('/api/me', authMiddleware, async (req, res) => {
//   const uid = req.user.id;
//   const { reason } = req.body || {};
//   const db = await initDb();
//   const user = await db.get('SELECT * FROM users WHERE id = ?', [uid]);
//   if(!user) return res.status(404).json({ error: 'not found' });
//   try{
//     // deletion policy A: move children to parent_id=NULL and remove from parents arrays
//     await db.run('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [uid]);
//     const children = await db.all('SELECT id, parents FROM users WHERE parents IS NOT NULL');
//     for(const c of children){
//       try{ const arr = c.parents ? JSON.parse(c.parents) : []; const newArr = arr.filter(x=>String(x)!==String(uid)); if(newArr.length !== arr.length) await db.run('UPDATE users SET parents = ? WHERE id = ?', [JSON.stringify(newArr), c.id]); }catch(e){}
//     }
//     await db.run('DELETE FROM users WHERE id = ?', [uid]);
//     await notifyAdmin(`User deleted themself: ${user.name} <${user.email}>\nReason: ${reason || ''}`);
//     res.json({ ok:true });
//   }catch(e){ res.status(500).json({ error: e.message }); }
// });
app.delete('/api/me', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const { reason } = req.body || {};

  try {
    // קבלת המשתמש
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [uid]
    );

    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'not found' });
    }

    // לנתק ילדים ישירים
    await pool.query(
      'UPDATE users SET parent_id = NULL WHERE parent_id = $1',
      [uid]
    );

    // טיפול ב-parents JSON
    const childrenResult = await pool.query(
      'SELECT id, parents FROM users WHERE parents IS NOT NULL'
    );

    for (const c of childrenResult.rows) {
      try {
        const arr = c.parents ? JSON.parse(c.parents) : [];
        const newArr = arr.filter(x => String(x) !== String(uid));

        if (newArr.length !== arr.length) {
          await pool.query(
            'UPDATE users SET parents = $1 WHERE id = $2',
            [JSON.stringify(newArr), c.id]
          );
        }
      } catch (e) {}
    }

    // מחיקת המשתמש
    await pool.query(
      'DELETE FROM users WHERE id = $1',
      [uid]
    );

    await notifyAdmin(
      `User deleted themself: ${user.name} <${user.email}>\nReason: ${reason || ''}`
    );

    res.json({ ok: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
async function sendVerificationEmail(email, name, token, baseUrl) {
  try {
    const link = `${baseUrl}/verify?token=${token}`;
    const subject = 'אימות כתובת אימייל - משפחה';
    const text = `שלום ${name || ''},\n\nנא לאשר את כתובת הדוא\'ל באמצעות הקישור הזה:\n${link}\n\nאם לא ידעת על בקשה זו, התעלם מהודעה זו.`;
    const html = `<p>שלום ${escapeHtml(name || '')},</p><p>נא לאשר את כתובת הדוא\'ל באמצעות הקישור הזה:</p><p><a href="${link}">${link}</a></p><p>אם לא ידעת על בקשה זו, התעלם מהודעה זו.</p>`;
    await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: email, subject, text, html });
  } catch (e) {
    console.error('sendVerificationEmail failed', e.message);
  }
}

async function sendNewUserWelcomeEmail(email, name, tempPassword, token, baseUrl){
  try{
    const link = `${baseUrl}/verify?token=${token}`;
    const subject = 'ברוכים הבאים — חשבון נוצר עבורך';
    const text = `שלום ${name || ''},\n\nנוצר עבורך חשבון במערכת המשפחה.\n\nסיסמה זמנית להתחברות: ${tempPassword}\nאנא היכנס/י ושנה סיסמה לאחר ההתחברות.\n\nלאישור המייל השתמש/י בקישור: ${link}\n\nאם לא ביקשת חשבון - התעלם/י מההודעה.`;
    const html = `
      <div style="font-family:Arial, Helvetica, sans-serif; color:#111;">
        <h2>שלום ${escapeHtml(name || '')},</h2>
        <p>נוצר עבורך חשבון במערכת המשפחה.</p>
        <p><strong>סיסמה זמנית:</strong> <span style="background:#f3f4f6;padding:4px 8px;border-radius:6px;font-family:monospace;">${escapeHtml(tempPassword)}</span></p>
        <p>אנא היכנס/י ושנה את הסיסמה לאחר ההתחברות.</p>
        <p>לאישור כתובת המייל — לחץ/י כאן:</p>
        <p><a href="${link}" style="display:inline-block;padding:8px 12px;background:#0d6efd;color:white;border-radius:6px;text-decoration:none;">אשר כתובת מייל</a></p>
        <p style="color:#6b7280;font-size:0.9rem;">אם לא ביקשת חשבון זה, התעלם/י מההודעה או פנה/י למנהל.</p>
      </div>
    `;
    await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: email, subject, text, html });
  }catch(e){ console.error('sendNewUserWelcomeEmail failed', e && e.message ? e.message : e); }
}

function escapeHtml(str){
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
