const { getBody, setCors, upsertUser, withClient } = require('../../lib/db');

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
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
      if (!user.userId) return { userId: null, balance: 0, transactions: [] };

      const wallet = await client.query(
        'SELECT balance FROM "B30WalletAccounts" WHERE user_id = $1 LIMIT 1',
        [user.userId]
      );

      const transactions = await client.query(
        `
        SELECT
          transaction_id,
          transaction_type,
          amount,
          balance_after,
          payment_method,
          reference_type,
          reference_id,
          description,
          metadata,
          created_at
        FROM "B30WalletTransactions"
        WHERE user_id = $1
        ORDER BY created_at DESC, transaction_id DESC
        LIMIT 100
        `,
        [user.userId]
      );

      return {
        userId: user.userId,
        balance: Number(wallet.rows[0] && wallet.rows[0].balance || 0),
        transactions: transactions.rows.map(row => ({
          transactionId: row.transaction_id,
          type: row.transaction_type,
          amount: Number(row.amount || 0),
          balanceAfter: row.balance_after === null ? null : Number(row.balance_after || 0),
          paymentMethod: row.payment_method || '',
          referenceType: row.reference_type || '',
          referenceId: row.reference_id || '',
          description: row.description || '',
          metadata: row.metadata || {},
          createdAt: toIso(row.created_at)
        }))
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
