const { getBody, setCors } = require('../../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const { sendRegistrationEmail } = require('../../lib/email');
    const email = await sendRegistrationEmail({ user: body.user || {} });
    return res.status(200).json({ ok: true, email });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      email: {
        sent: false,
        skipped: false,
        error: err.message
      }
    });
  }
};
