const { Pool } = require('pg');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let pool;
let schemaReady;

const schemaSql = `
CREATE TABLE IF NOT EXISTS "B20Users" (
  user_id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  address TEXT,
  password_hash TEXT,
  plan_code TEXT NOT NULL DEFAULT 'none',
  pending_plan_code TEXT,
  registered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30WalletAccounts" (
  wallet_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30WalletTransactions" (
  transaction_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  balance_after NUMERIC(18,2),
  payment_method TEXT,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  external_reference TEXT,
  proof_url TEXT,
  description TEXT,
  metadata JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30BankCards" (
  card_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  cardholder_name TEXT NOT NULL,
  card_number TEXT NOT NULL,
  card_last4 TEXT NOT NULL,
  expiry_month TEXT NOT NULL,
  expiry_year TEXT NOT NULL,
  card_brand TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30Subscriptions" (
  subscription_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  payment_reference TEXT,
  payment_proof_url TEXT,
  bank_transfer_note TEXT,
  paid_at TIMESTAMPTZ,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30Orders" (
  order_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE SET NULL,
  order_code TEXT NOT NULL UNIQUE,
  subtotal NUMERIC(18,2) NOT NULL,
  shipping_fee NUMERIC(18,2) NOT NULL,
  total_amount NUMERIC(18,2) NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  order_status TEXT NOT NULL DEFAULT 'processing',
  payment_reference TEXT,
  payment_proof_url TEXT,
  bank_transfer_note TEXT,
  paid_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B20OrderContacts" (
  contact_id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES "B30Orders"(order_id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE SET NULL,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  personal_message TEXT,
  is_anonymous_sender BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30OrderItems" (
  order_item_id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES "B30Orders"(order_id) ON DELETE CASCADE,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  image_path TEXT,
  unit_price NUMERIC(18,2) NOT NULL,
  quantity INTEGER NOT NULL,
  line_total NUMERIC(18,2) NOT NULL,
  is_scheduled_gift BOOLEAN NOT NULL DEFAULT FALSE,
  package_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30OrderTrackingEvents" (
  tracking_id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES "B30Orders"(order_id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  order_status TEXT,
  payment_status TEXT,
  title TEXT NOT NULL,
  message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30PaymentWebhookEvents" (
  event_id BIGSERIAL PRIMARY KEY,
  provider_event_id TEXT UNIQUE,
  reference_type TEXT,
  reference_id TEXT,
  payment_status TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B20GiftRecipients" (
  recipient_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  local_event_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, local_event_id)
);

CREATE TABLE IF NOT EXISTS "B20SavedRecipients" (
  recipient_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, phone, address)
);

CREATE TABLE IF NOT EXISTS "B20ContactMessages" (
  message_id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30GiftSchedules" (
  schedule_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  recipient_id BIGINT REFERENCES "B20GiftRecipients"(recipient_id) ON DELETE SET NULL,
  order_id BIGINT REFERENCES "B30Orders"(order_id) ON DELETE SET NULL,
  local_event_id TEXT NOT NULL,
  gift_date DATE NOT NULL,
  group_code TEXT,
  category_code TEXT,
  tier_code TEXT,
  package_name TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  paid BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  package_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (user_id, local_event_id)
);

ALTER TABLE IF EXISTS "B30GiftSchedules"
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS "B30WalletTransactions"
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS "B30WalletTransactions"
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS external_reference TEXT,
  ADD COLUMN IF NOT EXISTS proof_url TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "B30Orders"
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_proof_url TEXT,
  ADD COLUMN IF NOT EXISTS bank_transfer_note TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "B30Subscriptions"
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_proof_url TEXT,
  ADD COLUMN IF NOT EXISTS bank_transfer_note TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "B30OrderTrackingEvents"
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES "B20Users"(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'status',
  ADD COLUMN IF NOT EXISTS order_status TEXT,
  ADD COLUMN IF NOT EXISTS payment_status TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'Cap nhat don hang',
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS "IX_B30GiftSchedules_user_id"
  ON "B30GiftSchedules" (user_id);

CREATE INDEX IF NOT EXISTS "IX_B30WalletTransactions_user_id"
  ON "B30WalletTransactions" (user_id);

CREATE INDEX IF NOT EXISTS "IX_B30WalletTransactions_reference"
  ON "B30WalletTransactions" (reference_type, reference_id);

CREATE INDEX IF NOT EXISTS "IX_B30Orders_user_id"
  ON "B30Orders" (user_id);

CREATE INDEX IF NOT EXISTS "IX_B30OrderTrackingEvents_order_id"
  ON "B30OrderTrackingEvents" (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS "IX_B30OrderTrackingEvents_user_id"
  ON "B30OrderTrackingEvents" (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS "IX_B20SavedRecipients_user_id"
  ON "B20SavedRecipients" (user_id);

INSERT INTO "B30OrderTrackingEvents"
  (order_id, user_id, event_type, order_status, payment_status, title, message, metadata, created_at)
SELECT
  o.order_id,
  o.user_id,
  'created',
  o.order_status,
  o.payment_status,
  'Đã tạo đơn hàng',
  'Đơn hàng đã được ghi nhận trong hệ thống EmoBox.',
  jsonb_build_object('orderCode', o.order_code, 'backfilled', true),
  o.created_at
FROM "B30Orders" o
WHERE NOT EXISTS (
  SELECT 1
  FROM "B30OrderTrackingEvents" te
  WHERE te.order_id = o.order_id
);

UPDATE "B30BankCards"
SET card_number = CONCAT('**** **** **** ', card_last4)
WHERE card_number ! LIKE '****%';
`;

