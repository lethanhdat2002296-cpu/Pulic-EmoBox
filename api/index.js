const {
  getBody,
  insertWalletTransaction,
  normalizeEmail,
  orderCode,
  query,
  resolveUser,
  setCors,
  sha256,
  toNumber,
  upsertUser,
  withClient
} = require('../lib/db');
const {
  sendContactEmail,
  sendGiftScheduleEmail,
  sendGiftScheduleStatusEmail,
  sendOrderEmails,
  sendOrderStatusEmail,
  sendRegistrationEmail
} = require('../lib/email');

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return {};
  }
}

function cleanRoute(value) {
  if (!value) return '';
  let route = String(value).trim();
  if (!route) return '';

  if (/^https?:\/\//i.test(route)) {
    route = new URL(route).pathname;
  }

  route = route.split('?')[0].replace(/\\/g, '/').replace(/^\/+/, '');
  if (!route) return '';
  if (route === 'api') return '/api';
  if (!route.startsWith('api/')) route = `api/${route}`;
  return `/${route.replace(/\/+$/, '')}`;
}

function resolveRoute(req) {
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const url = new URL(req.url || '/api', 'http://localhost');
  return (
    cleanRoute(body.route || body.path || body._route) ||
    cleanRoute(url.searchParams.get('path')) ||
    cleanRoute(url.searchParams.get('route')) ||
    cleanRoute(url.pathname)
  );
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.status(405).json({ ok: false, error: 'Method not allowed' });
  return false;
}

