const { setCors } = require('../../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { getEmailStatus } = require('../../lib/email');
    return res.status(200).json({ ok: true, email: getEmailStatus() });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      email: {
        configured: false,
        error: err.message
      }
    });
  }
};
