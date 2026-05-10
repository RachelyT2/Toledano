const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { isValidEmail, getBaseUrl } = require('../utils/helpers');
const { validateParents } = require('../utils/treeUtils');
const { sendVerificationEmail, sendNewUserWelcomeEmail, notifyAdmin } = require('../utils/mailer');

// Admin creates a user (sends verification). Returns temporary password so admin can share it.
router.post('/api/users', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { name, email, is_admin, parent, grandparent } = req.body;
  const parent_id = req.body.parent_id || null;
  const parentsInput = req.body.parents;
  const emailsInput = req.body.emails;
  if (!name || !email) return res.status(400).json({ error: 'name,email required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
  const tempPassword = crypto.randomBytes(6).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);
  const token = crypto.randomBytes(24).toString('hex');
  try {
    let parentsToStore = [];
    if (parentsInput !== undefined) {
      const v = await validateParents(null, parentsInput);
      if (!v.ok) return res.status(400).json({ error: v.error });
      parentsToStore = v.parents;
    }
    let emailsToStore = [];
    if (emailsInput !== undefined) {
      if (!Array.isArray(emailsInput)) return res.status(400).json({ error: 'emails must be array' });
      for (const em of emailsInput) { if (!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
      emailsToStore = Array.from(new Set(emailsInput.map(s => String(s).trim())));
    } else {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid email' });
      emailsToStore = [String(email).trim()];
    }
    if (parent_id) {
      const v2 = await validateParents(null, [parent_id]);
      if (!v2.ok) return res.status(400).json({ error: v2.error });
    }
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
    const base = getBaseUrl(req);
    try {
      await sendNewUserWelcomeEmail(emailsToStore[0], name, tempPassword, token, base);
    } catch (e) {
      console.error('EMAIL FAILED:', e);
    }
    try {
      await notifyAdmin(`Admin ${req.user.email} added: ${name} <${emailsToStore[0]}>`);
    } catch (e) { console.error('NOTIFY FAILED:', e); }
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(400).json({ error: 'Could not create user', detail: e.message });
  }
});

router.post('/api/users/:id/resend', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.verified) return res.status(400).json({ error: 'already verified' });
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    'UPDATE users SET verification_token = $1 WHERE id = $2',
    [token, user.id]
  );
  const base = getBaseUrl(req);
  await sendVerificationEmail(user.email, user.name, token, base);
  res.json({ ok: true });
});

