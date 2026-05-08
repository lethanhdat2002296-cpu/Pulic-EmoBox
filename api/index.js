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
    total: Number(row.total_amount || 0),
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
      return {
        userId: user.userId,
        card: {
          holderName: row.cardholder_name,
          cardNumber: row.card_number,
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
        [user.userId, holderName, cardNumber, cardNumber.slice(-4), expiry.month, expiry.year, brandFromNumber(cardNumber)]
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
}

async function activateSubscription(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

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
}

async function saveOrder(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const body = getBody(req);
    const order = body.order || {};
    const items = Array.isArray(order.items) ? order.items : [];
    const subtotal = toNumber(order.subtotal, 0);
    const shippingFee = toNumber(order.shippingFee, 0);
    const total = toNumber(order.total, subtotal + shippingFee);
    const paymentMethod = order.paymentMethod || 'card';
    const paymentStatus = ['cod', 'bank_transfer'].includes(paymentMethod) ? 'pending' : 'paid';
    const paymentReference = order.paymentReference || order.transferCode || '';
    const paymentProofUrl = order.paymentProofUrl || order.paymentProofName || '';
    const bankTransferNote = order.bankTransferNote || order.transferNote || '';

    const result = await withClient(async client => {
      const user = await upsertUser(client, body.user);
      const code = orderCode();

      const orderResult = await client.query(
        `
        INSERT INTO "B30Orders"
          (user_id, order_code, subtotal, shipping_fee, total_amount, payment_method, payment_status, order_status, payment_reference, payment_proof_url, bank_transfer_note, paid_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, 'processing', $8, $9, $10, CASE WHEN $7 = 'paid' THEN NOW() ELSE NULL END)
        RETURNING order_id, order_code, payment_status
        `,
        [user.userId, code, subtotal, shippingFee, total, paymentMethod, paymentStatus, paymentReference || null, paymentProofUrl || null, bankTransferNote || null]
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
        order: { subtotal, shippingFee, total, paymentMethod, paymentStatus, paymentReference, paymentProofUrl, bankTransferNote },
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
      o.total_amount,
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
    if (expectedSecret && body.secret !== expectedSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized webhook' });
    }

    const orderCodeInput = String(body.orderCode || body.reference || '').trim().toUpperCase();
    const status = String(body.status || 'paid').trim().toLowerCase();
    if (!orderCodeInput) {
      return res.status(400).json({ ok: false, error: 'Missing orderCode' });
    }

    const result = await withClient(async client => {
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
      return { updated: true, order: orders[0] || null };
    });

    if (!result.updated) {
      return res.status(404).json({ ok: false, error: 'Khong tim thay don hang.' });
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
  '/api/payments/webhook': paymentWebhook,
  '/api/recipients/list': listRecipients,
  '/api/subscriptions/activate': activateSubscription,
  '/api/users/login': loginUser,
  '/api/users/upsert': upsertUserRoute,
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
