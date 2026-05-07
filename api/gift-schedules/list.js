const { getBody, setCors, upsertUser, withClient } = require('../../lib/db');

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function rowToEvent(row) {
  const payload = row.package_json && typeof row.package_json === 'object' ? row.package_json : {};
  return {
    ...payload,
    id: row.local_event_id,
    date: dateOnly(row.gift_date),
    title: payload.title || `Qua cho ${row.recipient_name || ''}`.trim(),
    recipient: payload.recipient || row.recipient_name || '',
    address: payload.address || row.shipping_address || '',
    phone: payload.phone || row.recipient_phone || '',
    email: payload.email || row.recipient_email || '',
    group: payload.group || row.group_code || '',
    cat: payload.cat || row.category_code || '',
    tier: payload.tier || row.tier_code || '',
    pkgName: payload.pkgName || row.package_name || 'Gift package',
    priceNum: Number(payload.priceNum || row.amount || 0),
    paid: Boolean(row.paid),
    status: row.status || 'pending'
  };
}

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
      if (!user.userId) return { userId: null, events: [] };

      const schedules = await client.query(
        `
        SELECT
          s.local_event_id,
          s.gift_date,
          s.group_code,
          s.category_code,
          s.tier_code,
          s.package_name,
          s.amount,
          s.paid,
          s.status,
          s.package_json,
          r.full_name AS recipient_name,
          r.phone AS recipient_phone,
          r.email AS recipient_email,
          r.address AS shipping_address
        FROM "B30GiftSchedules" s
        LEFT JOIN "B20GiftRecipients" r ON r.recipient_id = s.recipient_id
        WHERE s.user_id = $1
          AND s.deleted_at IS NULL
        ORDER BY s.gift_date ASC, s.created_at ASC
        `,
        [user.userId]
      );

      return {
        userId: user.userId,
        events: schedules.rows.map(rowToEvent)
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
