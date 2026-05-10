const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const ExcelJS = require('exceljs');

const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { sanitizeHtml, escapeHtml } = require('../utils/helpers');
const { safeSendMail } = require('../utils/mailer');

router.post('/api/send', authMiddleware, upload.array('files'), async (req, res) => {
  let { recipients, subject, message } = req.body;
  // when using multipart/form-data (FormData) recipients may arrive as a JSON string
  try {
    if (typeof recipients === 'string') {
      try { recipients = JSON.parse(recipients); }
      catch(_) { // fallback: allow comma-separated ids
        recipients = recipients.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
  } catch(e) { /* ignore */ }
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ error: 'recipients required' });
  // normalize ids to simple values for the SQL placeholders
  recipients = recipients.map(r => { if (typeof r === 'string' && r.match(/^\d+$/)) return parseInt(r); return r; });
  const files = req.files || [];
  const { rows } = await pool.query(`SELECT id,emails,name,email FROM users WHERE id= ANY($1)`, [recipients]);
  if (!rows || rows.length === 0) return res.status(400).json({ error: 'no recipients found' });

  // ensure sender is verified
  const { rows: senderRows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const sender = senderRows[0];
  if (!sender) return res.status(404).json({ error: 'sender not found' });
  if (!sender.verified) return res.status(403).json({ error: 'sender email not verified' });

  try {
    // flatten emails arrays and dedupe
    let sendTo = [];
    rows.forEach(r => {
      try { const arr = r.emails ? JSON.parse(r.emails) : (r.email ? [r.email] : []); sendTo = sendTo.concat(arr); } catch(e) { if (r.email) sendTo.push(r.email); }
    });
    sendTo = Array.from(new Set(sendTo.map(s => String(s).trim())));
    // if no actual email addresses resolved, return a clear error
    if (!sendTo || sendTo.length === 0) {
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
router.get('/api/tree', authMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users ORDER BY name');
  rows.forEach(r => { try { r.parents = r.parents ? JSON.parse(r.parents) : []; } catch(e) { r.parents = []; } try { r.emails = r.emails ? JSON.parse(r.emails) : (r.email ? [r.email] : []); } catch(e) { r.emails = r.email ? [r.email] : []; } r.email = r.emails && r.emails.length ? r.emails[0] : r.email; });
  // choose primary parent for tree building: parent_id if present, else first of parents array
  const map = {};
  rows.forEach(r => { r.children = []; map[r.id] = r; });
  const roots = [];
  rows.forEach(r => {
    const p = r.parent_id || (r.parents && r.parents.length ? r.parents[0] : null);
    if (p && map[p]) map[p].children.push(r);
    else roots.push(r);
  });
  res.json(roots);
});

// Export hierarchical Excel file (admin: all users, non-admin: user's subtree)
router.get('/api/export-xlsx', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,name,email,phone,is_admin,verified,parent,grandparent,parent_id,parents,emails FROM users');
    rows.forEach(r => { try { r.parents = r.parents ? JSON.parse(r.parents) : []; } catch(e) { r.parents = []; } try { r.emails = r.emails ? JSON.parse(r.emails) : (r.email ? [r.email] : []); } catch(e) { r.emails = r.email ? [r.email] : []; } r.email = r.emails && r.emails.length ? r.emails[0] : r.email; });
    const map = {};
    rows.forEach(r => { r.children = []; map[r.id] = r; });
    // build tree using parent_id if present, else first element of parents array
    rows.forEach(r => {
      const p = r.parent_id || (r.parents && r.parents.length ? r.parents[0] : null);
      if (p && map[p]) map[p].children.push(r);
    });

    // choose roots depending on admin
    let roots = [];
    if (req.user.is_admin) {
      rows.forEach(r => { const p = r.parent_id || (r.parents && r.parents.length ? r.parents[0] : null); if (!(p && map[p])) roots.push(r); });
    } else {
      const me = map[req.user.id];
      if (!me) return res.status(404).json({ error: 'user not found' });
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
    Object.values(map).forEach(n => { idToName[n.id] = n.name; });

    // DFS traversal
    function addNode(node, level, parentChainIds) {
      const parentChainNames = (parentChainIds || []).map(id => idToName[id] || String(id)).join(' > ');
      const indent = Array(Math.max(0, level - 1)).fill('—').join(' ');
      const row = sheet.addRow({ level, name: (indent ? indent + ' ' : '') + (node.name || ''), email: (node.emails || []).length ? (node.emails || [])[0] : (node.email || ''), phone: node.phone || '', parent_chain: parentChainNames });
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
        if (colKey === 'name' || colKey === 'parent_chain') cell.alignment = { horizontal: 'right', vertical: 'middle' };
        else cell.alignment = { horizontal: 'left', vertical: 'middle' };
      });
      if (node.children && node.children.length) {
        // sort children by name
        node.children.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        for (const c of node.children) { addNode(c, level + 1, (parentChainIds || []).concat(node.id)); }
      }
    }

    // sort roots by name
    roots.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    roots.forEach(r => addNode(r, 1, r.parents && r.parents.length ? r.parents.slice(0) : []));

    const filename = `family-hierarchy-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch(e) {
    console.error('export-xlsx failed', e && e.message ? e.message : e);
    res.status(500).json({ error: 'failed to generate excel', detail: e.message });
  }
});

module.exports = router;
