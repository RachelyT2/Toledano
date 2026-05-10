const nodemailer = require('nodemailer');
const { escapeHtml } = require('./helpers');

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

async function safeSendMail(mailOptions) {
  try {
    const transport = await getTransport();
    return await transport.sendMail(mailOptions);
  } catch(e) {
    console.error('SMTP send failed:', e);
    throw e;
  }
}

async function notifyAdmin(text) {
  try {
    if (!process.env.ADMIN_EMAIL) return;
    await safeSendMail({
      from: process.env.SMTP_USER || 'no-reply@example.com',
      to: process.env.ADMIN_EMAIL,
      subject: 'Family list notification',
      text: text
    });
  } catch (e) {
    console.error('notifyAdmin failed', e.message);
  }
}

async function sendVerificationEmail(email, name, token, baseUrl) {
  try {
    const link = `${baseUrl}/verify?token=${token}`;
    const subject = 'אימות כתובת אימייל - משפחה';
    const text = `שלום ${name || ''},\n\nנא לאשר את כתובת הדוא'ל באמצעות הקישור הזה:\n${link}\n\nאם לא ידעת על בקשה זו, התעלם מהודעה זו.`;
    const html = `<p>שלום ${escapeHtml(name || '')},</p><p>נא לאשר את כתובת הדוא'ל באמצעות הקישור הזה:</p><p><a href="${link}">${link}</a></p><p>אם לא ידעת על בקשה זו, התעלם מהודעה זו.</p>`;
    await safeSendMail({ from: process.env.SMTP_USER || 'no-reply@example.com', to: email, subject, text, html });
  } catch (e) {
    console.error('sendVerificationEmail failed', e.message);
  }
}

async function sendNewUserWelcomeEmail(email, name, tempPassword, token, baseUrl) {
  try {
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
  } catch(e) {
    console.error('sendNewUserWelcomeEmail failed', e && e.message ? e.message : e);
  }
}

module.exports = { getTransport, safeSendMail, notifyAdmin, sendVerificationEmail, sendNewUserWelcomeEmail };
