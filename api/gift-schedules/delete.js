const { getBody, setCors, upsertUser, withClient } = require('../../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      if (user.userId && body.localEventId) {
        await client.query(
          `
          UPDATE "B30GiftSchedules"
          SET deleted_at = NOW(),
              updated_at = NOW(),
              status = 'deleted'
          WHERE user_id = $1 AND local_event_id = $2
          `,
          [user.userId, body.localEventId]
        );
      }

      return { userId: user.userId, localEventId: body.localEventId || null };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
