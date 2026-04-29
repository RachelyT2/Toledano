const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const { open } = require('sqlite');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const DB_PATH = process.env.DB_PATH || './family.db';
function sanitizeHtml(html){
  return html
    .replace(/<script.*?>.*?<\/script>/gi, '')
    .replace(/on\w+=".*?"/g, '');
}
async function initDb() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      verification_token TEXT,
      parent TEXT,
      grandparent TEXT
    );
  `);
  // ensure columns exist (for upgrades)
  try { await db.run('ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0'); } catch(e){}
  try { await db.run('ALTER TABLE users ADD COLUMN verification_token TEXT'); } catch(e){}
  try { await db.run('ALTER TABLE users ADD COLUMN parent TEXT'); } catch(e){}
  try { await db.run('ALTER TABLE users ADD COLUMN grandparent TEXT'); } catch(e){}
  try { await db.run('ALTER TABLE users ADD COLUMN parent_id INTEGER'); } catch(e){}
  try { await db.run("ALTER TABLE users ADD COLUMN parents TEXT"); } catch(e){}
  try { await db.run("ALTER TABLE users ADD COLUMN emails TEXT"); } catch(e){}
  return db;
}

// Helpers for parents array and cycle prevention
async function loadAllUsers(db){
  const rows = await db.all('SELECT id, name, parent_id, parents FROM users');
  // parse parents JSON
  rows.forEach(r=>{ try{ r.parents = r.parents ? JSON.parse(r.parents) : []; }catch(e){ r.parents = []; } });
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

async function validateParents(db, userId, parents){
  // parents: array of ids (may be undefined/null)
  if(!parents) return { ok:true, parents: [] };
  if(!Array.isArray(parents)) return { ok:false, error:'parents must be array' };
  // dedupe
  const uniq = Array.from(new Set(parents.map(x=>parseInt(x)).filter(x=>!Number.isNaN(x))));
  // check existence
  if(uniq.length>0){
    const placeholders = uniq.map(()=>'?').join(',');
    const found = await db.all(`SELECT id FROM users WHERE id IN (${placeholders})`, uniq);
    if(found.length !== uniq.length) return { ok:false, error:'one or more parents not found' };
  }
  // load graph and ensure no cycles: none of the parents may be a descendant of userId
  const rows = await loadAllUsers(db);
  const map = buildAdjacency(rows);
  // include pending parents in map for userId
  if(!map[userId]) map[userId] = { id: userId, parents: uniq||[], children: [] };
  // rebuild children for safety
  Object.values(map).forEach(n=>{ n.children = []; });
  Object.values(map).forEach(n=>{ (n.parents||[]).forEach(p=>{ if(map[p]) map[p].children.push(n.id); }); });
  for(const p of uniq){
    if(p === userId) return { ok:false, error:'cannot set self as parent' };
    if(isDescendant(map, userId, p)) return { ok:false, error:'cycle detected' };
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
    host: process.env.SMTP_HOST || 'smtp.example.com',
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
    const info = await transport.sendMail(mailOptions);
    return info;
  }catch(e){
    console.error('Primary SMTP send failed:', e && e.message ? e.message : e);
    try{
      const testAccount = await nodemailer.createTestAccount();
      const testTransport = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: { user: testAccount.user, pass: testAccount.pass }
      });
      const info = await testTransport.sendMail(mailOptions);
      const preview = nodemailer.getTestMessageUrl(info);
      if(preview) console.log('Ethereal preview URL:', preview);
      return info;
    }catch(err){
      console.error('Fallback test account send failed:', err && err.message ? err.message : err);
      throw err;
    }
  }
}

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
  const { name, email, password, is_admin, parent, grandparent } = req.body;
  const parent_id = req.body.parent_id || null;
  const parentsInput = req.body.parents;
  const emailsInput = req.body.emails;
  if (!name || !email || !password) return res.status(400).json({ error: 'name,email,password required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
  const db = await initDb();
  const hash = await bcrypt.hash(password, 10);
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  try {
    // validate parents array if provided
    let parentsToStore = [];
    if(parentsInput !== undefined){
      const v = await validateParents(db, null, parentsInput);
      if(!v.ok) return res.status(400).json({ error: v.error });
      parentsToStore = v.parents;
    }
    // emails: allow either single email or array
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
      const v2 = await validateParents(db, null, [parent_id]);
      if(!v2.ok) return res.status(400).json({ error: v2.error });
    }
    const result = await db.run('INSERT INTO users (name,email,password_hash,is_admin,verified,verification_token,parent,grandparent,parent_id,parents,emails) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [name, emailsToStore[0], hash, is_admin ? 1 : 0, 0, token, parent || null, grandparent || null, parent_id, JSON.stringify(parentsToStore), JSON.stringify(emailsToStore)]);
    // send verification email
    const base = req.protocol + '://' + req.get('host');
    await sendVerificationEmail(email, name, token, base);
    await notifyAdmin(`${name} <${email}> was added to the family list.`);
    res.json({ id: result.lastID });
  } catch (e) {
    res.status(400).json({ error: 'Could not create user', detail: e.message });
  }
});

// Admin creates a user (sends verification). Returns temporary password so admin can share it.
app.post('/api/users', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { name, email, is_admin, parent, grandparent } = req.body;
  const parent_id = req.body.parent_id || null;
  const parentsInput = req.body.parents;
  const emailsInput = req.body.emails;
  if (!name || !email) return res.status(400).json({ error: 'name,email required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
  const db = await initDb();
  const crypto = require('crypto');
  const tempPassword = crypto.randomBytes(6).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);
  const token = crypto.randomBytes(24).toString('hex');
  try {
    let parentsToStore = [];
    if(parentsInput !== undefined){
      const v = await validateParents(db, null, parentsInput);
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
      const v2 = await validateParents(db, null, [parent_id]);
      if(!v2.ok) return res.status(400).json({ error: v2.error });
    }
    const result = await db.run('INSERT INTO users (name,email,password_hash,is_admin,verified,verification_token,parent,grandparent,parent_id,parents,emails) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [name, emailsToStore[0], hash, is_admin ? 1 : 0, 0, token, parent || null, grandparent || null, parent_id, JSON.stringify(parentsToStore), JSON.stringify(emailsToStore)]);
    const base = req.protocol + '://' + req.get('host');
    await sendVerificationEmail(email, name, token, base);
    await notifyAdmin(`Admin ${req.user.email} added: ${name} <${email}>`);
    res.json({ id: result.lastID, tempPassword });
  } catch (e) {
    res.status(400).json({ error: 'Could not create user', detail: e.message });
  }
});

app.post('/api/resend-verification', authMiddleware, async (req, res) => {
  const db = await initDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.verified) return res.status(400).json({ error: 'already verified' });
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  await db.run('UPDATE users SET verification_token=? WHERE id=?', [token, user.id]);
  const base = req.protocol + '://' + req.get('host');
  await sendVerificationEmail(user.email, user.name, token, base);
  res.json({ ok: true });
});

app.get('/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');
  const db = await initDb();
  const user = await db.get('SELECT * FROM users WHERE verification_token = ?', [token]);
  if (!user) return res.status(400).send('<h3>טוקן לא תקין</h3>');
  await db.run('UPDATE users SET verified=1, verification_token=NULL WHERE id=?', [user.id]);
  res.send('<h3>האימייל אושר בהצלחה — ניתן לסגור חלון זה.</h3>');
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email,password required' });
  const db = await initDb();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin, verified: !!user.verified }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

app.post('/api/users/:id/resend', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  const db = await initDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.verified) return res.status(400).json({ error: 'already verified' });
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  await db.run('UPDATE users SET verification_token=? WHERE id=?', [token, user.id]);
  const base = req.protocol + '://' + req.get('host');
  await sendVerificationEmail(user.email, user.name, token, base);
  res.json({ ok: true });
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const db = await initDb();
  const q = req.query.q;
  const parent_id = req.query.parent_id;
  let rows;
  if (parent_id) {
    // return direct children of given parent_id (lazy-load)
    rows = await db.all('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users WHERE parent_id = ? ORDER BY name', [parent_id]);
  } else if (q) {
    rows = await db.all("SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users WHERE name LIKE '%'||?||'%' OR email LIKE '%'||?||'%' ORDER BY name", [q, q]);
  } else {
    rows = await db.all('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users ORDER BY name');
  }
  // parse parents JSON for each row
  rows.forEach(r=>{ try{ r.parents = r.parents ? JSON.parse(r.parents) : []; }catch(e){ r.parents = []; } try{ r.emails = r.emails ? JSON.parse(r.emails) : (r.email ? [r.email] : []); }catch(e){ r.emails = r.email ? [r.email] : []; } r.email = r.emails && r.emails.length ? r.emails[0] : r.email; });
  res.json(rows);
});

app.put('/api/users/:id', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  const { name, email, is_admin, parent, grandparent } = req.body;
  const parent_id = req.body.parent_id === undefined ? undefined : req.body.parent_id;
  const parentsInput = req.body.parents === undefined ? undefined : req.body.parents;
  const emailsInput = req.body.emails === undefined ? undefined : req.body.emails;
  const db = await initDb();
  try {
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
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
      const v = await validateParents(db, parseInt(id), parentsInput);
      if(!v.ok) return res.status(400).json({ error: v.error });
      parentsToStore = v.parents;
    }
    // validate parent_id if provided
    if(parent_id !== undefined){
      const v2 = await validateParents(db, parseInt(id), parent_id ? [parent_id] : []);
      if(!v2.ok) return res.status(400).json({ error: v2.error });
      // if parent_id is provided and parents not provided, keep parentsToStore unchanged
    }
    if(emailsInput !== undefined){
      if(!Array.isArray(emailsInput)) return res.status(400).json({ error: 'emails must be array' });
      for(const em of emailsInput){ if(!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
      emailsToStore = Array.from(new Set(emailsInput.map(s=>String(s).trim())));
    }
    await db.run('UPDATE users SET name=?, email=?, is_admin=?, verified=?, verification_token=?, parent=?, grandparent=?, parent_id=?, parents=?, emails=? WHERE id=?', [name || existing.name, newEmail, is_admin ? 1 : 0, willChangeEmail ? 0 : existing.verified, willChangeEmail ? token : existing.verification_token, parent===undefined?existing.parent:parent, grandparent===undefined?existing.grandparent:grandparent, parent_id===undefined?existing.parent_id:parent_id, JSON.stringify(parentsToStore), JSON.stringify(emailsToStore), id]);
    if (willChangeEmail) {
      const base = req.protocol + '://' + req.get('host');
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
  const db = await initDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: 'not found' });
  // If this user has children, do NOT delete the row. Instead clear email(s) so UI shows "no email".
  try{
    const all = await db.all('SELECT id,parent_id,parents FROM users');
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
        await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder, JSON.stringify([]), id]);
        await notifyAdmin(`User marked no-email (has children): ${user.name} (id:${id})`);
        return res.json({ ok:true, replaced:true });
      }catch(updErr){
        console.error('Failed to mark user no-email (fallback):', updErr && updErr.message ? updErr.message : updErr);
        // If update fails due to UNIQUE constraint, try alternative placeholder with random suffix
        if(String(updErr && updErr.message || '').includes('UNIQUE constraint')){
          const placeholder2 = `deleted+${id}+${Date.now()}+${Math.floor(Math.random()*100000)}@example.invalid`;
          await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder2, JSON.stringify([]), id]);
          await notifyAdmin(`User marked no-email (has children, fallback): ${user.name} (id:${id})`);
          return res.json({ ok:true, replaced:true });
        }
        throw updErr;
      }
    }

    // No children -> proceed to orphan any references and delete
    await db.run('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [id]);
    // remove from parents JSON arrays
    const children = await db.all('SELECT id, parents FROM users WHERE parents IS NOT NULL');
    for(const c of children){
      try{
        const arr = c.parents ? JSON.parse(c.parents) : [];
        const newArr = arr.filter(x=>String(x) !== String(id));
        if(newArr.length !== arr.length) await db.run('UPDATE users SET parents = ? WHERE id = ?', [JSON.stringify(newArr), c.id]);
      }catch(e){}
    }
    try{
      await db.run('DELETE FROM users WHERE id = ?', [id]);
    }catch(delErr){
      // handle potential UNIQUE constraint issues (e.g., duplicate empty emails)
      console.error('Delete user failed, attempting fallback cleanup:', delErr && delErr.message ? delErr.message : delErr);
      if(String(delErr && delErr.message || '').includes('UNIQUE constraint')){
        try{
          const placeholder = `deleted+${id}+${Date.now()}@example.invalid`;
          await db.run('UPDATE users SET email = ?, emails = ? WHERE id = ?', [placeholder, JSON.stringify([]), id]);
          await db.run('DELETE FROM users WHERE id = ?', [id]);
        }catch(fallbackErr){
          console.error('Fallback delete also failed:', fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
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

app.post('/api/send', authMiddleware, upload.array('files'), async (req, res) => {  const { recipients, subject, message } = req.body;
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ error: 'recipients required' });
  const files = req.files || [];
  const db = await initDb();
  const rows = await db.all(`SELECT emails,name FROM users WHERE id IN (${recipients.map(()=>'?').join(',')})`, recipients);
  if (!rows || rows.length === 0) return res.status(400).json({ error: 'no recipients found' });

  // ensure sender is verified
  const sender = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!sender) return res.status(404).json({ error: 'sender not found' });
  if (!sender.verified) return res.status(403).json({ error: 'sender email not verified' });

  try {
    // flatten emails arrays and dedupe
    let sendTo = [];
    rows.forEach(r=>{
      try{ const arr = r.emails ? JSON.parse(r.emails) : (r.email?[r.email]:[]); sendTo = sendTo.concat(arr); }catch(e){ if(r.email) sendTo.push(r.email); }
    });
    sendTo = Array.from(new Set(sendTo.map(s=>String(s).trim())));
    const serverFrom = process.env.SMTP_USER || 'no-reply@example.com';
    const replyTo = `${req.user.name} <${req.user.email}>`;
    const fromDisplay = `${req.user.name} דרך המשפחה <${serverFrom}>`;
    const senderLineText = `נשלח על ידי: ${req.user.name} <${req.user.email}>\n\n`;
    const senderLineHtml = `<p><strong>נשלח על ידי: ${escapeHtml(req.user.name)} &lt;${escapeHtml(req.user.email)}&gt;</strong></p>`;
    await safeSendMail({
      from: fromDisplay,
      to: sendTo.join(','),
      replyTo,
      subject: subject || '(no subject)',
      text: senderLineText + (message || ''),
      // html: senderLineHtml + `<pre style="font-family:inherit;">${escapeHtml(message || '')}</pre>`,
      html: senderLineHtml + `
        <div style="font-family:Arial; font-size:14px; line-height:1.6;">
        ${message || ''}
      </div>
      `,
      attachments: files.map(f => ({
        filename: f.originalname,
        path: f.path
      }))
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Sending failed', detail: e.message });
  }
});

// return prepared hierarchical tree (server-side) to simplify frontend
app.get('/api/tree', authMiddleware, async (req, res) => {
  const db = await initDb();
  const rows = await db.all('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users ORDER BY name');
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
  if (!process.env.ADMIN_EMAIL) return res.status(500).json({ error: 'ADMIN_EMAIL not configured' });
  const user = req.user;
  const subj = `בקשת מנהל: ${action || 'כללי'} - ${user.name}`;
  const extra = req.body.extra || {};
  let text = `User: ${user.name} <${user.email}>\nAction: ${action || ''}\n\nDetails:\n${details || ''}`;
  if(extra.father_id) text += `\nFather ID: ${extra.father_id}`;
  if(extra.grandfather_id) text += `\nGrandfather ID: ${extra.grandfather_id}`;
  try{
    await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: process.env.ADMIN_EMAIL, subject: subj, text, replyTo: `${user.name} <${user.email}>` });
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: 'failed to send', detail: e.message }); }
});

// Allow authenticated user to update their own profile
app.put('/api/me', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const { name, emails } = req.body || {};
  const db = await initDb();
  try{
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [uid]);
    if(!existing) return res.status(404).json({ error: 'not found' });
    let emailsToStore = existing.emails ? (typeof existing.emails === 'string' ? JSON.parse(existing.emails) : existing.emails) : (existing.email ? [existing.email] : []);
    if(emails !== undefined){
      if(!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be array' });
      for(const em of emails){ if(!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
      emailsToStore = Array.from(new Set(emails.map(s=>String(s).trim())));
    }
    const primary = emailsToStore && emailsToStore.length ? emailsToStore[0] : existing.email;
    await db.run('UPDATE users SET name=?, email=?, emails=? WHERE id=?', [ name || existing.name, primary, JSON.stringify(emailsToStore), uid ]);
    await notifyAdmin(`User updated themself: ${name || existing.name} <${primary}>`);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Allow authenticated user to delete their own account (with optional reason)
app.delete('/api/me', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const { reason } = req.body || {};
  const db = await initDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [uid]);
  if(!user) return res.status(404).json({ error: 'not found' });
  try{
    // deletion policy A: move children to parent_id=NULL and remove from parents arrays
    await db.run('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [uid]);
    const children = await db.all('SELECT id, parents FROM users WHERE parents IS NOT NULL');
    for(const c of children){
      try{ const arr = c.parents ? JSON.parse(c.parents) : []; const newArr = arr.filter(x=>String(x)!==String(uid)); if(newArr.length !== arr.length) await db.run('UPDATE users SET parents = ? WHERE id = ?', [JSON.stringify(newArr), c.id]); }catch(e){}
    }
    await db.run('DELETE FROM users WHERE id = ?', [uid]);
    await notifyAdmin(`User deleted themself: ${user.name} <${user.email}>\nReason: ${reason || ''}`);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
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
