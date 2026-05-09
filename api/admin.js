const crypto = require('crypto');
const {
  getBody,
  insertWalletTransaction,
  setCors,
  toNumber,
  withClient
} = require('../lib/db');
const { sendOrderStatusEmail, sendVoucherEmail } = require('../lib/email');

const DEFAULT_SETTINGS = {
  reviewMode: 'manual',
  autoReviewDelaySeconds: 10
};

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

function hashPassword(password, salt) {
  const passwordSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), passwordSalt, 64).toString('hex');
  return `scrypt:${passwordSalt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const stored = String(storedHash || '');
  const parts = stored.split(':');
  if (parts.length === 3 && parts[0] === 'scrypt') {
    const candidate = hashPassword(password, parts[1]);
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
  }

  const legacy = crypto.createHash('sha256').update(String(password || '')).digest('hex');
  return legacy === stored;
}

function tokenSecret() {
  return process.env.ADMIN_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signToken(admin) {
  const secret = tokenSecret();
  if (!secret) {
    const err = new Error('Chua cau hinh ADMIN_SECRET hoac PAYMENT_WEBHOOK_SECRET.');
    err.statusCode = 503;
    throw err;
  }

  const payload = {
    adminId: admin.admin_id,
    email: admin.email,
    role: admin.role || 'admin',
    exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60
  };
  const encoded = base64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token) {
  const secret = tokenSecret();
  if (!secret || !token || !String(token).includes('.')) return null;
  const [encoded, signature] = String(token).split('.');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (signature !== expected) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function adminTokenFrom(req, body) {
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return body.adminToken || body.token || auth;
}

function resolveAction(req, body) {
  const url = new URL(req.url || '/api/admin', 'http://localhost');
  return String(body.action || url.searchParams.get('action') || url.pathname.split('/').pop() || 'dashboard')
    .trim()
    .toLowerCase();
}

async function ensureAdminSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "B20AdminUsers" (
      admin_id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS "B30AdminSettings" (
      setting_key TEXT PRIMARY KEY,
      setting_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(
    `
    INSERT INTO "B30AdminSettings" (setting_key, setting_value)
    VALUES ('payment_review', $1::jsonb)
    ON CONFLICT (setting_key) DO NOTHING
    `,
    [JSON.stringify(DEFAULT_SETTINGS)]
  );

  const seedEmail = String(process.env.ADMIN_EMAIL || process.env.EMAIL_ADMIN_TO || '').trim().toLowerCase();
  const seedPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  if (seedEmail && seedPassword) {
    await client.query(
      `
      INSERT INTO "B20AdminUsers" (full_name, email, password_hash, role)
      VALUES ($1, $2, $3, 'owner')
      ON CONFLICT (email) DO NOTHING
      `,
      [process.env.ADMIN_NAME || 'EmoBox Admin', seedEmail, hashPassword(seedPassword)]
    );
  }
}

async function requireAdmin(req, res, body, client) {
  const payload = verifyToken(adminTokenFrom(req, body));
  if (!payload || !payload.adminId) {
    res.status(401).json({ ok: false, error: 'Vui long dang nhap admin.' });
    return null;
  }

  const result = await client.query(
    `
    SELECT admin_id, full_name, email, role, active, last_login_at
    FROM "B20AdminUsers"
    WHERE admin_id = $1 AND active = TRUE
    LIMIT 1
    `,
    [payload.adminId]
  );
  if (result.rowCount === 0) {
    res.status(401).json({ ok: false, error: 'Tai khoan admin khong hop le.' });
    return null;
  }
  return result.rows[0];
}

async function getSettings(client) {
  const result = await client.query(
    'SELECT setting_value FROM "B30AdminSettings" WHERE setting_key = $1 LIMIT 1',
    ['payment_review']
  );
  return Object.assign({}, DEFAULT_SETTINGS, result.rows[0] && result.rows[0].setting_value || {});
}

async function saveSettingsValue(client, nextSettings) {
  const cleanSettings = {
    reviewMode: nextSettings.reviewMode === 'auto' ? 'auto' : 'manual',
    autoReviewDelaySeconds: 10
  };
  await client.query(
    `
    INSERT INTO "B30AdminSettings" (setting_key, setting_value, updated_at)
    VALUES ('payment_review', $1::jsonb, NOW())
    ON CONFLICT (setting_key) DO UPDATE SET
      setting_value = EXCLUDED.setting_value,
      updated_at = NOW()
    `,
    [JSON.stringify(cleanSettings)]
  );
  return cleanSettings;
}

function normalizeVoucherCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function voucherCustomerLabel(value) {
  const labels = {
    all: 'Tat ca khach hang',
    none: 'Thanh vien thuong',
    member: 'Tat ca thanh vien co goi',
    '3-months': 'Thanh vien 3 thang',
    '6-months': 'Thanh vien 6 thang',
    '12-months': 'Thanh vien 12 thang'
  };
  return labels[value] || value || 'Tat ca khach hang';
}

function voucherRow(row) {
  return {
    voucherId: row.voucher_id,
    code: row.code,
    discountPercent: Number(row.discount_percent || 0),
    customerType: row.customer_type || 'all',
    customerTypeLabel: voucherCustomerLabel(row.customer_type || 'all'),
    expiresAt: toIso(row.expires_at),
    sendMethod: row.send_method || 'email_all',
    sendStatus: row.send_status || 'created',
    lastSentAt: toIso(row.last_sent_at),
    lastSentCount: Number(row.last_sent_count || 0),
    facebookPostUrl: row.facebook_post_url || '',
    active: Boolean(row.active),
    usedCount: Number(row.used_count || 0),
    discountTotal: Number(row.discount_total || 0),
    createdAt: toIso(row.created_at)
  };
}

async function listVouchers(client) {
  const result = await client.query(
    `
    SELECT
      v.voucher_id,
      v.code,
      v.discount_percent,
      v.customer_type,
      v.expires_at,
      v.send_method,
      v.send_status,
      v.last_sent_at,
      v.last_sent_count,
      v.facebook_post_url,
      v.active,
      v.created_at,
      COUNT(r.redemption_id)::INT AS used_count,
      COALESCE(SUM(r.discount_amount), 0)::NUMERIC AS discount_total
    FROM "B30Vouchers" v
    LEFT JOIN "B30VoucherRedemptions" r ON r.voucher_id = v.voucher_id
    GROUP BY v.voucher_id
    ORDER BY v.created_at DESC
    LIMIT 100
    `
  );
  return result.rows.map(voucherRow);
}

async function createVoucherRecord(client, body) {
  const code = normalizeVoucherCode(body.code);
  const discountPercent = Number(body.discountPercent || body.discount_percent || 0);
  const customerType = String(body.customerType || body.customer_type || 'all').trim();
  const sendMethod = String(body.sendMethod || body.send_method || 'email_all').trim();
  const facebookPostUrl = String(body.facebookPostUrl || body.facebook_post_url || '').trim();
  const allowedDiscounts = [5, 10, 15, 20];
  const allowedCustomers = ['all', 'none', 'member', '3-months', '6-months', '12-months'];
  const allowedSendMethods = ['email_all', 'facebook'];
  const expiresAt = new Date(body.expiresAt || body.expires_at || '');

  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    const err = new Error('Ma voucher chi gom chu, so, dau gach ngang/gach duoi va dai 3-32 ky tu.');
    err.statusCode = 400;
    throw err;
  }
  if (!allowedDiscounts.includes(discountPercent)) {
    const err = new Error('Chiet khau voucher chi duoc chon 5%, 10%, 15% hoac 20%.');
    err.statusCode = 400;
    throw err;
  }
  if (!allowedCustomers.includes(customerType)) {
    const err = new Error('Loai khach hang ap dung voucher khong hop le.');
    err.statusCode = 400;
    throw err;
  }
  if (!allowedSendMethods.includes(sendMethod)) {
    const err = new Error('Hinh thuc gui voucher khong hop le.');
    err.statusCode = 400;
    throw err;
  }
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    const err = new Error('Thoi gian het han voucher phai lon hon hien tai.');
    err.statusCode = 400;
    throw err;
  }

  const duplicate = await client.query(
    'SELECT voucher_id FROM "B30Vouchers" WHERE UPPER(code) = UPPER($1) LIMIT 1',
    [code]
  );
  if (duplicate.rowCount > 0) {
    const err = new Error('Ma voucher da ton tai. Vui long dung ma khac.');
    err.statusCode = 409;
    throw err;
  }

  const recipients = sendMethod === 'email_all'
    ? await client.query('SELECT DISTINCT email FROM "B20Users" WHERE email IS NOT NULL AND email <> $1', [''])
    : { rows: [] };
  const recipientEmails = recipients.rows.map(row => row.email).filter(Boolean);

  const saved = await client.query(
    `
    INSERT INTO "B30Vouchers"
      (code, discount_percent, customer_type, expires_at, send_method, send_status, last_sent_at, last_sent_count, facebook_post_url)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [
      code,
      discountPercent,
      customerType,
      expiresAt.toISOString(),
      sendMethod,
      sendMethod === 'email_all' ? 'email_requested' : 'facebook_ready',
      sendMethod === 'email_all' ? new Date().toISOString() : null,
      recipientEmails.length,
      facebookPostUrl || null
    ]
  );

  const voucher = voucherRow(Object.assign({}, saved.rows[0], {
    used_count: 0,
    discount_total: 0
  }));

  return {
    voucher,
    voucherEmail: sendMethod === 'email_all'
      ? { voucher, recipients: recipientEmails }
      : null
  };
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

