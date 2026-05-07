const {
  getBody,
  insertWalletTransaction,
  setCors,
  toNumber,
  upsertUser,
  withClient
} = require('../../lib/db');
const { sendGiftScheduleEmail } = require('../../lib/email');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const eventData = body.event || {};
    const localEventId = eventData.id;
    const amount = toNumber(eventData.priceNum || eventData.amount, 0);
    const paid = Boolean(eventData.paid);
    const paymentMethod = body.paymentMethod || 'bank';

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      if (!user.userId || !localEventId) {
        return { userId: user.userId, localEventId: localEventId || null, created: false };
      }

      const recipientResult = await client.query(
        `
        INSERT INTO "B20GiftRecipients"
          (user_id, local_event_id, full_name, phone, email, address)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, local_event_id) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          address = EXCLUDED.address,
          updated_at = NOW()
        RETURNING recipient_id
        `,
        [
          user.userId,
          localEventId,
          eventData.recipient || 'Nguoi nhan',
          eventData.phone || '',
          eventData.email || null,
          eventData.address || ''
        ]
      );

      const recipientId = recipientResult.rows[0].recipient_id;
      const existingSchedule = await client.query(
        `
        SELECT schedule_id
        FROM "B30GiftSchedules"
        WHERE user_id = $1
          AND local_event_id = $2
          AND deleted_at IS NULL
        `,
        [user.userId, localEventId]
      );

      await client.query(
        `
        INSERT INTO "B30GiftSchedules"
          (user_id, recipient_id, local_event_id, gift_date, group_code, category_code, tier_code, package_name, amount, paid, status, package_json, deleted_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)
        ON CONFLICT (user_id, local_event_id) DO UPDATE SET
          recipient_id = EXCLUDED.recipient_id,
          gift_date = EXCLUDED.gift_date,
          group_code = EXCLUDED.group_code,
          category_code = EXCLUDED.category_code,
          tier_code = EXCLUDED.tier_code,
          package_name = EXCLUDED.package_name,
          amount = EXCLUDED.amount,
          paid = EXCLUDED.paid,
          status = EXCLUDED.status,
          package_json = EXCLUDED.package_json,
          deleted_at = NULL,
          updated_at = NOW()
        `,
        [
          user.userId,
          recipientId,
          localEventId,
          eventData.date || new Date().toISOString().slice(0, 10),
          eventData.group || null,
          eventData.cat || null,
          eventData.tier || null,
          eventData.pkgName || 'Gift package',
          amount,
          paid,
          paid ? 'paid' : 'pending',
          JSON.stringify(eventData)
        ]
      );

      if (paid && paymentMethod === 'wallet') {
        await insertWalletTransaction(client, {
          userId: user.userId,
          type: 'gift_schedule_payment',
          amount: -amount,
          balanceAfter: toNumber(body.user && body.user.balance, 0),
          paymentMethod,
          referenceType: 'gift_schedule',
          referenceId: localEventId,
          description: eventData.pkgName || 'Thanh toan lich tang qua',
          metadata: eventData
        });
      }

      return { userId: user.userId, localEventId, created: existingSchedule.rowCount === 0 };
    });

    let email = { sent: false, skipped: true };
    try {
      email = await sendGiftScheduleEmail({
        user: body.user || {},
        event: eventData,
        paymentMethod
      });
    } catch (err) {
      email = { sent: false, skipped: false, error: err.message };
    }

    return res.status(200).json({ ok: true, ...result, notificationEmail: email });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
