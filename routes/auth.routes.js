const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { pool } = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');
const { isValidEmail, getBaseUrl } = require('../utils/helpers');
const { validateParents } = require('../utils/treeUtils');
const { sendVerificationEmail, notifyAdmin, sendNewUserWelcomeEmail } = require('../utils/mailer');

router.post('/api/register', async (req, res) => {
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

router.post('/api/login', async (req, res) => {
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

router.get('/verify', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('Missing token');
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE verification_token = $1',
      [token]
    );

    const user = rows[0];

    if (!user) {
      return res.status(400).send('<h3>טוקן לא תקין</h3>');
    }

    await pool.query(
      'UPDATE users SET verified = 1, verification_token = NULL WHERE id = $1',
      [user.id]
    );

    res.send('<h3>האימייל אושר בהצלחה — ניתן לסגור חלון זה.</h3>');

  } catch (err) {
    console.error('VERIFY ERROR:', err);
    res.status(500).send('server error');
  }
});

router.post('/api/resend-verification', authMiddleware, async (req, res) => {
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

module.exports = router;