async function applyReviewDecision(client, payload) {
  const type = String(payload.type || '').trim().toLowerCase();
  const referenceId = String(payload.referenceId || '').trim();
  const decision = String(payload.decision || 'approve').trim().toLowerCase();
  const paymentReference = String(payload.paymentReference || '').trim();
  const note = String(payload.note || '').trim();

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
        return { updated: true, type, referenceId: row.reference_id, alreadyCompleted: true };
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

  if (type === 'subscription') {
    const subscriptionResult = await client.query(
      `
      SELECT subscription_id, user_id, plan_code, plan_name, amount, status
      FROM "B30Subscriptions"
      WHERE subscription_id = $1
      FOR UPDATE
      `,
      [Number(referenceId) || 0]
    );
    if (subscriptionResult.rowCount === 0) return { updated: false };
    const subscription = subscriptionResult.rows[0];

    if (decision === 'approve') {
      if (subscription.status === 'active') {
        return { updated: true, type, referenceId: String(subscription.subscription_id), alreadyCompleted: true };
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
  }

  return { updated: false };
}

async function listReviews(client) {
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
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  return {
    items,
    counts: {
      total: items.length,
      walletDeposits: walletRequests.rowCount,
      orders: orders.rowCount,
      subscriptions: subscriptions.rowCount
    }
  };
}

async function runAutoReviewSweep(client, settings) {
  if ((settings.reviewMode || 'manual') !== 'auto') {
    return { enabled: false, reviewed: 0, ordersForEmail: [] };
  }

  const delay = Number(settings.autoReviewDelaySeconds || 10);
  const ordersForEmail = [];
  let reviewed = 0;

  const walletRows = await client.query(
    `
    SELECT reference_id
    FROM "B30WalletTransactions"
    WHERE reference_type = 'wallet_deposit'
      AND transaction_type = 'deposit_request'
      AND status = 'pending_review'
      AND created_at <= NOW() - ($1::TEXT || ' seconds')::INTERVAL
    ORDER BY created_at ASC
    LIMIT 50
    `,
    [delay]
  );
  for (const row of walletRows.rows) {
    const result = await applyReviewDecision(client, {
      type: 'wallet_deposit',
      referenceId: row.reference_id,
      decision: 'approve',
      paymentReference: 'AUTO-REVIEW',
      note: 'Tu dong doi soat sau 10 giay'
    });
    if (result.updated && !result.alreadyCompleted) reviewed += 1;
  }

  const orderRows = await client.query(
    `
    SELECT order_code
    FROM "B30Orders"
    WHERE payment_method = 'bank_transfer'
      AND payment_status = 'pending_review'
      AND updated_at <= NOW() - ($1::TEXT || ' seconds')::INTERVAL
    ORDER BY updated_at ASC
    LIMIT 50
    `,
    [delay]
  );
  for (const row of orderRows.rows) {
    const result = await applyReviewDecision(client, {
      type: 'order',
      referenceId: row.order_code,
      decision: 'approve',
      paymentReference: 'AUTO-REVIEW',
      note: 'Tu dong doi soat sau 10 giay'
    });
    if (result.updated && !result.alreadyCompleted) {
      reviewed += 1;
      if (result.order) ordersForEmail.push(result.order);
    }
  }

  const subscriptionRows = await client.query(
    `
    SELECT subscription_id
    FROM "B30Subscriptions"
    WHERE payment_method = 'bank_transfer'
      AND status = 'pending_review'
      AND updated_at <= NOW() - ($1::TEXT || ' seconds')::INTERVAL
    ORDER BY updated_at ASC
    LIMIT 50
    `,
    [delay]
  );
  for (const row of subscriptionRows.rows) {
    const result = await applyReviewDecision(client, {
      type: 'subscription',
      referenceId: String(row.subscription_id),
      decision: 'approve',
      paymentReference: 'AUTO-REVIEW',
      note: 'Tu dong doi soat sau 10 giay'
    });
    if (result.updated && !result.alreadyCompleted) reviewed += 1;
  }

  return { enabled: true, reviewed, ordersForEmail };
}

async function buildReports(client) {
  const overview = await client.query(`
    SELECT
      COUNT(*)::INT AS total_orders,
      COUNT(*) FILTER (WHERE payment_status = 'paid')::INT AS paid_orders,
      COUNT(*) FILTER (WHERE payment_status IN ('awaiting_transfer', 'pending_review'))::INT AS pending_payment_orders,
      COUNT(*) FILTER (WHERE order_status = 'delivered')::INT AS delivered_orders,
      COUNT(*) FILTER (WHERE order_status <> 'delivered')::INT AS undelivered_orders,
      COALESCE(SUM(total_amount), 0)::NUMERIC AS gross_sales,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0)::NUMERIC AS paid_revenue
    FROM "B30Orders"
  `);

  const today = await client.query(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0)::NUMERIC AS revenue,
      COUNT(*)::INT AS orders
    FROM "B30Orders"
    WHERE created_at >= CURRENT_DATE
  `);

  const dailyRevenue = await client.query(`
    SELECT
      TO_CHAR(created_at::DATE, 'YYYY-MM-DD') AS date,
      COUNT(*)::INT AS orders,
      COALESCE(SUM(total_amount), 0)::NUMERIC AS gross,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0)::NUMERIC AS revenue
    FROM "B30Orders"
    WHERE created_at >= CURRENT_DATE - INTERVAL '13 days'
    GROUP BY created_at::DATE
    ORDER BY created_at::DATE ASC
  `);

  const paymentStats = await client.query(`
    SELECT payment_method, payment_status, COUNT(*)::INT AS count, COALESCE(SUM(total_amount), 0)::NUMERIC AS amount
    FROM "B30Orders"
    GROUP BY payment_method, payment_status
    ORDER BY payment_method, payment_status
  `);

  const planStats = await client.query(`
    SELECT
      plan_code,
      COUNT(*)::INT AS users
    FROM "B20Users"
    GROUP BY plan_code
    ORDER BY plan_code
  `);

  const subscriptionStats = await client.query(`
    SELECT
      plan_code,
      status,
      COUNT(*)::INT AS subscriptions,
      COALESCE(SUM(amount), 0)::NUMERIC AS amount
    FROM "B30Subscriptions"
    GROUP BY plan_code, status
    ORDER BY plan_code, status
  `);

  const inventory = await client.query(`
    SELECT
      product_code,
      product_name,
      50::INT AS imported_qty,
      COALESCE(SUM(quantity), 0)::INT AS exported_qty,
      GREATEST(50 - COALESCE(SUM(quantity), 0), 0)::INT AS stock_qty,
      COALESCE(SUM(line_total), 0)::NUMERIC AS sales_amount
    FROM "B30OrderItems"
    GROUP BY product_code, product_name
    ORDER BY exported_qty DESC, product_name ASC
    LIMIT 50
  `);

  const delivered = await client.query(`
    SELECT o.order_code, o.total_amount, o.payment_status, o.order_status, o.created_at, c.recipient_name
    FROM "B30Orders" o
    LEFT JOIN "B20OrderContacts" c ON c.order_id = o.order_id
    WHERE o.order_status = 'delivered'
    ORDER BY o.updated_at DESC
    LIMIT 30
  `);

  const undelivered = await client.query(`
    SELECT o.order_code, o.total_amount, o.payment_status, o.order_status, o.created_at, c.recipient_name
    FROM "B30Orders" o
    LEFT JOIN "B20OrderContacts" c ON c.order_id = o.order_id
    WHERE o.order_status <> 'delivered'
    ORDER BY o.created_at DESC
    LIMIT 30
  `);

  return {
    overview: {
      totalOrders: Number(overview.rows[0].total_orders || 0),
      paidOrders: Number(overview.rows[0].paid_orders || 0),
      pendingPaymentOrders: Number(overview.rows[0].pending_payment_orders || 0),
      deliveredOrders: Number(overview.rows[0].delivered_orders || 0),
      undeliveredOrders: Number(overview.rows[0].undelivered_orders || 0),
      grossSales: Number(overview.rows[0].gross_sales || 0),
      paidRevenue: Number(overview.rows[0].paid_revenue || 0),
      todayRevenue: Number(today.rows[0].revenue || 0),
      todayOrders: Number(today.rows[0].orders || 0)
    },
    dailyRevenue: dailyRevenue.rows.map(row => ({
      date: row.date,
      orders: Number(row.orders || 0),
      gross: Number(row.gross || 0),
      revenue: Number(row.revenue || 0)
    })),
    paymentStats: paymentStats.rows.map(row => ({
      method: row.payment_method || '',
      status: row.payment_status || '',
      count: Number(row.count || 0),
      amount: Number(row.amount || 0)
    })),
    planStats: planStats.rows.map(row => ({
      planCode: row.plan_code || 'none',
      users: Number(row.users || 0)
    })),
    subscriptionStats: subscriptionStats.rows.map(row => ({
      planCode: row.plan_code || '',
      status: row.status || '',
      subscriptions: Number(row.subscriptions || 0),
      amount: Number(row.amount || 0)
    })),
    inventory: inventory.rows.map(row => ({
      productCode: row.product_code,
      productName: row.product_name,
      importedQty: Number(row.imported_qty || 0),
      exportedQty: Number(row.exported_qty || 0),
      stockQty: Number(row.stock_qty || 0),
      salesAmount: Number(row.sales_amount || 0)
    })),
    deliveredOrders: delivered.rows.map(row => ({
      orderCode: row.order_code,
      total: Number(row.total_amount || 0),
      paymentStatus: row.payment_status || '',
      orderStatus: row.order_status || '',
      recipient: row.recipient_name || '',
      createdAt: toIso(row.created_at)
    })),
    undeliveredOrders: undelivered.rows.map(row => ({
      orderCode: row.order_code,
      total: Number(row.total_amount || 0),
      paymentStatus: row.payment_status || '',
      orderStatus: row.order_status || '',
      recipient: row.recipient_name || '',
      createdAt: toIso(row.created_at)
    }))
  };
}

async function sendPaidEmails(orders) {
  for (const order of orders || []) {
    if (!order || !order.contact || !order.contact.email) continue;
    sendOrderStatusEmail({
      to: order.contact.email,
      orderCode: order.orderCode,
      order,
      paymentStatus: 'paid',
      orderStatus: order.orderStatus,
      title: 'Thanh toan thanh cong',
      subject: `EmoBox da xac nhan thanh toan ${order.orderCode}`,
      message: 'EmoBox da doi soat va xac nhan thanh toan cho don hang cua ban.'
    }).catch(err => console.warn('[EmoBox Admin Email]', err.message));
  }
}

async function loginRoute(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Nhap email va mat khau admin.' });
  }

  const result = await withClient(async client => {
    await ensureAdminSchema(client);
    const admins = await client.query(
      `
      SELECT admin_id, full_name, email, password_hash, role, active
      FROM "B20AdminUsers"
      WHERE email = $1 AND active = TRUE
      LIMIT 1
      `,
      [email]
    );
    if (admins.rowCount === 0) return { ok: false, statusCode: 401, error: 'Tai khoan admin khong ton tai.' };

    const admin = admins.rows[0];
    if (!verifyPassword(password, admin.password_hash)) {
      return { ok: false, statusCode: 401, error: 'Mat khau admin khong dung.' };
    }

    await client.query('UPDATE "B20AdminUsers" SET last_login_at = NOW(), updated_at = NOW() WHERE admin_id = $1', [admin.admin_id]);
    return {
      ok: true,
      token: signToken(admin),
      admin: {
        adminId: admin.admin_id,
        name: admin.full_name,
        email: admin.email,
        role: admin.role
      }
    };
  });

  if (!result.ok) return res.status(result.statusCode || 500).json(result);
  return res.status(200).json(result);
}

async function protectedRoute(req, res, body, handler) {
  const result = await withClient(async client => {
    await ensureAdminSchema(client);
    const admin = await requireAdmin(req, res, body, client);
    if (!admin) return null;
    return handler(client, admin);
  });
  if (result === null) return;

  if (result.ordersForEmail) await sendPaidEmails(result.ordersForEmail);
  if (result.voucherEmail) {
    result.email = await sendVoucherEmail(result.voucherEmail).catch(err => ({
      sent: false,
      skipped: false,
      error: err.message
    }));
    delete result.voucherEmail;
  }
  return res.status(200).json({ ok: true, ...result });
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const action = resolveAction(req, body);

    if (action === 'login') return await loginRoute(req, res, body);

    if (action === 'dashboard') {
      return await protectedRoute(req, res, body, async client => {
        const settings = await getSettings(client);
        const sweep = await runAutoReviewSweep(client, settings);
        const reports = await buildReports(client);
        const reviews = await listReviews(client);
        return { settings, sweep, reports, reviews };
      });
    }

    if (action === 'reviews') {
      return await protectedRoute(req, res, body, async client => {
        const settings = await getSettings(client);
        const sweep = await runAutoReviewSweep(client, settings);
        const reviews = await listReviews(client);
        return { settings, sweep, reviews };
      });
    }

    if (action === 'decide-review') {
      return await protectedRoute(req, res, body, async client => {
        const result = await applyReviewDecision(client, body);
        if (!result.updated) {
          const err = new Error('Khong tim thay giao dich doi soat.');
          err.statusCode = 404;
          throw err;
        }
        return { result, ordersForEmail: result.order ? [result.order] : [] };
      });
    }

    if (action === 'settings') {
      return await protectedRoute(req, res, body, async client => ({ settings: await getSettings(client) }));
    }

    if (action === 'save-settings') {
      return await protectedRoute(req, res, body, async client => ({ settings: await saveSettingsValue(client, body.settings || {}) }));
    }

    if (action === 'create-admin') {
      return await protectedRoute(req, res, body, async client => {
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const fullName = String(body.fullName || body.name || 'EmoBox Admin').trim();
        const role = String(body.role || 'admin').trim() || 'admin';
        if (!email || !password || password.length < 8) {
          const err = new Error('Email admin va mat khau toi thieu 8 ky tu la bat buoc.');
          err.statusCode = 400;
          throw err;
        }
        const saved = await client.query(
          `
          INSERT INTO "B20AdminUsers" (full_name, email, password_hash, role)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (email) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role,
            active = TRUE,
            updated_at = NOW()
          RETURNING admin_id, full_name, email, role, active, created_at
          `,
          [fullName, email, hashPassword(password), role]
        );
        return { adminUser: saved.rows[0] };
      });
    }

    if (action === 'admins') {
      return await protectedRoute(req, res, body, async client => {
        const admins = await client.query(
          `
          SELECT admin_id, full_name, email, role, active, last_login_at, created_at
          FROM "B20AdminUsers"
          ORDER BY created_at DESC
          LIMIT 50
          `
        );
        return {
          admins: admins.rows.map(row => ({
            adminId: row.admin_id,
            name: row.full_name,
            email: row.email,
            role: row.role,
            active: row.active,
            lastLoginAt: toIso(row.last_login_at),
            createdAt: toIso(row.created_at)
          }))
        };
      });
    }

    if (action === 'vouchers') {
      return await protectedRoute(req, res, body, async client => ({
        vouchers: await listVouchers(client)
      }));
    }

    if (action === 'create-voucher') {
      return await protectedRoute(req, res, body, async client => {
        const result = await createVoucherRecord(client, body);
        return {
          voucher: result.voucher,
          vouchers: await listVouchers(client),
          voucherEmail: result.voucherEmail
        };
      });
    }

    if (action === 'sweep') {
      return await protectedRoute(req, res, body, async client => {
        const settings = Object.assign({}, await getSettings(client), { reviewMode: 'auto' });
        const sweep = await runAutoReviewSweep(client, settings);
        return sweep;
      });
    }

    return res.status(404).json({ ok: false, error: 'Admin API route not found', action });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
};