router.get('/api/users', authMiddleware, async (req, res) => {
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

router.put('/api/users/:id', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  const { name, email, is_admin, parent, grandparent } = req.body;
  const parent_id = req.body.parent_id === undefined ? undefined : req.body.parent_id;
  const parentsInput = req.body.parents === undefined ? undefined : req.body.parents;
  const emailsInput = req.body.emails === undefined ? undefined : req.body.emails;
  try {
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
      token = crypto.randomBytes(24).toString('hex');
    }
    // validate parents if provided
    let parentsToStore = existing.parents ? (typeof existing.parents === 'string' ? JSON.parse(existing.parents) : existing.parents) : [];
    let emailsToStore = existing.emails ? (typeof existing.emails === 'string' ? JSON.parse(existing.emails) : existing.emails) : (existing.email ? [existing.email] : []);
    if (parentsInput !== undefined) {
      const v = await validateParents(parseInt(id), parentsInput);
      if (!v.ok) return res.status(400).json({ error: v.error });
      parentsToStore = v.parents;
    }
    // validate parent_id if provided
    if (parent_id !== undefined) {
      const v2 = await validateParents(parseInt(id), parent_id ? [parent_id] : []);
      if (!v2.ok) return res.status(400).json({ error: v2.error });
      // if parent_id is provided and parents not provided, keep parentsToStore unchanged
    }
    if (emailsInput !== undefined) {
      if (!Array.isArray(emailsInput)) return res.status(400).json({ error: 'emails must be array' });
      for (const em of emailsInput) { if (!isValidEmail(em)) return res.status(400).json({ error: 'invalid email in emails' }); }
      emailsToStore = Array.from(new Set(emailsInput.map(s => String(s).trim())));
    }
    await pool.query(
      `UPDATE users SET name=$1,email=$2,is_admin=$3,verified=$4,verification_token=$5,parent=$6,grandparent=$7,parent_id=$8,parents=$9,emails=$10 WHERE id=$11`,
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

router.delete('/api/users/:id', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const { id } = req.params;
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'not found' });
  // If this user has children, do NOT delete the row. Instead clear email(s) so UI shows "no email".
  try {
    const { rows: all } = await pool.query('SELECT id, parent_id, parents FROM users');
    let hasChildren = false;
    for (const r of all) {
      if (String(r.parent_id) === String(id)) { hasChildren = true; break; }
      if (r.parents) {
        try {
          const arr = typeof r.parents === 'string' ? JSON.parse(r.parents) : r.parents;
          if (Array.isArray(arr) && arr.map(x => String(x)).includes(String(id))) { hasChildren = true; break; }
        } catch(e) {}
      }
    }

    if (hasChildren) {
      try {
        const placeholder = `deleted+${id}+${Date.now()}@example.invalid`;
        await pool.query('UPDATE users SET email = $1, emails = $2 WHERE id = $3', [placeholder, JSON.stringify([]), id]);
        await notifyAdmin(`User marked no-email (has children): ${user.name} (id:${id})`);
        return res.json({ ok: true, replaced: true });
      } catch(updErr) {
        console.error('Failed to mark user no-email (fallback):', updErr && updErr.message ? updErr.message : updErr);
        if (String(updErr && updErr.message || '').includes('UNIQUE constraint')) {
          const placeholder2 = `deleted+${id}+${Date.now()}+${Math.floor(Math.random() * 100000)}@example.invalid`;
          await pool.query('UPDATE users SET email = $1, emails = $2 WHERE id = $3', [placeholder2, JSON.stringify([]), id]);
          await notifyAdmin(`User marked no-email (has children, fallback): ${user.name} (id:${id})`);
          return res.json({ ok: true, replaced: true });
        }
        throw updErr;
      }
    }

    // No children -> proceed to orphan any references and delete
    await pool.query('UPDATE users SET parent_id = NULL WHERE parent_id = $1', [id]);
    // remove from parents JSON arrays
    const { rows: children } = await pool.query('SELECT id, parents FROM users WHERE parents IS NOT NULL');
    for (const c of children) {
      try {
        const arr = c.parents ? JSON.parse(c.parents) : [];
        const newArr = arr.filter(x => String(x) !== String(id));
        if (newArr.length !== arr.length)
          await pool.query('UPDATE users SET parents = $1 WHERE id = $2', [JSON.stringify(newArr), c.id]);
      } catch(e) {}
    }
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    } catch(delErr) {
      // handle potential UNIQUE constraint issues (e.g., duplicate empty emails)
      console.error('Delete user failed, attempting fallback cleanup:', delErr && delErr.message ? delErr.message : delErr);
      if (String(delErr && delErr.message || '').includes('UNIQUE constraint')) {
        try {
          const placeholder = `deleted+${id}+${Date.now()}@example.invalid`;
          await pool.query(
            'UPDATE users SET email = $1, emails = $2 WHERE id = $3',
            [placeholder, JSON.stringify([]), id]
          );
          await pool.query('DELETE FROM users WHERE id = $1', [id]);
        } catch(fallbackErr) {
          console.error('Fallback delete also failed:', fallbackErr?.message || fallbackErr);
          throw fallbackErr;
        }
      } else {
        throw delErr;
      }
    }
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
  await notifyAdmin(`User removed: ${user.name} <${user.email}>`);
  res.json({ ok: true });
});

// Allow authenticated user to update their own profile
router.put('/api/me', authMiddleware, async (req, res) => {
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
router.delete('/api/me', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const { reason } = req.body || {};

  try {
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

module.exports = router;
