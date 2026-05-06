const { getBody, normalizeEmail, query, setCors, sha256 } = require('../../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const email = normalizeEmail(body.email);
    const passwordHash = sha256(body.password);

    const result = await query(
      `
      SELECT
        u.user_id,
        u.full_name,
        u.email,
        u.phone,
        u.address,
        u.password_hash,
        u.plan_code,
        u.pending_plan_code,
        u.registered_at,
        COALESCE(w.balance, 0) AS balance
      FROM "B20Users" u
      LEFT JOIN "B30WalletAccounts" w ON w.user_id = u.user_id
      WHERE u.email = $1
      LIMIT 1
      `,
      [email]
    );

    if (result.rowCount === 0) {
      return res.status(500).json({ ok: false, error: 'Tai khoan chua ton tai!' });
    }

    const user = result.rows[0];
    if (user.password_hash && user.password_hash !== passwordHash) {
      return res.status(500).json({ ok: false, error: 'Sai mat khau!' });
    }

    return res.status(200).json({
      ok: true,
      userId: user.user_id,
      name: user.full_name,
      email: user.email,
      phone: user.phone || '',
      address: user.address || '',
      plan: user.plan_code || 'none',
      pendingPlan: user.pending_plan_code || null,
      registeredAt: user.registered_at,
      balance: Number(user.balance || 0)
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
