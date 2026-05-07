const { setCors } = require('../../lib/db');

function redact(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function directStatus() {
  const user = process.env.EMAIL_USER || process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.EMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASS || process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || (user ? `EmoBox <${user}>` : '');
  const adminTo = process.env.EMAIL_ADMIN_TO || user;

  return {
    configured: Boolean(user && pass && from),
    hasUser: Boolean(user),
    hasPassword: Boolean(pass),
    hasFrom: Boolean(from),
    user: redact(user),
    from: from ? from.replace(/<([^>]+)>/, (_, email) => `<${redact(email)}>`): '',
    adminTo: redact(adminTo),
    provider: process.env.SMTP_HOST ? 'smtp' : 'gmail',
    host: process.env.SMTP_HOST || 'gmail',
    port: process.env.SMTP_HOST ? Number(process.env.SMTP_PORT || 587) : 465
  };
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  return res.status(200).json({ ok: true, email: directStatus() });
};