function getPool() {
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL environment variable');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000
    });
  }

  return pool;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(schemaSql);
  }
  return schemaReady;
}

async function withClient(callback) {
  await ensureSchema();
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

function sha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (err) {
      return {};
    }
  }
  return req.body;
}

async function upsertUser(client, user = {}) {
  const email = normalizeEmail(user.email);
  if (!email) return { userId: null, email: null };

  const passwordHash = user.passwordHash || sha256(user.password);
  const result = await client.query(
    `
    INSERT INTO "B20Users"
      (full_name, email, phone, address, password_hash, plan_code, pending_plan_code, registered_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (email) DO UPDATE SET
      full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), "B20Users".full_name),
      phone = EXCLUDED.phone,
      address = EXCLUDED.address,
      password_hash = COALESCE(EXCLUDED.password_hash, "B20Users".password_hash),
      plan_code = COALESCE(NULLIF(EXCLUDED.plan_code, ''), "B20Users".plan_code),
      pending_plan_code = EXCLUDED.pending_plan_code,
      registered_at = COALESCE(EXCLUDED.registered_at, "B20Users".registered_at),
      updated_at = NOW()
    RETURNING user_id, email
    `,
    [
      user.name || user.fullName || 'Khach Hang',
      email,
      user.phone || null,
      user.address || null,
      passwordHash,
      user.plan || 'none',
      user.pendingPlan || null,
      isoOrNull(user.registeredAt)
    ]
  );

  const userId = result.rows[0].user_id;
  await client.query(
    `
    INSERT INTO "B30WalletAccounts" (user_id, balance)
    VALUES ($1, 0)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  return { userId, email };
}

async function resolveUser(client, user = {}) {
  const userId = Number(user.userId || user.user_id || 0);
  if (userId) {
    const byId = await client.query(
      'SELECT user_id, email FROM "B20Users" WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (byId.rowCount > 0) {
      return { userId: byId.rows[0].user_id, email: byId.rows[0].email };
    }
  }

  const email = normalizeEmail(user.email);
  if (!email) return { userId: null, email: null };

  const byEmail = await client.query(
    'SELECT user_id, email FROM "B20Users" WHERE email = $1 LIMIT 1',
    [email]
  );

  if (byEmail.rowCount === 0) return { userId: null, email };
  return { userId: byEmail.rows[0].user_id, email: byEmail.rows[0].email };
}

async function insertWalletTransaction(client, tx) {
  if (!tx.userId) return;
  await client.query(
    `
    INSERT INTO "B30WalletTransactions"
      (user_id, transaction_type, amount, balance_after, payment_method, reference_type, reference_id, status, external_reference, proof_url, description, metadata)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      tx.userId,
      tx.type,
      toNumber(tx.amount, 0),
      tx.balanceAfter === undefined ? null : toNumber(tx.balanceAfter, 0),
      tx.paymentMethod || null,
      tx.referenceType || null,
      tx.referenceId || null,
      tx.status || 'completed',
      tx.externalReference || null,
      tx.proofUrl || null,
      tx.description || null,
      tx.metadata ? JSON.stringify(tx.metadata) : null
    ]
  );
}

function orderCode() {
  return `EB${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

module.exports = {
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
};
