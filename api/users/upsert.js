const { getBody, setCors, upsertUser, withClient } = require('../../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const result = await withClient(client => upsertUser(client, body.user));
    return res.status(200).json({ ok: true, userId: result.userId, email: result.email });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
