function sanitizeHtml(html) {
  return html
    .replace(/<script.*?>.*?<\/script>/gi, '')
    .replace(/on\w+=".*?"/g, '');
}

function getBaseUrl(req) {
  return process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
}

function runAsync(fn) {
  setTimeout(() => {
    fn().catch(console.error);
  }, 0);
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  email = email.trim();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { sanitizeHtml, getBaseUrl, runAsync, isValidEmail, escapeHtml };
