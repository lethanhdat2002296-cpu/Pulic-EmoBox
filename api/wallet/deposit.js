const { getBody, insertWalletTransaction, setCors, toNumber, upsertUser, withClient } = require('../../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const amount = Math.abs(toNumber(body.amount, 0));

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const balanceAfter = toNumber(body.user && body.user.balance, amount);

      await insertWalletTransaction(client, {
        userId: user.userId,
        type: 'deposit',
        amount,
        balanceAfter,
        paymentMethod: body.paymentMethod || 'bank',
        referenceType: 'wallet',
        description: 'Nap tien vi EmoBox',
        metadata: body.bankInfo || {}
      });

      return { userId: user.userId, balanceAfter };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
