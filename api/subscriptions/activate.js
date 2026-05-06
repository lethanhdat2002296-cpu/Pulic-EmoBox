const { getBody, insertWalletTransaction, setCors, toNumber, upsertUser, withClient } = require('../../lib/db');

function monthsForPlan(planCode) {
  if (planCode === '3-months') return 3;
  if (planCode === '6-months') return 6;
  if (planCode === '12-months') return 12;
  return 0;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const planCode = body.planCode || '';
    const plan = body.plan || {};
    const amount = toNumber(plan.price, 0);
    const months = monthsForPlan(planCode);

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const startAt = new Date();
      const endAt = months > 0 ? new Date(startAt) : null;
      if (endAt) endAt.setMonth(endAt.getMonth() + months);

      await client.query(
        `
        UPDATE "B20Users"
        SET plan_code = $1,
            pending_plan_code = NULL,
            registered_at = $2,
            updated_at = NOW()
        WHERE user_id = $3
        `,
        [planCode, startAt.toISOString(), user.userId]
      );

      await client.query(
        `
        INSERT INTO "B30Subscriptions"
          (user_id, plan_code, plan_name, amount, payment_method, status, start_at, end_at)
        VALUES
          ($1, $2, $3, $4, $5, 'active', $6, $7)
        `,
        [user.userId, planCode, plan.name || planCode, amount, body.paymentMethod || 'card', startAt.toISOString(), endAt ? endAt.toISOString() : null]
      );

      const balanceAfter = toNumber(body.user && body.user.balance, 0);
      await insertWalletTransaction(client, {
        userId: user.userId,
        type: 'subscription_credit',
        amount,
        balanceAfter,
        paymentMethod: body.paymentMethod || 'card',
        referenceType: 'subscription',
        referenceId: planCode,
        description: plan.name || planCode
      });

      return { userId: user.userId, planCode, balanceAfter };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
