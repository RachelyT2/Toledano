const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { getBaseUrl, runAsync } = require('../utils/helpers');
const { safeSendMail, notifyAdmin, sendNewUserWelcomeEmail } = require('../utils/mailer');

// Allow users to send requests to admin (add/edit/remove) via site
router.post('/api/request-admin', authMiddleware, async (req, res) => {
  const { action, details } = req.body || {};
  console.log('REQUEST HIT /api/request-admin');

  if (!process.env.ADMIN_EMAIL)
    return res.status(500).json({ error: 'ADMIN_EMAIL not configured' });

  const user = req.user;
  const extra = req.body.extra || {};

  const subj = `בקשת מנהל: ${action || 'כללי'} - ${user.name}`;

  let text =
    `User: ${user.name} <${user.email}>\n` +
    `Action: ${action || ''}\n\n` +
    `Details:\n${details || ''}`;

  if (extra.father_id) text += `\nFather ID: ${extra.father_id}`;
  if (extra.grandfather_id) text += `\nGrandfather ID: ${extra.grandfather_id}`;

  try {
    const { rows } = await pool.query(
      `INSERT INTO requests (user_id, action, details, extra)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, action || '', details || '', JSON.stringify(extra || {})]
    );

    const requestId = rows[0].id;
    console.log('INSERT RESULT:', requestId);

    res.json({ ok: true, requestId });

    setTimeout(() => {
      safeSendMail({
        from: process.env.SMTP_USER || 'no-reply@example.com',
        to: process.env.ADMIN_EMAIL,
        subject: subj,
        text,
        replyTo: `${user.name} <${user.email}>`
      }).catch(err => {
        console.error('ADMIN EMAIL FAILED:', err);
      });
    }, 0);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed to send', detail: e.message });
  }
});

// List pending requests (admin)
router.get('/api/requests', authMiddleware, async (req, res) => {
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
router.post('/api/requests/:id/approve', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'admin required' });
  const id = req.params.id;
  const { rows } = await pool.query('SELECT * FROM requests WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'request not found' });
  if (row.processed) return res.status(400).json({ error: 'already processed' });
  let extra = {};
  try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch(e) { extra = {}; }
  const actorId = req.user.id;
  try {
    if (row.action === 'add_user' || extra.add_user) {
      // create user using fields in extra (support either extra.add_user or extra flattened)
      const data = extra.add_user || extra || {};
      const name = data.name || extra.name || (row.details ? String(row.details).split('\n')[0] : '');
      const emailsArr = Array.isArray(data.emails) ? data.emails : (extra.emails || []);
      const emailPrimary = emailsArr && emailsArr.length ? emailsArr[0] : (extra.email || null);
      const phone = data.phone || extra.phone || null;
      const is_admin = data.is_admin ? 1 : 0;
      if (!emailPrimary) throw new Error('missing primary email for new user');
      const tempPassword = crypto.randomBytes(6).toString('hex');
      const hash = await bcrypt.hash(tempPassword, 10);
      const token = crypto.randomBytes(24).toString('hex');
      // determine parent_id from several possible fields (parent_id, father_id)
      const requestedParentId = (data.parent_id !== undefined && data.parent_id !== null) ? data.parent_id : (data.father_id || extra.parent_id || extra.father_id || null);
      let parent_id = null;
      let parentName = null;
      let grandparentName = null;
      let parentsToStoreArr = [];
      if (requestedParentId) {
        const { rows } = await pool.query('SELECT id, name, parent_id, parents FROM users WHERE id = $1', [requestedParentId]);
        const pRow = rows[0];
        if (pRow) {
          parent_id = pRow.id;
          parentName = pRow.name;
          // compute grandparent name: try pRow.parent (name) else use parent_id of parent
          if (pRow.parent_id) {
            const { rows: gpRows } = await pool.query('SELECT name FROM users WHERE id = $1', [pRow.parent_id]);
            const gp = gpRows[0];
            if (gp) grandparentName = gp.name;
          } else if (pRow.parent) {
            grandparentName = pRow.parent;
          }
          // build parents array: take parent's parents if present, then append parent id
          try { parentsToStoreArr = pRow.parents ? (typeof pRow.parents === 'string' ? JSON.parse(pRow.parents) : pRow.parents) : []; } catch(e) { parentsToStoreArr = []; }
          parentsToStoreArr = Array.isArray(parentsToStoreArr) ? parentsToStoreArr.slice() : [];
          if (!parentsToStoreArr.map(String).includes(String(pRow.id))) parentsToStoreArr.push(pRow.id);
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
      const resultMsg = 'approved: created user id ' + result.rows[0].id;
      await pool.query(
        `UPDATE requests SET processed = 1,processed_by = $1,processed_at = NOW(),result = $2 WHERE id = $3`,
        [actorId, resultMsg, id]
      );
      try {
        const requesterRes = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [row.user_id]
        );
        const requester = requesterRes.rows[0];
        if (requester && requester.email) {
          runAsync(() =>
            safeSendMail({
              from: process.env.SMTP_USER || 'no-reply@example.com',
              to: requester.email,
              subject: 'בקשתך אושרה',
              text: `שלום ${requester.name || ''},\n\nבקשתך ליצור משתמש אושרה. נוצר משתמש עם מזהה ${result.rows[0].id}.\n\nבברכה, מנהל המערכת.`
            })
          );
        }
      } catch (e) {
        console.error('requester mail failed:', e);
      }
      return res.json({ ok: true, createdId: result.rows[0].id });
    }

    if (row.action === 'edit_user' || extra.edit_user) {
      const data = extra.edit_user || extra || {};
      // allow requests that don't include explicit target id (e.g. self-edit): fall back to requester id
      const targetId = data.id || extra.id || row.user_id;
      if (!targetId) throw new Error('missing target id for edit');
      const existingRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
      const existing = existingRes.rows[0];
      if (!existing) throw new Error('target user not found');
      // prepare potential parent updates
      let parent_id = null;
      let parentName = null;
      let grandparentName = null;
      let parentsToStoreArr = [];
      // accept either parent_id or father_id (and fall back to extra fields)
      if (data.parent_id !== undefined || data.father_id !== undefined || extra.parent_id !== undefined || extra.father_id !== undefined) {
        const requestedParentId = (data.parent_id !== undefined && data.parent_id !== null) ? data.parent_id : (data.father_id || extra.parent_id || extra.father_id || null);
        if (requestedParentId) {
          const { rows } = await pool.query('SELECT id,name,parent_id,parents,parent,grandparent FROM users WHERE id = $1', [requestedParentId]);
          const pRow = rows[0];
          if (pRow) {
            parent_id = pRow.id;
            parentName = pRow.name;
            if (pRow.parent_id) {
              const { rows: gpRows } = await pool.query('SELECT name FROM users WHERE id = $1', [pRow.parent_id]);
              const gp = gpRows[0];
              if (gp) grandparentName = gp.name;
            } else if (pRow.parent) {
              grandparentName = pRow.parent;
            }
            try { parentsToStoreArr = pRow.parents ? (typeof pRow.parents === 'string' ? JSON.parse(pRow.parents) : pRow.parents) : []; } catch(e) { parentsToStoreArr = []; }
            parentsToStoreArr = Array.isArray(parentsToStoreArr) ? parentsToStoreArr.slice() : [];
            if (!parentsToStoreArr.map(String).includes(String(pRow.id))) parentsToStoreArr.push(pRow.id);
          } else {
            parent_id = null;
          }
        } else {
          parent_id = null;
        }
      }
      // debug log for parent update
      if (data.parent_id !== undefined || data.father_id !== undefined || extra.parent_id !== undefined || extra.father_id !== undefined) {
        console.log('approve-edit: applying parent update for target', targetId, '-> parent_id=', parent_id, 'parentName=', parentName, 'parents=', parentsToStoreArr);
      }

      const updates = {};
      if (data.name) updates.name = data.name;
      if (data.emails) updates.emails = JSON.stringify(data.emails);
      if (data.phone !== undefined) updates.phone = data.phone;
      if (data.parent_id !== undefined) { updates.parent_id = parent_id; updates.parent = parentName; updates.grandparent = grandparentName; updates.parents = JSON.stringify(parentsToStoreArr || []); }
      if (data.is_admin !== undefined) updates.is_admin = data.is_admin;
      // build SET clause
      const keys = Object.keys(updates);
      if (keys.length) {
        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const values = keys.map(k => updates[k]);
        await pool.query(
          `UPDATE users SET ${setClause} WHERE id = $${values.length + 1}`,
          [...values, targetId]
        );
      }
      const resultMsg = 'approved: edited user ' + targetId;
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
      try {
        const requesterRes = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [row.user_id]
        );
        const requester = requesterRes.rows[0];
        if (requester && requester.email) {
          runAsync(() =>
            safeSendMail({
              from: process.env.SMTP_USER || 'no-reply@example.com',
              to: requester.email,
              subject: 'בקשתך אושרה',
              text: `שלום ${requester.name || ''},\n\nבקשתך לערוך משתמש (${targetId}) אושרה והעדכונים בוצעו.\n\nבברכה, מנהל המערכת.`
            })
          );
        }
      } catch(e) {
        console.error('requester mail failed:', e);
      }
      return res.json({ ok: true, editedId: targetId });
    }

    if (row.action === 'delete_user' || extra.delete_user) {
      const data = extra.delete_user || extra || {};
      const targetId = data.id || extra.id;
      if (!targetId) throw new Error('missing target id for delete');
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
      const user = userRes.rows[0];
      if (!user) throw new Error('user not found');
      // determine children
      const allRes = await pool.query('SELECT id,parent_id,parents FROM users');
      const all = allRes.rows;
      let hasChildren = false;
      for (const r of all) {
        if (String(r.parent_id) === String(targetId)) { hasChildren = true; break; }
        if (r.parents) {
          try { const arr = typeof r.parents === 'string' ? JSON.parse(r.parents) : r.parents; if (Array.isArray(arr) && arr.map(x => String(x)).includes(String(targetId))) { hasChildren = true; break; } } catch(e) {}
        }
      }
      if (hasChildren) {
        const placeholder = `deleted+${targetId}+${Date.now()}@example.invalid`;
        await pool.query(`UPDATE users SET email = $1, emails = $2 WHERE id = $3`, [placeholder, JSON.stringify([]), targetId]);
        const resultMsg = 'approved: marked no-email (has children)';
        await pool.query(
          `UPDATE requests 
          SET processed = 1,
              processed_by = $1,
              processed_at = CURRENT_TIMESTAMP,
              result = $2
          WHERE id = $3`,
          [actorId, resultMsg, id]
        );
        try {
          const requesterRes = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [row.user_id]
          );
          const requester = requesterRes.rows[0];
          if (requester && requester.email) {
            runAsync(() =>
              safeSendMail({
                from: process.env.SMTP_USER || 'no-reply@example.com',
                to: requester.email,
                subject: 'בקשתך אושרה',
                text: `שלום ${requester.name || ''},\n\nבקשתך להסיר משתמש אושרה. המשתמש שסומן מכיל ילדים ולכן הוסר כתובת המייל והועלה למצב 'ללא מייל'.\n\nבברכה, מנהל המערכת.`
              })
            );
          }
        } catch (e) {
          console.error('requester mail failed:', e);
        }
        return res.json({ ok: true, replaced: true });
      }
      // orphan children and delete
      await pool.query(
        'UPDATE users SET parent_id = NULL WHERE parent_id = $1',
        [targetId]
      );
      const childrenRes = await pool.query(
        'SELECT id, parents FROM users WHERE parents IS NOT NULL'
      );
      const children = childrenRes.rows;
      for (const c of children) {
        try {
          const arr = c.parents ? JSON.parse(c.parents) : [];
          const newArr = arr.filter(x => String(x) !== String(targetId));
          if (newArr.length !== arr.length) await pool.query('UPDATE users SET parents = $1 WHERE id = $2', [JSON.stringify(newArr), c.id]);
        } catch(e) {}
      }
      try {
        await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
      } catch(delErr) {
        if (String(delErr && delErr.message || '').includes('UNIQUE constraint')) {
          const placeholder = `deleted+${targetId}+${Date.now()}@example.invalid`;
          await pool.query(`UPDATE users SET email = $1, emails = $2 WHERE id = $3`, [placeholder, JSON.stringify([]), id]);
          await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
        } else throw delErr;
      }
      const resultMsg = 'approved: deleted user ' + targetId;
      await pool.query(
        `UPDATE requests 
        SET processed = 1,
            processed_by = $1,
            processed_at = CURRENT_TIMESTAMP,
            result = $2
        WHERE id = $3`,
        [actorId, resultMsg, id]
      );
      try {
        const requesterRes = await pool.query(
          'SELECT * FROM users WHERE id = $1',
          [row.user_id]
        );
        const requester = requesterRes.rows[0];
        if (requester && requester.email) {
          await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: requester.email, subject: 'בקשתך אושרה', text: `שלום ${requester.name || ''},\n\nבקשתך למחוק את המשתמש (id: ${targetId}) אושרה והמשתמש הוסר.\n\nבברכה, מנהל המערכת.` });
        }
      } catch(_) {}
      return res.json({ ok: true, deletedId: targetId });
    }

    // unknown action: mark processed but no-op
    const resultMsg = 'approved: no-op (unknown action)';
    await pool.query(
      `UPDATE requests 
      SET processed = 1,
          processed_by = $1,
          processed_at = CURRENT_TIMESTAMP,
          result = $2
      WHERE id = $3`,
      [actorId, resultMsg, id]
    );
    try {
      const requesterRes = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [row.user_id]
      );
      const requester = requesterRes.rows[0];
      if (requester && requester.email) { await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: requester.email, subject: 'בקשתך אושרה', text: `שלום ${requester.name || ''},\n\nבקשתך אושרה (לאבצע פעולה ספציפית).\n\nבברכה, מנהל המערכת.` }); }
    } catch(_) {}
    return res.json({ ok: true });

  } catch(err) {
    console.error('approve request failed', err && err.message ? err.message : err);
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
router.post('/api/requests/:id/deny', authMiddleware, async (req, res) => {
  if (!req.user.is_admin)
    return res.status(403).json({ error: 'admin required' });

  const { id } = req.params;
  const reason = req.body && req.body.reason ? String(req.body.reason) : '';

  try {
    const rowRes = await pool.query(
      'SELECT * FROM requests WHERE id = $1',
      [id]
    );

    const row = rowRes.rows[0];

    if (!row)
      return res.status(404).json({ error: 'request not found' });

    if (row.processed)
      return res.status(400).json({ error: 'already processed' });

    const resultMsg = 'denied' + (reason ? ': ' + reason : '');

    // עדכון DB (חלק קריטי)
    await pool.query(
      `UPDATE requests 
       SET processed = 1,
           processed_by = $1,
           processed_at = CURRENT_TIMESTAMP,
           result = $2
       WHERE id = $3`,
      [req.user.id, resultMsg, id]
    );

    // שליפת משתמש מבקש
    let ruser = null;
    try {
      const ruserRes = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [row.user_id]
      );
      ruser = ruserRes.rows[0];
    } catch (e) {
      console.error('failed to load user:', e);
    }

    // מייל ברקע (לא חוסם את הכפתור)
    if (ruser && ruser.email) {
      setTimeout(() => {
        const subject = 'בקשת מנהל נדחתה';

        let text = `שלום ${ruser.name || ''},\n\nבקשתך נדחתה על ידי המנהל.`;

        if (reason) {
          text += `\n\nסיבת הדחיה:\n${reason}`;
        }

        text += '\n\nאם ברצונך לקבל הבהרות נוספות, פנה למנהל.';

        safeSendMail({
          from: process.env.SMTP_USER || 'no-reply@example.com',
          to: ruser.email,
          subject,
          text
        }).catch(err => {
          console.error('mail failed:', err);
        });
      }, 0);
    }

    return res.json({ ok: true });

  } catch (e) {
    console.error('deny error:', e);
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
