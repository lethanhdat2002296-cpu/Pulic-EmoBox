const { getBody, resolveUser, setCors, withClient } = require('../../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const user = await resolveUser(client, body.user);
      if (!user.userId) return { userId: null, card: null };

      const card = await client.query(
        `
        SELECT cardholder_name, card_number, card_last4, expiry_month, expiry_year, card_brand
        FROM "B30BankCards"
        WHERE user_id = $1
        LIMIT 1
        `,
        [user.userId]
      );

      if (card.rowCount === 0) return { userId: user.userId, card: null };

      const row = card.rows[0];
      return {
        userId: user.userId,
        card: {
          holderName: row.cardholder_name,
          cardNumber: row.card_number,
          last4: row.card_last4,
          expiryMonth: row.expiry_month,
          expiryYear: row.expiry_year,
          expiry: `${row.expiry_month}/${row.expiry_year}`,
          brand: row.card_brand || ''
        }
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
