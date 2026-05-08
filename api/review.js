const {
  getBody,
  insertWalletTransaction,
  setCors,
  toNumber,
  withClient
} = require('../lib/db');
const { sendOrderStatusEmail } = require('../lib/email');

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.status(405).json({ ok: false, error: 'Method not allowed' });
  return false;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function resolveAction(req, body) {
  const url = new URL(req.url || '/api/review', 'http://localhost');
  const raw = body.action || url.searchParams.get('action') || url.searchParams.get('path') || url.pathname;
  const route = String(raw || '').replace(/^\/+/, '').replace(/^api\/payments\/review\//, '').replace(/^api\/review\/?/, '');
  if (route.includes('decide')) return 'decide';
  return 'list';
}

function suppliedSecret(req, body) {
  const authSecret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return body.secret || req.headers['x-payment-secret'] || authSecret;
}

function requireReviewAccess(req, res, body) {
  const expected = process.env.PAYMENT_REVIEW_SECRET || process.env.PAYMENT_WEBHOOK_SECRET;
  if (!expected) {
    res.status(503).json({ ok: false, error: 'PAYMENT_REVIEW_SECRET or PAYMENT_WEBHOOK_SECRET is not configured' });
    return false;
  }
  if (suppliedSecret(req, body) !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized payment review' });
    return false;
  }
  return true;
}

async function creditWallet(client, userId, amount) {
  const creditAmount = toNumber(amount, 0);
  if (!userId || creditAmount <= 0) return 0;

  const wallet = await client.query(
    'SELECT balance FROM "B30WalletAccounts" WHERE user_id = $1 FOR UPDATE',
    [userId]
  );
  const currentBalance = wallet.rowCount > 0 ? toNumber(wallet.rows[0].balance, 0) : 0;
  const balanceAfter = currentBalance + creditAmount;

  await client.query(
    `
    INSERT INTO "B30WalletAccounts" (user_id, balance)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET
      balance = EXCLUDED.balance,
      updated_at = NOW()
    `,
    [userId, balanceAfter]
  );

  return balanceAfter;
}

async function insertOrderTrackingEvent(client, event) {
  await client.query(
    `
    INSERT INTO "B30OrderTrackingEvents"
      (order_id, user_id, event_type, order_status, payment_status, title, message, metadata)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      event.orderId,
      event.userId || null,
      event.eventType,
      event.orderStatus || null,
      event.paymentStatus || null,
      event.title,
      event.message || null,
      event.metadata ? JSON.stringify(event.metadata) : null
    ]
  );
}

async function readOrderForEmail(client, orderId) {
  const result = await client.query(
    `
    SELECT
      o.order_id,
      o.order_code,
      o.total_amount,
      o.payment_method,
      o.payment_status,
      o.order_status,
      c.recipient_name,
      c.recipient_email,
      c.recipient_phone,
      c.shipping_address
    FROM "B30Orders" o
    LEFT JOIN "B20OrderContacts" c ON c.order_id = o.order_id
    WHERE o.order_id = $1
    LIMIT 1
    `,
    [orderId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    orderCode: row.order_code,
    total: Number(row.total_amount || 0),
    paymentMethod: row.payment_method || '',
    paymentStatus: row.payment_status || '',
    orderStatus: row.order_status || '',
    contact: {
      name: row.recipient_name || '',
      email: row.recipient_email || '',
      phone: row.recipient_phone || '',
      address: row.shipping_address || ''
    }
  };
}

function reviewTime(value) {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

async function listReviews(req, res, body) {
  const result = await withClient(async client => {
    const walletRequests = await client.query(
      `
      SELECT
        t.transaction_id,
        t.reference_id,
        t.amount,
        t.status,
        t.external_reference,
        t.proof_url,
        t.description,
        t.metadata,
        t.created_at,
        t.updated_at,
        u.user_id,
        u.full_name,
        u.email,
        u.phone,
        COALESCE(w.balance, 0) AS wallet_balance
      FROM "B30WalletTransactions" t
      LEFT JOIN "B20Users" u ON u.user_id = t.user_id
      LEFT JOIN "B30WalletAccounts" w ON w.user_id = t.user_id
      WHERE t.reference_type = 'wallet_deposit'
        AND t.transaction_type = 'deposit_request'
        AND t.status IN ('pending_review', 'awaiting_transfer', 'submitted')
      ORDER BY t.created_at DESC, t.transaction_id DESC
      LIMIT 100
      `
    );

    const orders = await client.query(
      `
      SELECT
        o.order_id,
        o.order_code,
        o.total_amount,
        o.payment_status,
        o.payment_reference,
        o.payment_proof_url,
        o.bank_transfer_note,
        o.created_at,
        o.updated_at,
        u.user_id,
        u.full_name,
        u.email AS user_email,
        u.phone AS user_phone,
        c.recipient_name,
        c.recipient_email,
        c.recipient_phone,
        c.shipping_address
      FROM "B30Orders" o
      LEFT JOIN "B20Users" u ON u.user_id = o.user_id
      LEFT JOIN "B20OrderContacts" c ON c.order_id = o.order_id
      WHERE o.payment_method = 'bank_transfer'
        AND o.payment_status IN ('awaiting_transfer', 'pending_review')
      ORDER BY o.created_at DESC, o.order_id DESC
      LIMIT 100
      `
    );

    const subscriptions = await client.query(
      `
      SELECT
        s.subscription_id,
        s.plan_code,
        s.plan_name,
        s.amount,
        s.status,
        s.payment_reference,
        s.payment_proof_url,
        s.bank_transfer_note,
        s.created_at,
        s.updated_at,
        u.user_id,
        u.full_name,
        u.email,
        u.phone
      FROM "B30Subscriptions" s
      LEFT JOIN "B20Users" u ON u.user_id = s.user_id
      WHERE s.payment_method = 'bank_transfer'
        AND s.status = 'pending_review'
      ORDER BY s.created_at DESC, s.subscription_id DESC
      LIMIT 100
      `
    );

    const items = [
      ...walletRequests.rows.map(row => ({
        type: 'wallet_deposit',
        id: row.transaction_id,
        referenceId: row.reference_id,
        title: row.description || 'Yeu cau nap tien vi EmoBox',
        amount: Number(row.amount || 0),
        status: row.status,
        paymentReference: row.external_reference || '',
        proofUrl: row.proof_url || '',
        note: row.metadata && (row.metadata.bankTransferNote || row.metadata.note) || '',
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        user: {
          userId: row.user_id,
          name: row.full_name || '',
          email: row.email || '',
          phone: row.phone || '',
          balance: Number(row.wallet_balance || 0)
        }
      })),
      ...orders.rows.map(row => ({
        type: 'order',
        id: row.order_id,
        referenceId: row.order_code,
        title: `Don hang ${row.order_code}`,
        amount: Number(row.total_amount || 0),
        status: row.payment_status,
        paymentReference: row.payment_reference || '',
        proofUrl: row.payment_proof_url || '',
        note: row.bank_transfer_note || '',
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        user: {
          userId: row.user_id,
          name: row.full_name || row.recipient_name || '',
          email: row.user_email || row.recipient_email || '',
          phone: row.user_phone || row.recipient_phone || '',
          address: row.shipping_address || ''
        }
      })),
      ...subscriptions.rows.map(row => ({
        type: 'subscription',
        id: row.subscription_id,
        referenceId: String(row.subscription_id),
        title: row.plan_name || row.plan_code,
        amount: Number(row.amount || 0),
        status: row.status,
        paymentReference: row.payment_reference || '',
        proofUrl: row.payment_proof_url || '',
        note: row.bank_transfer_note || '',
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        user: {
          userId: row.user_id,
          name: row.full_name || '',
          email: row.email || '',
          phone: row.phone || ''
        }
      }))
    ].sort((a, b) => reviewTime(b.createdAt) - reviewTime(a.createdAt));

    return {
      items,
      counts: {
        total: items.length,
        walletDeposits: walletRequests.rowCount,
        orders: orders.rowCount,
        subscriptions: subscriptions.rowCount
      }
    };
  });

  return res.status(200).json({ ok: true, ...result });
}

async function decideReview(req, res, body) {
  const type = String(body.type || body.referenceType || '').trim().toLowerCase();
  const referenceId = String(body.referenceId || body.id || '').trim();
  const decision = String(body.decision || '').trim().toLowerCase();
  const paymentReference = String(body.paymentReference || body.transactionId || '').trim();
  const note = String(body.note || '').trim();

  if (!['wallet_deposit', 'order', 'subscription'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'Loai doi soat khong hop le.' });
  }
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ ok: false, error: 'Quyet dinh doi soat khong hop le.' });
  }
  if (!referenceId) {
    return res.status(400).json({ ok: false, error: 'Thieu ma doi soat.' });
  }

  const result = await withClient(async client => {
    if (type === 'wallet_deposit') {
      const tx = await client.query(
        `
        SELECT transaction_id, user_id, amount, status, reference_id
        FROM "B30WalletTransactions"
        WHERE reference_type = 'wallet_deposit'
          AND (reference_id = $1 OR transaction_id::TEXT = $1)
        FOR UPDATE
        `,
        [referenceId]
      );
      if (tx.rowCount === 0) return { updated: false };

      const row = tx.rows[0];
      if (decision === 'approve') {
        if (row.status === 'completed') {
          return { updated: true, alreadyCompleted: true, type, referenceId: row.reference_id };
        }
        const balanceAfter = await creditWallet(client, row.user_id, row.amount);
        await client.query(
          `
          UPDATE "B30WalletTransactions"
          SET status = 'completed',
              balance_after = $2,
              external_reference = COALESCE(NULLIF($3, ''), external_reference),
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
              updated_at = NOW()
          WHERE transaction_id = $1
          `,
          [row.transaction_id, balanceAfter, paymentReference, JSON.stringify({ reviewNote: note, reviewedAt: new Date().toISOString() })]
        );
        return { updated: true, type, referenceId: row.reference_id, status: 'completed', balanceAfter };
      }

      await client.query(
        `
        UPDATE "B30WalletTransactions"
        SET status = 'rejected',
            external_reference = COALESCE(NULLIF($2, ''), external_reference),
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
        WHERE transaction_id = $1
        `,
        [row.transaction_id, paymentReference, JSON.stringify({ reviewNote: note, rejectedAt: new Date().toISOString() })]
      );
      return { updated: true, type, referenceId: row.reference_id, status: 'rejected' };
    }

    if (type === 'order') {
      const orderResult = await client.query(
        `
        SELECT order_id, user_id, order_code, payment_status, order_status
        FROM "B30Orders"
        WHERE UPPER(order_code) = UPPER($1) OR order_id::TEXT = $1
        FOR UPDATE
        `,
        [referenceId]
      );
      if (orderResult.rowCount === 0) return { updated: false };

      const order = orderResult.rows[0];
      const nextStatus = decision === 'approve' ? 'paid' : 'rejected';
      await client.query(
        `
        UPDATE "B30Orders"
        SET payment_status = $2,
            payment_reference = COALESCE(NULLIF($3, ''), payment_reference),
            bank_transfer_note = COALESCE(NULLIF($4, ''), bank_transfer_note),
            paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            updated_at = NOW()
        WHERE order_id = $1
        `,
        [order.order_id, nextStatus, paymentReference, note]
      );
      await insertOrderTrackingEvent(client, {
        orderId: order.order_id,
        userId: order.user_id,
        eventType: decision === 'approve' ? 'payment_paid' : 'payment_rejected',
        orderStatus: order.order_status,
        paymentStatus: nextStatus,
        title: decision === 'approve' ? 'Da xac nhan thanh toan' : 'Thanh toan chua khop',
        message: decision === 'approve'
          ? 'EmoBox da doi soat va xac nhan thanh toan cho don hang.'
          : 'Thong tin chuyen khoan chua khop. Vui long lien he EmoBox de kiem tra lai.',
        metadata: { paymentReference, reviewNote: note }
      });
      await client.query(
        `
        UPDATE "B30GiftSchedules"
        SET paid = TRUE,
            status = 'paid',
            updated_at = NOW()
        WHERE order_id = $1 AND $2 = 'paid'
        `,
        [order.order_id, nextStatus]
      );

      const emailOrder = await readOrderForEmail(client, order.order_id);
      return { updated: true, type, referenceId: order.order_code, status: nextStatus, order: emailOrder };
    }

    const subscriptionId = Number(referenceId);
    const subscriptionResult = await client.query(
      `
      SELECT subscription_id, user_id, plan_code, plan_name, amount, status
      FROM "B30Subscriptions"
      WHERE subscription_id = $1
      FOR UPDATE
      `,
      [subscriptionId || 0]
    );
    if (subscriptionResult.rowCount === 0) return { updated: false };

    const subscription = subscriptionResult.rows[0];
    if (decision === 'approve') {
      if (subscription.status === 'active') {
        return { updated: true, alreadyCompleted: true, type, referenceId: String(subscription.subscription_id) };
      }
      await client.query(
        `
        UPDATE "B30Subscriptions"
        SET status = 'active',
            payment_reference = COALESCE(NULLIF($2, ''), payment_reference),
            bank_transfer_note = COALESCE(NULLIF($3, ''), bank_transfer_note),
            paid_at = COALESCE(paid_at, NOW()),
            updated_at = NOW()
        WHERE subscription_id = $1
        `,
        [subscription.subscription_id, paymentReference, note]
      );
      await client.query(
        `
        UPDATE "B20Users"
        SET plan_code = $1,
            pending_plan_code = NULL,
            registered_at = NOW(),
            updated_at = NOW()
        WHERE user_id = $2
        `,
        [subscription.plan_code, subscription.user_id]
      );
      const balanceAfter = await creditWallet(client, subscription.user_id, subscription.amount);
      await insertWalletTransaction(client, {
        userId: subscription.user_id,
        type: 'subscription_credit',
        amount: subscription.amount,
        balanceAfter,
        paymentMethod: 'bank_transfer',
        referenceType: 'subscription',
        referenceId: String(subscription.subscription_id),
        status: 'completed',
        externalReference: paymentReference,
        description: subscription.plan_name || subscription.plan_code,
        metadata: { subscriptionId: subscription.subscription_id, planCode: subscription.plan_code, reviewNote: note }
      });
      return { updated: true, type, referenceId: String(subscription.subscription_id), status: 'active', balanceAfter };
    }

    await client.query(
      `
      UPDATE "B30Subscriptions"
      SET status = 'rejected',
          payment_reference = COALESCE(NULLIF($2, ''), payment_reference),
          bank_transfer_note = COALESCE(NULLIF($3, ''), bank_transfer_note),
          updated_at = NOW()
      WHERE subscription_id = $1
      `,
      [subscription.subscription_id, paymentReference, note]
    );
    await client.query(
      `
      UPDATE "B20Users"
      SET pending_plan_code = NULL,
          updated_at = NOW()
      WHERE user_id = $1
      `,
      [subscription.user_id]
    );
    return { updated: true, type, referenceId: String(subscription.subscription_id), status: 'rejected' };
  });

  if (!result.updated) {
    return res.status(404).json({ ok: false, error: 'Khong tim thay giao dich doi soat.' });
  }

  if (result.order && result.order.contact && result.order.contact.email) {
    const paid = result.status === 'paid';
    sendOrderStatusEmail({
      to: result.order.contact.email,
      orderCode: result.order.orderCode,
      order: result.order,
      paymentStatus: result.status,
      orderStatus: result.order.orderStatus,
      title: paid ? 'Thanh toan thanh cong' : 'Thanh toan chua khop',
      subject: paid
        ? `EmoBox da xac nhan thanh toan ${result.order.orderCode}`
        : `EmoBox can kiem tra lai thanh toan ${result.order.orderCode}`,
      message: paid
        ? 'EmoBox da doi soat va xac nhan thanh toan cho don hang cua ban.'
        : 'Thong tin chuyen khoan hien chua khop. Vui long lien he EmoBox de kiem tra lai.'
    }).catch(err => console.warn('[EmoBox Email] Khong gui duoc email doi soat:', err.message));
  }

  return res.status(200).json({ ok: true, ...result });
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    if (!requireReviewAccess(req, res, body)) return;

    const action = resolveAction(req, body);
    if (action === 'decide') return await decideReview(req, res, body);
    return await listReviews(req, res, body);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
