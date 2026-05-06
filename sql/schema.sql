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
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "B30Subscriptions" (
  subscription_id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES "B20Users"(user_id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
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
