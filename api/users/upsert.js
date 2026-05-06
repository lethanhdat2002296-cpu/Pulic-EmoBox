const { getBody, normalizeEmail, setCors, upsertUser, withClient } = require('../../lib/db');
const { sendRegistrationEmail } = require('../../lib/email');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const userEmail = normalizeEmail(body.user && body.user.email);
      const existing = userEmail
        ? await client.query('SELECT user_id FROM "B20Users" WHERE email = $1', [userEmail])
        : { rowCount: 0 };
      const savedUser = await upsertUser(client, body.user);
      return { ...savedUser, created: existing.rowCount === 0 };
    });
    let email = { sent: false, skipped: true };

    if (body.user && body.user.password && result.created) {
      try {
        email = await sendRegistrationEmail({ user: body.user });
      } catch (err) {
        email = { sent: false, skipped: false, error: err.message };
      }
    }

    return res.status(200).json({ ok: true, userId: result.userId, email: result.email, notificationEmail: email });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
