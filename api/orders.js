const {
  getBody,
  insertWalletTransaction,
  orderCode,
  setCors,
  toNumber,
  upsertUser,
  withClient
} = require('../lib/db');
const { sendOrderEmails } = require('../lib/email');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const order = body.order || {};
    const items = Array.isArray(order.items) ? order.items : [];
    const subtotal = toNumber(order.subtotal, 0);
    const shippingFee = toNumber(order.shippingFee, 0);
    const total = toNumber(order.total, subtotal + shippingFee);
    const paymentMethod = order.paymentMethod || 'card';
    const paymentStatus = paymentMethod === 'cod' ? 'pending' : 'paid';

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const code = orderCode();

      const orderResult = await client.query(
        `
        INSERT INTO "B30Orders"
          (user_id, order_code, subtotal, shipping_fee, total_amount, payment_method, payment_status, order_status)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, 'processing')
        RETURNING order_id, order_code, payment_status
        `,
        [user.userId, code, subtotal, shippingFee, total, paymentMethod, paymentStatus]
      );

      const savedOrder = orderResult.rows[0];
      const contact = order.contact || {};
      await client.query(
        `
        INSERT INTO "B20OrderContacts"
          (order_id, user_id, recipient_name, recipient_phone, recipient_email, shipping_address, personal_message, is_anonymous_sender)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          savedOrder.order_id,
          user.userId,
          contact.name || 'Nguoi nhan',
          contact.phone || '',
          contact.email || '',
          contact.address || '',
          contact.message || null,
          Boolean(contact.anonymousSender)
        ]
      );

      for (const item of items) {
        const unitPrice = toNumber(item.unitPrice || item.priceNum || item.pkgPrice, 0);
        const quantity = Math.max(1, parseInt(item.quantity || 1, 10));
        const lineTotal = toNumber(item.lineTotal, unitPrice * quantity);
        const itemId = item.id || 'unknown';

        await client.query(
          `
          INSERT INTO "B30OrderItems"
            (order_id, product_code, product_name, image_path, unit_price, quantity, line_total, is_scheduled_gift, package_json)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            savedOrder.order_id,
            itemId,
            item.name || item.productName || 'Gift item',
            item.image || null,
            unitPrice,
            quantity,
            lineTotal,
            itemId.startsWith('evt_'),
            JSON.stringify(item)
          ]
        );

        if (itemId.startsWith('evt_') && user.userId) {
          await client.query(
            `
            UPDATE "B30GiftSchedules"
            SET order_id = $1,
                paid = CASE WHEN $2 = 'paid' THEN TRUE ELSE paid END,
                status = CASE WHEN $2 = 'paid' THEN 'paid' ELSE status END,
                updated_at = NOW()
            WHERE user_id = $3 AND local_event_id = $4
            `,
            [savedOrder.order_id, paymentStatus, user.userId, itemId]
          );
        }
      }

      if (paymentMethod === 'wallet' && user.userId) {
        await insertWalletTransaction(client, {
          userId: user.userId,
          type: 'order_payment',
          amount: -total,
          balanceAfter: toNumber(body.user && body.user.balance, 0),
          paymentMethod,
          referenceType: 'order',
          referenceId: savedOrder.order_code,
          description: 'Thanh toan don hang',
          metadata: order
        });
      }

      return {
        orderId: savedOrder.order_id,
        orderCode: savedOrder.order_code,
        paymentStatus: savedOrder.payment_status,
        order: {
          subtotal,
          shippingFee,
          total,
          paymentMethod
        },
        contact,
        items,
        user: body.user || {}
      };
    });

    let email = { sent: false, skipped: true };
    try {
      email = await sendOrderEmails(result);
    } catch (err) {
      email = { sent: false, skipped: false, error: err.message };
    }

    return res.status(200).json({
      ok: true,
      orderId: result.orderId,
      orderCode: result.orderCode,
      paymentStatus: result.paymentStatus,
      email
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
