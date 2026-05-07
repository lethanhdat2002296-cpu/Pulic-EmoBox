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
const { sendGiftScheduleEmail, sendOrderEmails, sendRegistrationEmail } = require('../lib/email');

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
    return res.status(500).json({ ok: false, error: err.message });
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

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
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
      if (user.userId && body.localEventId) {
        await client.query(
          `
          UPDATE "B30GiftSchedules"
          SET deleted_at = NOW(),
              updated_at = NOW(),
              status = 'deleted'
          WHERE user_id = $1 AND local_event_id = $2
          `,
          [user.userId, body.localEventId]
        );
      }

      return { userId: user.userId, localEventId: body.localEventId || null };
    });

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
        order: { subtotal, shippingFee, total, paymentMethod },
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
  '/api/orders': saveOrder,
  '/api/bank-card/get': getBankCard,
  '/api/bank-card/save': saveBankCard,
  '/api/email/gift-schedule': giftScheduleEmail,
  '/api/email/registration': registrationEmail,
  '/api/email/status': emailStatusRoute,
  '/api/gift-schedules': saveGiftSchedule,
  '/api/gift-schedules/delete': deleteGiftSchedule,
  '/api/gift-schedules/list': listGiftSchedules,
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
