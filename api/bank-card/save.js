const { getBody, setCors, upsertUser, withClient } = require('../../lib/db');

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function brandFromNumber(cardNumber) {
  if (/^4/.test(cardNumber)) return 'Visa';
  if (/^5[1-5]/.test(cardNumber) || /^2[2-7]/.test(cardNumber)) return 'Mastercard';
  if (/^3[47]/.test(cardNumber)) return 'American Express';
  return 'Bank card';
}

function parseExpiry(value) {
  const match = String(value || '').trim().match(/^(0[1-9]|1[0-2])\/?([0-9]{2})$/);
  if (!match) return null;
  return {
    month: match[1],
    year: match[2]
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
    const card = body.card || {};
    const cardNumber = onlyDigits(card.cardNumber);
    const expiry = parseExpiry(card.expiry);
    const holderName = String(card.holderName || '').trim().toUpperCase();

    if (!/^[0-9]{13,19}$/.test(cardNumber)) {
      return res.status(400).json({ ok: false, error: 'So the ngan hang khong hop le' });
    }
    if (!expiry) {
      return res.status(400).json({ ok: false, error: 'Ngay het han the khong hop le' });
    }
    if (!holderName) {
      return res.status(400).json({ ok: false, error: 'Ten in tren the khong hop le' });
    }

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      if (!user.userId) return { userId: null, card: null };

      await client.query(
        `
        INSERT INTO "B30BankCards"
          (user_id, cardholder_name, card_number, card_last4, expiry_month, expiry_year, card_brand)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id) DO UPDATE SET
          cardholder_name = EXCLUDED.cardholder_name,
          card_number = EXCLUDED.card_number,
          card_last4 = EXCLUDED.card_last4,
          expiry_month = EXCLUDED.expiry_month,
          expiry_year = EXCLUDED.expiry_year,
          card_brand = EXCLUDED.card_brand,
          updated_at = NOW()
        `,
        [
          user.userId,
          holderName,
          cardNumber,
          cardNumber.slice(-4),
          expiry.month,
          expiry.year,
          brandFromNumber(cardNumber)
        ]
      );

      return {
        userId: user.userId,
        card: {
          holderName,
          cardNumber,
          last4: cardNumber.slice(-4),
          expiryMonth: expiry.month,
          expiryYear: expiry.year,
          expiry: `${expiry.month}/${expiry.year}`,
          brand: brandFromNumber(cardNumber)
        }
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