function redact(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function emailStatus() {
  const user = process.env.EMAIL_USER || process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.EMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASS || process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || (user ? `EmoBox <${user}>` : '');
  const adminTo = process.env.EMAIL_ADMIN_TO || user;

  return {
    configured: Boolean(user && pass && from),
    hasUser: Boolean(user),
    hasPassword: Boolean(pass),
    hasFrom: Boolean(from),
    user: redact(user),
    from: from ? from.replace(/<([^>]+)>/, (_, email) => `<${redact(email)}>`): '',
    adminTo: redact(adminTo),
    provider: process.env.SMTP_HOST ? 'smtp' : 'gmail',
    host: process.env.SMTP_HOST || 'gmail',
    port: process.env.SMTP_HOST ? Number(process.env.SMTP_PORT || 587) : 465
  };
}

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
  return { month: match[1], year: match[2] };
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

const VIETNAM_TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function vietnamTodayDateString() {
  return new Date(Date.now() + VIETNAM_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function parseDateOnlyUtc(value) {
  const parts = dateOnly(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function daysFromVietnamToday(value) {
  const target = parseDateOnlyUtc(value);
  const today = parseDateOnlyUtc(vietnamTodayDateString());
  if (target === null || today === null) return 0;
  return Math.floor((target - today) / MS_PER_DAY);
}

function rowToEvent(row) {
  const payload = row.package_json && typeof row.package_json === 'object' ? row.package_json : {};
  return {
    ...payload,
    id: row.local_event_id,
    date: dateOnly(row.gift_date),
    title: payload.title || `Qua cho ${row.recipient_name || ''}`.trim(),
    recipient: payload.recipient || row.recipient_name || '',
    address: payload.address || row.shipping_address || '',
    phone: payload.phone || row.recipient_phone || '',
    email: payload.email || row.recipient_email || '',
    group: payload.group || row.group_code || '',
    cat: payload.cat || row.category_code || '',
    tier: payload.tier || row.tier_code || '',
    pkgName: payload.pkgName || row.package_name || 'Gift package',
    priceNum: Number(payload.priceNum || row.amount || 0),
    paid: Boolean(row.paid),
    status: row.status || 'pending'
  };
}

function rowToOrder(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const tracking = Array.isArray(row.tracking_events) ? row.tracking_events : [];
  return {
    orderId: row.order_id,
    orderCode: row.order_code,
    subtotal: Number(row.subtotal || 0),
    shippingFee: Number(row.shipping_fee || 0),
    discount: Number(row.discount_amount || 0),
    total: Number(row.total_amount || 0),
    voucherCode: row.voucher_code || '',
    paymentMethod: row.payment_method || '',
    paymentStatus: row.payment_status || '',
    orderStatus: row.order_status || '',
    paymentReference: row.payment_reference || '',
    paymentProofUrl: row.payment_proof_url || '',
    bankTransferNote: row.bank_transfer_note || '',
    paidAt: toIso(row.paid_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    contact: {
      name: row.recipient_name || '',
      phone: row.recipient_phone || '',
      email: row.recipient_email || '',
      address: row.shipping_address || '',
      message: row.personal_message || '',
      anonymousSender: Boolean(row.is_anonymous_sender)
    },
    items,
    tracking: tracking.map(event => ({
      trackingId: event.trackingId,
      eventType: event.eventType || '',
      orderStatus: event.orderStatus || '',
      paymentStatus: event.paymentStatus || '',
      title: event.title || '',
      message: event.message || '',
      metadata: event.metadata || {},
      createdAt: event.createdAt || ''
    }))
  };
}

async function insertOrderTrackingEvent(client, event = {}) {
  if (!event.orderId) return;
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
      event.eventType || 'status',
      event.orderStatus || null,
      event.paymentStatus || null,
      event.title || 'Cập nhật đơn hàng',
      event.message || null,
      event.metadata ? JSON.stringify(event.metadata) : null
    ]
  );
}

async function upsertSavedRecipient(client, userId, recipient = {}) {
  if (!userId) return;
  const name = String(recipient.name || recipient.recipient || recipient.fullName || '').trim();
  const phone = String(recipient.phone || '').trim();
  const email = normalizeEmail(recipient.email);
  const address = String(recipient.address || '').trim();
  if (!name || !phone || !address) return;

  await client.query(
    `
    INSERT INTO "B20SavedRecipients"
      (user_id, full_name, phone, email, address, last_used_at)
    VALUES
      ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (user_id, phone, address) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      email = COALESCE(EXCLUDED.email, "B20SavedRecipients".email),
      last_used_at = NOW(),
      updated_at = NOW()
    `,
    [userId, name, phone, email || null, address]
  );
}

async function debitWallet(client, userId, amount, fallbackBalance = 0) {
  const debitAmount = toNumber(amount, 0);
  if (!userId || debitAmount <= 0) return toNumber(fallbackBalance, 0);

  const wallet = await client.query(
    'SELECT balance FROM "B30WalletAccounts" WHERE user_id = $1 FOR UPDATE',
    [userId]
  );
  const currentBalance = wallet.rowCount > 0
    ? toNumber(wallet.rows[0].balance, 0)
    : toNumber(fallbackBalance, 0);

  if (currentBalance < debitAmount) {
    const err = new Error('So du vi EmoBox khong du.');
    err.statusCode = 400;
    throw err;
  }

  const balanceAfter = currentBalance - debitAmount;
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

async function creditWallet(client, userId, amount, fallbackBalance = 0) {
  const creditAmount = toNumber(amount, 0);
  if (!userId || creditAmount <= 0) return toNumber(fallbackBalance, 0);

  const wallet = await client.query(
    'SELECT balance FROM "B30WalletAccounts" WHERE user_id = $1 FOR UPDATE',
    [userId]
  );
  const currentBalance = wallet.rowCount > 0
    ? toNumber(wallet.rows[0].balance, 0)
    : toNumber(fallbackBalance, 0);
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

function paymentRequestCode(prefix) {
  return `${prefix}${orderCode().replace(/^EB/, '')}`;
}

function normalizeVoucherCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function voucherCustomerMatches(customerType, planCode) {
  const type = String(customerType || 'all').trim();
  const plan = String(planCode || 'none').trim() || 'none';
  if (type === 'all') return true;
  if (type === 'member') return plan !== 'none';
  return type === plan;
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

async function readUserPlan(client, userId, fallbackPlan) {
  if (!userId) return fallbackPlan || 'none';
  const result = await client.query(
    'SELECT plan_code FROM "B20Users" WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  return result.rows[0] && result.rows[0].plan_code || fallbackPlan || 'none';
}

async function validateVoucherForCheckout(client, codeValue, userPlan, subtotal) {
  const code = normalizeVoucherCode(codeValue);
  if (!code) {
    return { valid: false, error: 'Vui long nhap ma voucher.' };
  }

  const voucherResult = await client.query(
    `
    SELECT voucher_id, code, discount_percent, customer_type, expires_at, active
    FROM "B30Vouchers"
    WHERE UPPER(code) = UPPER($1)
    LIMIT 1
    `,
    [code]
  );

  if (voucherResult.rowCount === 0) {
    return { valid: false, error: 'Ma voucher khong ton tai.' };
  }

  const voucher = voucherResult.rows[0];
  if (!voucher.active) {
    return { valid: false, error: 'Ma voucher da bi khoa.' };
  }

  const expiresAt = voucher.expires_at ? new Date(voucher.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return { valid: false, error: 'Ma voucher da het han.' };
  }

  if (!voucherCustomerMatches(voucher.customer_type, userPlan)) {
    return {
      valid: false,
      error: `Voucher nay chi ap dung cho ${voucherCustomerLabel(voucher.customer_type)}.`
    };
  }

  const discountPercent = Number(voucher.discount_percent || 0);
  const discountAmount = Math.max(0, Math.floor(toNumber(subtotal, 0) * discountPercent / 100));
  return {
    valid: true,
    voucher: {
      voucherId: voucher.voucher_id,
      code: voucher.code,
      discountPercent,
      customerType: voucher.customer_type,
      expiresAt: toIso(voucher.expires_at),
      discountAmount
    }
  };
}

function monthsForPlan(planCode) {
  if (planCode === '3-months') return 3;
  if (planCode === '6-months') return 6;
  if (planCode === '12-months') return 12;
  return 0;
}

async function health(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const result = await query('SELECT 1 AS ok, current_database() AS database_name');
    return res.status(200).json({ ok: true, databaseName: result.rows[0].database_name });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
}

async function upsertUserRoute(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const userEmail = normalizeEmail(body.user && body.user.email);
      const existing = userEmail
        ? await client.query('SELECT user_id FROM "B20Users" WHERE email = $1', [userEmail])
        : { rowCount: 0 };
      const savedUser = await upsertUser(client, body.user);
      return { ...savedUser, created: existing.rowCount === 0 };
    });

    return res.status(200).json({ ok: true, userId: result.userId, email: result.email, created: result.created });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function loginUser(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

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
}

async function saveGiftSchedule(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const eventData = body.event || {};
    const localEventId = eventData.id;
    const amount = toNumber(eventData.priceNum || eventData.amount, 0);
    const paid = Boolean(eventData.paid);
    const paymentMethod = body.paymentMethod || 'bank';

    if (daysFromVietnamToday(eventData.date || new Date().toISOString().slice(0, 10)) < 0) {
      return res.status(400).json({
        ok: false,
        error: 'Khong the dat lich cho ngay da qua.'
      });
    }

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
      await upsertSavedRecipient(client, user.userId, {
        name: eventData.recipient || 'Nguoi nhan',
        phone: eventData.phone || '',
        email: eventData.email || '',
        address: eventData.address || ''
      });

      const existingSchedule = await client.query(
        `
        SELECT schedule_id, paid
        FROM "B30GiftSchedules"
        WHERE user_id = $1
          AND local_event_id = $2
          AND deleted_at IS NULL
        `,
        [user.userId, localEventId]
      );
      const wasPaid = existingSchedule.rowCount > 0 && Boolean(existingSchedule.rows[0].paid);

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

      let balanceAfter = null;
      if (paid && !wasPaid && paymentMethod === 'wallet') {
        balanceAfter = await debitWallet(client, user.userId, amount, body.user && body.user.balance);
        await insertWalletTransaction(client, {
          userId: user.userId,
          type: 'gift_schedule_payment',
          amount: -amount,
          balanceAfter,
          paymentMethod,
          referenceType: 'gift_schedule',
          referenceId: localEventId,
          description: eventData.pkgName || 'Thanh toan lich tang qua',
          metadata: eventData
        });
      }

      return { userId: user.userId, localEventId, created: existingSchedule.rowCount === 0, balanceAfter };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
}

async function listGiftSchedules(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const user = await resolveUser(client, body.user);
      if (!user.userId) return { userId: null, events: [] };

      const schedules = await client.query(
        `
        SELECT
          s.local_event_id,
          s.gift_date,
          s.group_code,
          s.category_code,
          s.tier_code,
          s.package_name,
          s.amount,
          s.paid,
          s.status,
          s.package_json,
          r.full_name AS recipient_name,
          r.phone AS recipient_phone,
          r.email AS recipient_email,
          r.address AS shipping_address
        FROM "B30GiftSchedules" s
        LEFT JOIN "B20GiftRecipients" r ON r.recipient_id = s.recipient_id
        WHERE s.user_id = $1
          AND s.deleted_at IS NULL
        ORDER BY s.gift_date ASC, s.created_at ASC
        `,
        [user.userId]
      );

      return { userId: user.userId, events: schedules.rows.map(rowToEvent) };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function deleteGiftSchedule(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const user = await resolveUser(client, body.user);
      const localEventId = body.localEventId || null;
      if (!user.userId || !localEventId) {
        return { userId: user.userId, localEventId, deleted: false, refundedAmount: 0 };
      }

      const scheduleResult = await client.query(
        `
        SELECT
          s.schedule_id,
          s.local_event_id,
          s.gift_date,
          s.amount,
          s.paid,
          s.package_name,
          s.package_json,
          s.order_id,
          o.order_code,
          o.payment_method AS order_payment_method,
          r.full_name AS recipient_name,
          r.phone AS recipient_phone,
          r.email AS recipient_email,
          r.address AS shipping_address
        FROM "B30GiftSchedules" s
        LEFT JOIN "B30Orders" o ON o.order_id = s.order_id
        LEFT JOIN "B20GiftRecipients" r ON r.recipient_id = s.recipient_id
        WHERE s.user_id = $1
          AND s.local_event_id = $2
          AND s.deleted_at IS NULL
        LIMIT 1
        FOR UPDATE OF s
        `,
        [user.userId, localEventId]
      );

      if (scheduleResult.rowCount === 0) {
        return { userId: user.userId, localEventId, deleted: false, refundedAmount: 0 };
      }

      const schedule = scheduleResult.rows[0];
      if (daysFromVietnamToday(schedule.gift_date) < 5) {
        return {
          userId: user.userId,
          localEventId,
          deleted: false,
          blocked: true,
          error: 'Chi co the huy lich truoc ngay giao toi thieu 5 ngay.'
        };
      }

      let refundedAmount = 0;
      let balanceAfter = null;
      const amount = Math.abs(toNumber(schedule.amount, 0));
      const isPaidByWallet = Boolean(schedule.paid) && (
        schedule.order_payment_method === 'wallet' ||
        (await client.query(
          `
          SELECT transaction_id
          FROM "B30WalletTransactions"
          WHERE user_id = $1
            AND transaction_type = 'gift_schedule_payment'
            AND reference_type = 'gift_schedule'
            AND reference_id = $2
          LIMIT 1
          `,
          [user.userId, localEventId]
        )).rowCount > 0
      );

      if (isPaidByWallet && amount > 0) {
        const existingRefund = await client.query(
          `
          SELECT transaction_id
          FROM "B30WalletTransactions"
          WHERE user_id = $1
            AND transaction_type = 'gift_schedule_refund'
            AND reference_type = 'gift_schedule'
            AND reference_id = $2
          LIMIT 1
          `,
          [user.userId, localEventId]
        );

        if (existingRefund.rowCount === 0) {
          const wallet = await client.query(
            'SELECT balance FROM "B30WalletAccounts" WHERE user_id = $1 FOR UPDATE',
            [user.userId]
          );
          const currentBalance = toNumber(wallet.rows[0] && wallet.rows[0].balance, 0);
          refundedAmount = amount;
          balanceAfter = currentBalance + refundedAmount;

          await client.query(
            `
            INSERT INTO "B30WalletAccounts" (user_id, balance)
            VALUES ($1, $2)
            ON CONFLICT (user_id) DO UPDATE SET
              balance = EXCLUDED.balance,
              updated_at = NOW()
            `,
            [user.userId, balanceAfter]
          );

          await insertWalletTransaction(client, {
            userId: user.userId,
            type: 'gift_schedule_refund',
            amount: refundedAmount,
            balanceAfter,
            paymentMethod: 'wallet',
            referenceType: 'gift_schedule',
            referenceId: localEventId,
            description: schedule.package_name ? `Hoan tien huy ${schedule.package_name}` : 'Hoan tien huy lich tang qua',
            metadata: {
              localEventId,
              scheduleId: schedule.schedule_id,
              orderId: schedule.order_id || null,
              orderCode: schedule.order_code || null
            }
          });
        }
      }

      await client.query(
        `
        UPDATE "B30GiftSchedules"
        SET deleted_at = NOW(),
            updated_at = NOW(),
            status = 'deleted'
        WHERE user_id = $1 AND local_event_id = $2
        `,
        [user.userId, localEventId]
      );

      return {
        userId: user.userId,
        localEventId,
        deleted: true,
        refundedAmount,
        balanceAfter,
        event: rowToEvent(schedule)
      };
    });

    if (result.deleted && result.event) {
      sendGiftScheduleStatusEmail({
        user: body.user || {},
        event: result.event,
        localEventId: result.localEventId,
        refundedAmount: result.refundedAmount,
        title: 'Hủy lịch tặng quà thành công',
        message: result.refundedAmount
          ? 'Lịch tặng quà đã được hủy và số tiền đã được hoàn vào ví EmoBox.'
          : 'Lịch tặng quà đã được hủy thành công.',
        note: 'Quy tắc hủy: lịch chỉ được hủy trước ngày giao tối thiểu 5 ngày.'
      }).catch(err => console.warn('[EmoBox Email] Khong gui duoc email huy lich:', err.message));
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function walletDeposit(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const amount = Math.abs(toNumber(body.amount, 0));
    if (amount <= 0) {
      return res.status(400).json({ ok: false, error: 'So tien nap khong hop le.' });
    }

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const wallet = await client.query(
        'SELECT balance FROM "B30WalletAccounts" WHERE user_id = $1 LIMIT 1',
        [user.userId]
      );
      const currentBalance = Number(wallet.rows[0] && wallet.rows[0].balance || 0);
      const bankInfo = body.bankInfo || {};
      const requestCode = paymentRequestCode('WAL');
      const paymentReference = String(body.paymentReference || bankInfo.paymentReference || '').trim();
      const proofUrl = String(body.paymentProofUrl || bankInfo.paymentProofUrl || '').trim();

      await insertWalletTransaction(client, {
        userId: user.userId,
        type: 'deposit_request',
        amount,
        balanceAfter: currentBalance,
        paymentMethod: body.paymentMethod || 'bank',
        referenceType: 'wallet_deposit',
        referenceId: requestCode,
        status: 'pending_review',
        externalReference: paymentReference,
        proofUrl,
        description: 'Yeu cau nap tien vi EmoBox',
        metadata: Object.assign({}, bankInfo, {
          requestCode,
          paymentReference,
          bankTransferNote: body.bankTransferNote || bankInfo.bankTransferNote || ''
        })
      });

      return { userId: user.userId, requestCode, status: 'pending_review', balanceAfter: currentBalance };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function walletWithdraw(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const amount = -Math.abs(toNumber(body.amount, 0));
    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const balanceAfter = toNumber(body.user && body.user.balance, 0);

      await insertWalletTransaction(client, {
        userId: user.userId,
        type: 'withdraw',
        amount,
        balanceAfter,
        paymentMethod: body.paymentMethod || 'bank_transfer',
        referenceType: 'wallet',
        description: 'Rut tien vi EmoBox',
        metadata: body.bankInfo || {}
      });

      return { userId: user.userId, balanceAfter };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function walletHistory(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const user = await resolveUser(client, body.user);
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
          status,
          external_reference,
          proof_url,
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
          status: row.status || 'completed',
          externalReference: row.external_reference || '',
          proofUrl: row.proof_url || '',
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
}

async function getBankCard(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

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
      const maskedNumber = `**** **** **** ${row.card_last4}`;
      return {
        userId: user.userId,
        card: {
          holderName: row.cardholder_name,
          cardNumber: maskedNumber,
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
}

async function saveBankCard(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

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
        [user.userId, holderName, `**** **** **** ${cardNumber.slice(-4)}`, cardNumber.slice(-4), expiry.month, expiry.year, brandFromNumber(cardNumber)]
      );

      const maskedNumber = `**** **** **** ${cardNumber.slice(-4)}`;
      return {
        userId: user.userId,
        card: {
          holderName,
          cardNumber: maskedNumber,
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
}

async function activateSubscription(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const planCode = body.planCode || '';
    const plan = body.plan || {};
    const amount = toNumber(plan.price, 0);
    const months = monthsForPlan(planCode);
    const paymentMethod = body.paymentMethod || 'bank_transfer';
    const paymentReference = String(body.paymentReference || '').trim();
    const paymentProofUrl = String(body.paymentProofUrl || '').trim();
    const bankTransferNote = String(body.bankTransferNote || '').trim();
    if (!planCode || amount <= 0 || months <= 0) {
      return res.status(400).json({ ok: false, error: 'Goi thanh vien khong hop le.' });
    }

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const startAt = new Date();
      const endAt = months > 0 ? new Date(startAt) : null;
      if (endAt) endAt.setMonth(endAt.getMonth() + months);

      await client.query(
        `
        UPDATE "B20Users"
        SET pending_plan_code = $1,
            updated_at = NOW()
        WHERE user_id = $2
        `,
        [planCode, user.userId]
      );

      const subscription = await client.query(
        `
        INSERT INTO "B30Subscriptions"
          (user_id, plan_code, plan_name, amount, payment_method, status, payment_reference, payment_proof_url, bank_transfer_note, start_at, end_at)
        VALUES
          ($1, $2, $3, $4, $5, 'pending_review', $6, $7, $8, $9, $10)
        RETURNING subscription_id, status
        `,
        [
          user.userId,
          planCode,
          plan.name || planCode,
          amount,
          paymentMethod,
          paymentReference || null,
          paymentProofUrl || null,
          bankTransferNote || null,
          startAt.toISOString(),
          endAt ? endAt.toISOString() : null
        ]
      );

      return {
        userId: user.userId,
        planCode,
        subscriptionId: subscription.rows[0].subscription_id,
        status: subscription.rows[0].status,
        activated: false
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function validateVoucher(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const subtotal = toNumber(body.subtotal || body.orderSubtotal, 0);
    const result = await withClient(async client => {
      const user = await resolveUser(client, body.user || {});
      const userPlan = await readUserPlan(client, user.userId, body.user && body.user.plan || 'none');
      const validation = await validateVoucherForCheckout(client, body.code || body.voucherCode, userPlan, subtotal);
      return Object.assign({ userId: user.userId || null, customerPlan: userPlan }, validation);
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, valid: false, error: err.message });
  }
}

async function saveOrder(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const order = body.order || {};
    const items = Array.isArray(order.items) ? order.items : [];
    const subtotal = toNumber(order.subtotal, 0);
    const shippingFee = toNumber(order.shippingFee, 0);
    const paymentMethod = order.paymentMethod || 'card';
    const paymentReference = order.paymentReference || order.transferCode || '';
    const paymentProofUrl = order.paymentProofUrl || order.paymentProofName || '';
    const bankTransferNote = order.bankTransferNote || order.transferNote || '';
    const voucherCode = normalizeVoucherCode(order.voucherCode || order.voucher && order.voucher.code);
    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const code = orderCode();
      const userPlan = await readUserPlan(client, user.userId, body.user && body.user.plan || 'none');
      let voucher = null;
      let discountAmount = 0;

      if (voucherCode) {
        const voucherValidation = await validateVoucherForCheckout(client, voucherCode, userPlan, subtotal);
        if (!voucherValidation.valid) {
          const err = new Error(voucherValidation.error || 'Ma voucher khong hop le.');
          err.statusCode = 400;
          throw err;
        }
        voucher = voucherValidation.voucher;
        discountAmount = toNumber(voucher.discountAmount, 0);
      }

      const total = Math.max(0, subtotal + shippingFee - discountAmount);
      const paymentStatus = total <= 0 || paymentMethod === 'wallet'
        ? 'paid'
        : paymentMethod === 'bank_transfer'
          ? (paymentReference || paymentProofUrl ? 'pending_review' : 'awaiting_transfer')
          : 'pending';

      const orderResult = await client.query(
        `
        INSERT INTO "B30Orders"
          (user_id, order_code, subtotal, shipping_fee, discount_amount, total_amount, voucher_id, voucher_code, payment_method, payment_status, order_status, payment_reference, payment_proof_url, bank_transfer_note, paid_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'processing', $11, $12, $13, CASE WHEN $10 = 'paid' THEN NOW() ELSE NULL END)
        RETURNING order_id, order_code, payment_status
        `,
        [
          user.userId,
          code,
          subtotal,
          shippingFee,
          discountAmount,
          total,
          voucher && voucher.voucherId || null,
          voucher && voucher.code || null,
          paymentMethod,
          paymentStatus,
          paymentReference || null,
          paymentProofUrl || null,
          bankTransferNote || null
        ]
      );

      const savedOrder = orderResult.rows[0];
      await insertOrderTrackingEvent(client, {
        orderId: savedOrder.order_id,
        userId: user.userId,
        eventType: 'created',
        orderStatus: 'processing',
        paymentStatus,
        title: 'Đã tạo đơn hàng',
        message: paymentStatus === 'paid'
          ? 'Đơn hàng đã được ghi nhận và thanh toán thành công.'
          : 'Đơn hàng đã được ghi nhận và đang chờ thanh toán/đối soát.',
        metadata: {
          orderCode: savedOrder.order_code,
          paymentMethod,
          total
        }
      });

      if (voucher && discountAmount > 0) {
        await client.query(
          `
          INSERT INTO "B30VoucherRedemptions"
            (voucher_id, user_id, order_id, voucher_code, discount_percent, discount_amount, order_amount)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (voucher_id, order_id) DO NOTHING
          `,
          [
            voucher.voucherId,
            user.userId,
            savedOrder.order_id,
            voucher.code,
            voucher.discountPercent,
            discountAmount,
            total
          ]
        );
      }

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
      await upsertSavedRecipient(client, user.userId, contact);

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

      let balanceAfter = null;
      if (paymentMethod === 'wallet' && user.userId) {
        balanceAfter = await debitWallet(client, user.userId, total, body.user && body.user.balance);
        await insertWalletTransaction(client, {
          userId: user.userId,
          type: 'order_payment',
          amount: -total,
          balanceAfter,
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
        balanceAfter,
        order: { subtotal, shippingFee, discount: discountAmount, total, paymentMethod, paymentStatus, paymentReference, paymentProofUrl, bankTransferNote, voucher },
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
      balanceAfter: result.balanceAfter,
      discount: result.order.discount,
      voucher: result.order.voucher,
      email
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
}

async function saveContactMessage(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const message = body.message || {};
    const name = String(message.name || '').trim();
    const email = normalizeEmail(message.email);
    const subject = String(message.subject || 'Lien he website').trim();
    const content = String(message.message || '').trim();

    if (!name || !email || !content) {
      return res.status(400).json({ ok: false, error: 'Vui long nhap day du thong tin lien he.' });
    }

    const result = await withClient(async client => {
      const saved = await client.query(
        `
        INSERT INTO "B20ContactMessages" (full_name, email, subject, message)
        VALUES ($1, $2, $3, $4)
        RETURNING message_id, created_at
        `,
        [name, email, subject, content]
      );
      return { messageId: saved.rows[0].message_id, createdAt: toIso(saved.rows[0].created_at) };
    });

    let emailResult = { sent: false, skipped: true };
    try {
      emailResult = await sendContactEmail({ name, email, subject, message: content });
    } catch (err) {
      emailResult = { sent: false, skipped: false, error: err.message };
    }

    return res.status(200).json({ ok: true, ...result, email: emailResult });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function listRecipients(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const user = await resolveUser(client, body.user);
      if (!user.userId) return { userId: null, recipients: [] };

      const recipients = await client.query(
        `
        SELECT recipient_id, full_name, phone, email, address, last_used_at
        FROM "B20SavedRecipients"
        WHERE user_id = $1
        ORDER BY last_used_at DESC
        LIMIT 30
        `,
        [user.userId]
      );

      return {
        userId: user.userId,
        recipients: recipients.rows.map(row => ({
          recipientId: row.recipient_id,
          name: row.full_name,
          phone: row.phone,
          email: row.email || '',
          address: row.address,
          lastUsedAt: toIso(row.last_used_at)
        }))
      };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function queryOrders(client, whereSql, params) {
  const orders = await client.query(
    `
    SELECT
      o.order_id,
      o.order_code,
      o.subtotal,
      o.shipping_fee,
      o.discount_amount,
      o.total_amount,
      o.voucher_code,
      o.payment_method,
      o.payment_status,
      o.order_status,
      o.payment_reference,
      o.payment_proof_url,
      o.bank_transfer_note,
      o.paid_at,
      o.created_at,
      o.updated_at,
      c.recipient_name,
      c.recipient_phone,
      c.recipient_email,
      c.shipping_address,
      c.personal_message,
      c.is_anonymous_sender,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', oi.product_code,
          'name', oi.product_name,
          'image', oi.image_path,
          'unitPrice', oi.unit_price,
          'quantity', oi.quantity,
          'lineTotal', oi.line_total,
          'isScheduledGift', oi.is_scheduled_gift,
          'package', oi.package_json
        ) ORDER BY oi.order_item_id ASC)
        FROM "B30OrderItems" oi
        WHERE oi.order_id = o.order_id
      ), '[]'::json) AS items,
      COALESCE((
        SELECT json_agg(json_build_object(
          'trackingId', te.tracking_id,
          'eventType', te.event_type,
          'orderStatus', te.order_status,
          'paymentStatus', te.payment_status,
          'title', te.title,
          'message', te.message,
          'metadata', te.metadata,
          'createdAt', te.created_at
        ) ORDER BY te.created_at ASC, te.tracking_id ASC)
        FROM "B30OrderTrackingEvents" te
        WHERE te.order_id = o.order_id
      ), '[]'::json) AS tracking_events
    FROM "B30Orders" o
    LEFT JOIN "B20OrderContacts" c ON c.order_id = o.order_id
    ${whereSql}
    ORDER BY o.created_at DESC
    LIMIT 100
    `,
    params
  );
  return orders.rows.map(rowToOrder);
}

async function listOrders(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const result = await withClient(async client => {
      const user = await resolveUser(client, body.user);
      if (!user.userId) return { userId: null, orders: [] };
      const orders = await queryOrders(client, 'WHERE o.user_id = $1', [user.userId]);
      return { userId: user.userId, orders };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function trackOrder(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const orderCodeInput = String(body.orderCode || '').trim();
    const email = normalizeEmail(body.email);
    const phone = String(body.phone || '').replace(/\s/g, '');
    if (!orderCodeInput) {
      return res.status(400).json({ ok: false, error: 'Nhap ma don hang.' });
    }

    const result = await withClient(async client => {
      const params = [orderCodeInput.toUpperCase()];
      const user = await resolveUser(client, body.user);
      let ownerFilter = '';
      if (user.userId) {
        params.push(user.userId);
        ownerFilter = `AND o.user_id = $${params.length}`;
      } else if (email) {
        params.push(email);
        ownerFilter = `AND LOWER(c.recipient_email) = $${params.length}`;
      } else if (phone) {
        params.push(phone);
        ownerFilter = `AND REPLACE(c.recipient_phone, ' ', '') = $${params.length}`;
      } else {
        return { order: null, missingIdentity: true };
      }
      const orders = await queryOrders(
        client,
        `WHERE UPPER(o.order_code) = $1 ${ownerFilter}`,
        params
      );
      return { order: orders[0] || null };
    });

    if (result.missingIdentity) {
      return res.status(400).json({ ok: false, error: 'Nhap email, so dien thoai hoac dang nhap de theo doi don hang.' });
    }

    if (!result.order) {
      return res.status(404).json({ ok: false, error: 'Khong tim thay don hang phu hop.' });
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function confirmBankTransfer(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const orderCodeInput = String(body.orderCode || '').trim().toUpperCase();
    const paymentReference = String(body.paymentReference || '').trim();
    const paymentProofUrl = String(body.paymentProofUrl || body.paymentProofName || '').trim();
    const bankTransferNote = String(body.bankTransferNote || '').trim();
    if (!orderCodeInput || (!paymentReference && !paymentProofUrl)) {
      return res.status(400).json({ ok: false, error: 'Nhap ma don hang va thong tin chuyen khoan.' });
    }

    const result = await withClient(async client => {
      const updated = await client.query(
        `
        UPDATE "B30Orders"
        SET payment_reference = COALESCE(NULLIF($2, ''), payment_reference),
            payment_proof_url = COALESCE(NULLIF($3, ''), payment_proof_url),
            bank_transfer_note = COALESCE(NULLIF($4, ''), bank_transfer_note),
            payment_status = CASE WHEN payment_status = 'paid' THEN payment_status ELSE 'pending_review' END,
            updated_at = NOW()
        WHERE UPPER(order_code) = $1
        RETURNING order_id, user_id, order_code, payment_status, order_status
        `,
        [orderCodeInput, paymentReference, paymentProofUrl, bankTransferNote]
      );
      if (updated.rowCount === 0) return { updated: false };
      const order = updated.rows[0];
      await insertOrderTrackingEvent(client, {
        orderId: order.order_id,
        userId: order.user_id,
        eventType: 'bank_transfer_submitted',
        orderStatus: order.order_status,
        paymentStatus: order.payment_status,
        title: 'Đã nhận thông tin chuyển khoản',
        message: 'EmoBox đã nhận mã giao dịch/biên lai và đang đối soát thanh toán.',
        metadata: {
          paymentReference,
          hasPaymentProof: Boolean(paymentProofUrl),
          bankTransferNote
        }
      });
      return { updated: true, orderCode: order.order_code, paymentStatus: order.payment_status };
    });

    if (!result.updated) {
      return res.status(404).json({ ok: false, error: 'Khong tim thay don hang.' });
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function paymentWebhook(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const expectedSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    const authSecret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const suppliedSecret = body.secret || req.headers['x-payment-secret'] || authSecret;
    if (!expectedSecret) {
      return res.status(503).json({ ok: false, error: 'PAYMENT_WEBHOOK_SECRET is not configured' });
    }
    if (suppliedSecret !== expectedSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized webhook' });
    }

    const referenceType = String(body.referenceType || body.type || 'order').trim().toLowerCase();
    const referenceId = String(body.referenceId || body.requestCode || body.subscriptionId || body.orderCode || body.reference || '').trim();
    const providerEventId = String(body.eventId || body.providerEventId || '').trim();
    const status = String(body.status || 'paid').trim().toLowerCase();
    if (!referenceId && referenceType !== 'order') {
      return res.status(400).json({ ok: false, error: 'Missing payment reference' });
    }

    const result = await withClient(async client => {
      if (providerEventId) {
        const eventInsert = await client.query(
          `
          INSERT INTO "B30PaymentWebhookEvents"
            (provider_event_id, reference_type, reference_id, payment_status, payload)
          VALUES
            ($1, $2, $3, $4, $5)
          ON CONFLICT (provider_event_id) DO NOTHING
          RETURNING event_id
          `,
          [providerEventId, referenceType, referenceId || null, status, JSON.stringify(body)]
        );
        if (eventInsert.rowCount === 0) {
          return { updated: true, duplicate: true, referenceType, referenceId };
        }
      }

      if (referenceType === 'wallet_deposit') {
        const tx = await client.query(
          `
          SELECT transaction_id, user_id, amount, status
          FROM "B30WalletTransactions"
          WHERE reference_type = 'wallet_deposit'
            AND reference_id = $1
          FOR UPDATE
          `,
          [referenceId]
        );
        if (tx.rowCount === 0) return { updated: false };

        const row = tx.rows[0];
        if (row.status === 'completed' && status === 'paid') {
          return { updated: true, referenceType, referenceId, alreadyCompleted: true };
        }

        let balanceAfter = null;
        if (status === 'paid') {
          balanceAfter = await creditWallet(client, row.user_id, row.amount);
        }

        await client.query(
          `
          UPDATE "B30WalletTransactions"
          SET status = $2,
              balance_after = COALESCE($3, balance_after),
              external_reference = COALESCE(NULLIF($4, ''), external_reference),
              updated_at = NOW()
          WHERE transaction_id = $1
          `,
          [row.transaction_id, status === 'paid' ? 'completed' : status, balanceAfter, body.transactionId || body.paymentReference || '']
        );

        return { updated: true, referenceType, referenceId, balanceAfter };
      }

      if (referenceType === 'subscription') {
        const subscriptionId = Number(referenceId);
        if (!subscriptionId) return { updated: false };

        const subResult = await client.query(
          `
          SELECT subscription_id, user_id, plan_code, plan_name, amount, status, paid_at, end_at
          FROM "B30Subscriptions"
          WHERE subscription_id = $1
          FOR UPDATE
          `,
          [subscriptionId]
        );
        if (subResult.rowCount === 0) return { updated: false };
        const subscription = subResult.rows[0];

        if (subscription.status === 'active' && subscription.paid_at && status === 'paid') {
          return { updated: true, referenceType, referenceId, alreadyCompleted: true };
        }

        await client.query(
          `
          UPDATE "B30Subscriptions"
          SET status = $2,
              payment_reference = COALESCE(NULLIF($3, ''), payment_reference),
              paid_at = CASE WHEN $2 = 'active' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
              updated_at = NOW()
          WHERE subscription_id = $1
          `,
          [
            subscriptionId,
            status === 'paid' ? 'active' : status,
            body.transactionId || body.paymentReference || ''
          ]
        );

        let balanceAfter = null;
        if (status === 'paid') {
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
          balanceAfter = await creditWallet(client, subscription.user_id, subscription.amount);
          await insertWalletTransaction(client, {
            userId: subscription.user_id,
            type: 'subscription_credit',
            amount: subscription.amount,
            balanceAfter,
            paymentMethod: 'bank_transfer',
            referenceType: 'subscription',
            referenceId: String(subscriptionId),
            status: 'completed',
            externalReference: body.transactionId || body.paymentReference || '',
            description: subscription.plan_name || subscription.plan_code,
            metadata: { subscriptionId, planCode: subscription.plan_code }
          });
        }

        return { updated: true, referenceType, referenceId, balanceAfter };
      }

      const orderCodeInput = String(body.orderCode || body.reference || referenceId || '').trim().toUpperCase();
      if (!orderCodeInput) {
        return { updated: false, missingOrderCode: true };
      }

      const updated = await client.query(
        `
        UPDATE "B30Orders"
        SET payment_status = $2,
            payment_reference = COALESCE(NULLIF($3, ''), payment_reference),
            paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            updated_at = NOW()
        WHERE UPPER(order_code) = $1
        RETURNING order_id, user_id, order_code, payment_status, order_status, total_amount
        `,
        [orderCodeInput, status, body.transactionId || body.paymentReference || '']
      );

      if (updated.rowCount === 0) return { updated: false };

      const order = updated.rows[0];
      await insertOrderTrackingEvent(client, {
        orderId: order.order_id,
        userId: order.user_id,
        eventType: status === 'paid' ? 'payment_paid' : 'payment_status_updated',
        orderStatus: order.order_status,
        paymentStatus: order.payment_status,
        title: status === 'paid' ? 'Đã xác nhận thanh toán' : 'Đã cập nhật trạng thái thanh toán',
        message: status === 'paid'
          ? 'Thanh toán đã được xác nhận, EmoBox tiếp tục xử lý đơn hàng.'
          : `Trạng thái thanh toán đã được cập nhật thành ${status}.`,
        metadata: {
          transactionId: body.transactionId || body.paymentReference || '',
          webhookStatus: status
        }
      });

      await client.query(
        `
        UPDATE "B30GiftSchedules"
        SET paid = TRUE,
            status = 'paid',
            updated_at = NOW()
        WHERE order_id = $1 AND $2 = 'paid'
        `,
        [order.order_id, status]
      );

      const orders = await queryOrders(client, 'WHERE o.order_id = $1', [order.order_id]);
      return { updated: true, referenceType: 'order', referenceId: order.order_code, order: orders[0] || null };
    });

    if (result.missingOrderCode) {
      return res.status(400).json({ ok: false, error: 'Missing orderCode' });
    }

    if (!result.updated) {
      return res.status(404).json({ ok: false, error: 'Khong tim thay giao dich.' });
    }

    if (result.order && status === 'paid') {
      sendOrderStatusEmail({
        to: result.order.contact.email,
        orderCode: result.order.orderCode,
        order: result.order,
        paymentStatus: 'paid',
        orderStatus: result.order.orderStatus,
        title: 'Thanh toán thành công',
        subject: `EmoBox đã xác nhận thanh toán ${result.order.orderCode}`,
        message: 'EmoBox đã xác nhận thanh toán cho đơn hàng của bạn.'
      }).catch(err => console.warn('[EmoBox Email] Khong gui duoc email paid:', err.message));
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function upcomingOrderReminders(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.method === 'POST' ? getBody(req) : {};
    const url = new URL(req.url, 'http://localhost');
    const authSecret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const suppliedSecret = body.secret || url.searchParams.get('secret') || req.headers['x-cron-secret'] || authSecret;
    const expectedSecret = process.env.ORDER_REMINDER_SECRET || process.env.CRON_SECRET;
    if (expectedSecret && suppliedSecret !== expectedSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized reminder job' });
    }

    const schedules = await query(
      `
      SELECT
        s.local_event_id,
        s.gift_date,
        s.package_name,
        s.amount,
        s.package_json,
        r.full_name AS recipient_name,
        r.phone AS recipient_phone,
        r.email AS recipient_email,
        r.address AS shipping_address,
        u.email AS user_email
      FROM "B30GiftSchedules" s
      LEFT JOIN "B20GiftRecipients" r ON r.recipient_id = s.recipient_id
      LEFT JOIN "B20Users" u ON u.user_id = s.user_id
      WHERE s.deleted_at IS NULL
        AND s.paid = TRUE
        AND s.gift_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '2 days'
      ORDER BY s.gift_date ASC
      LIMIT 50
      `
    );

    const results = [];
    for (const row of schedules.rows) {
      const event = rowToEvent(row);
      const to = event.email || row.user_email;
      try {
        const email = await sendGiftScheduleStatusEmail({
          to,
          event,
          localEventId: event.id,
          title: 'Đơn quà sắp được giao',
          subject: `EmoBox nhắc lịch giao quà ${event.id}`,
          message: 'Lịch tặng quà của bạn sắp đến ngày giao. EmoBox đang chuẩn bị đơn quà thật chỉn chu.',
          note: 'Nếu cần thay đổi thông tin, vui lòng liên hệ EmoBox sớm nhất.'
        });
        results.push({ localEventId: event.id, email });
      } catch (err) {
        results.push({ localEventId: event.id, error: err.message });
      }
    }

    return res.status(200).json({ ok: true, count: results.length, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function registrationEmail(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const email = await sendRegistrationEmail({ user: body.user || {} });
    return res.status(200).json({ ok: true, email });
  } catch (err) {
    return res.status(200).json({ ok: true, email: { sent: false, skipped: false, error: err.message } });
  }
}

async function giftScheduleEmail(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const email = await sendGiftScheduleEmail({
      user: body.user || {},
      event: body.event || {},
      paymentMethod: body.paymentMethod || 'bank'
    });
    return res.status(200).json({ ok: true, email });
  } catch (err) {
    return res.status(200).json({ ok: true, email: { sent: false, skipped: false, error: err.message } });
  }
}

function emailStatusRoute(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  return res.status(200).json({ ok: true, email: emailStatus() });
}

function getPaymentReviewSecret(req, body) {
  const authSecret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return body.secret || req.headers['x-payment-secret'] || authSecret;
}

function requirePaymentReviewAccess(req, res, body) {
  const expectedSecret = process.env.PAYMENT_REVIEW_SECRET || process.env.PAYMENT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    res.status(503).json({ ok: false, error: 'PAYMENT_REVIEW_SECRET or PAYMENT_WEBHOOK_SECRET is not configured' });
    return false;
  }

  if (getPaymentReviewSecret(req, body) !== expectedSecret) {
    res.status(401).json({ ok: false, error: 'Unauthorized payment review' });
    return false;
  }

  return true;
}

function reviewDate(value) {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

async function listPaymentReviews(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    if (!requirePaymentReviewAccess(req, res, body)) return;

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
      ].sort((a, b) => reviewDate(b.createdAt) - reviewDate(a.createdAt));

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
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function decidePaymentReview(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    if (!requirePaymentReviewAccess(req, res, body)) return;

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

        const orders = await queryOrders(client, 'WHERE o.order_id = $1', [order.order_id]);
        return { updated: true, type, referenceId: order.order_code, status: nextStatus, order: orders[0] || null };
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

    if (result.order) {
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
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

const routes = {
  '/api/health': health,
  '/api/contact': saveContactMessage,
  '/api/orders': saveOrder,
  '/api/orders/confirm-bank-transfer': confirmBankTransfer,
  '/api/orders/history': listOrders,
  '/api/orders/reminders/upcoming': upcomingOrderReminders,
  '/api/orders/track': trackOrder,
  '/api/bank-card/get': getBankCard,
  '/api/bank-card/save': saveBankCard,
  '/api/email/gift-schedule': giftScheduleEmail,
  '/api/email/registration': registrationEmail,
  '/api/email/status': emailStatusRoute,
  '/api/gift-schedules': saveGiftSchedule,
  '/api/gift-schedules/delete': deleteGiftSchedule,
  '/api/gift-schedules/list': listGiftSchedules,
  '/api/payments/review/decide': decidePaymentReview,
  '/api/payments/review/list': listPaymentReviews,
  '/api/payments/webhook': paymentWebhook,
  '/api/recipients/list': listRecipients,
  '/api/subscriptions/activate': activateSubscription,
  '/api/users/login': loginUser,
  '/api/users/upsert': upsertUserRoute,
  '/api/vouchers/validate': validateVoucher,
  '/api/wallet/deposit': walletDeposit,
  '/api/wallet/history': walletHistory,
  '/api/wallet/withdraw': walletWithdraw
};

module.exports = async function handler(req, res) {
  const route = resolveRoute(req);
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (route === '/api') {
    return res.status(200).json({
      ok: true,
      service: 'EmoBox API',
      routes: Object.keys(routes).length
    });
  }

  const routeHandler = routes[route] || routes[route.replace(/\/index$/, '')];
  if (!routeHandler) {
    return res.status(404).json({ ok: false, error: 'API route not found', route });
  }

  try {
    return await routeHandler(req, res);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
