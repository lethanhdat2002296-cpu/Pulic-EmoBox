const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const rootDir = __dirname;

function loadLocalEnv() {
  const envPath = path.join(rootDir, '.env.local');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex < 0) return;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadLocalEnv();

const config = {
  port: Number(process.env.PORT || 3000),
  server: process.env.SQL_SERVER || 'DATLT-BSG',
  user: process.env.SQL_USER || 'DATLT-BSG',
  password: process.env.SQL_PASSWORD || '',
  database: process.env.SQL_DATABASE || 'Agent'
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `N'${String(value).replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  return sqlString(JSON.stringify(value || {}));
}

function sha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function runSql(script, options = {}) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `emobox-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`);
    fs.writeFileSync(tempFile, script, 'utf8');

    const args = [
      '-S', config.server,
      '-U', config.user,
      '-P', config.password,
      '-C',
      '-b',
      '-h', '-1',
      '-W',
      '-w', '65535'
    ];

    if (options.database) {
      args.push('-d', options.database);
    }

    args.push('-i', tempFile);

    const child = spawn('SQLCMD.EXE', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', err => {
      fs.rm(tempFile, { force: true }, () => {});
      reject(err);
    });

    child.on('close', code => {
      fs.rm(tempFile, { force: true }, () => {});
      if (code !== 0) {
        reject(new Error((stderr || stdout || `sqlcmd exited with code ${code}`).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseSqlJson(output) {
  if (!output) return {};
  const objectStart = output.indexOf('{');
  const arrayStart = output.indexOf('[');
  let start = -1;
  let end = -1;

  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
    start = objectStart;
    end = output.lastIndexOf('}');
  } else if (arrayStart >= 0) {
    start = arrayStart;
    end = output.lastIndexOf(']');
  }

  if (start < 0 || end < start) return {};
  return JSON.parse(output.slice(start, end + 1));
}

async function initializeDatabase() {
  const schemaPath = path.join(rootDir, 'sql', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await runSql(schema);
}

function userPayloadSql(user) {
  const normalized = user || {};
  normalized.passwordHash = normalized.passwordHash || sha256(normalized.password);
  delete normalized.password;
  return `
DECLARE @UserPayload NVARCHAR(MAX) = ${sqlJson(normalized)};
DECLARE @UserId INT = NULL;
DECLARE @Email NVARCHAR(255) = NULLIF(JSON_VALUE(@UserPayload, '$.email'), N'');

IF @Email IS NOT NULL
BEGIN
  SELECT @UserId = UserId FROM dbo.B20Users WHERE Email = @Email;

  IF @UserId IS NULL
  BEGIN
    INSERT INTO dbo.B20Users (FullName, Email, Phone, Address, PasswordHash, PlanCode, PendingPlanCode, RegisteredAt)
    VALUES (
      COALESCE(NULLIF(JSON_VALUE(@UserPayload, '$.name'), N''), N'Khach Hang'),
      @Email,
      NULLIF(JSON_VALUE(@UserPayload, '$.phone'), N''),
      NULLIF(JSON_VALUE(@UserPayload, '$.address'), N''),
      NULLIF(JSON_VALUE(@UserPayload, '$.passwordHash'), N''),
      COALESCE(NULLIF(JSON_VALUE(@UserPayload, '$.plan'), N''), N'none'),
      NULLIF(JSON_VALUE(@UserPayload, '$.pendingPlan'), N''),
      TRY_CONVERT(DATETIME2(0), JSON_VALUE(@UserPayload, '$.registeredAt'), 127)
    );
    SET @UserId = SCOPE_IDENTITY();
  END
  ELSE
  BEGIN
    UPDATE dbo.B20Users
    SET FullName = COALESCE(NULLIF(JSON_VALUE(@UserPayload, '$.name'), N''), FullName),
        Phone = NULLIF(JSON_VALUE(@UserPayload, '$.phone'), N''),
        Address = NULLIF(JSON_VALUE(@UserPayload, '$.address'), N''),
        PasswordHash = COALESCE(NULLIF(JSON_VALUE(@UserPayload, '$.passwordHash'), N''), PasswordHash),
        PlanCode = COALESCE(NULLIF(JSON_VALUE(@UserPayload, '$.plan'), N''), PlanCode),
        PendingPlanCode = NULLIF(JSON_VALUE(@UserPayload, '$.pendingPlan'), N''),
        RegisteredAt = COALESCE(TRY_CONVERT(DATETIME2(0), JSON_VALUE(@UserPayload, '$.registeredAt'), 127), RegisteredAt),
        UpdatedAt = SYSUTCDATETIME()
    WHERE UserId = @UserId;
  END

  IF NOT EXISTS (SELECT 1 FROM dbo.B30WalletAccounts WHERE UserId = @UserId)
  BEGIN
    INSERT INTO dbo.B30WalletAccounts (UserId, Balance)
    VALUES (@UserId, COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(@UserPayload, '$.balance')), 0));
  END
  ELSE IF JSON_VALUE(@UserPayload, '$.balance') IS NOT NULL
  BEGIN
    UPDATE dbo.B30WalletAccounts
    SET Balance = COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(@UserPayload, '$.balance')), Balance),
        UpdatedAt = SYSUTCDATETIME()
    WHERE UserId = @UserId;
  END
END
`;
}

async function saveUser(body) {
  const script = `
SET NOCOUNT ON;
${userPayloadSql(body.user)}

SELECT @UserId AS userId, @Email AS email
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
  return parseSqlJson(await runSql(script, { database: config.database }));
}

async function saveWalletTransaction(body, type) {
  const amount = Math.abs(Number(body.amount || 0));
  const signedAmount = type === 'withdraw' ? -amount : amount;
  const paymentMethod = body.paymentMethod || 'bank';
  const description = type === 'withdraw' ? 'Rut tien vi EmoBox' : 'Nap tien vi EmoBox';
  const script = `
SET NOCOUNT ON;
BEGIN TRAN;
${userPayloadSql(body.user)}

DECLARE @Amount DECIMAL(18,2) = ${Number.isFinite(signedAmount) ? signedAmount : 0};
DECLARE @BalanceAfter DECIMAL(18,2) = COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(@UserPayload, '$.balance')), 0);

IF @UserId IS NOT NULL
BEGIN
  UPDATE dbo.B30WalletAccounts
  SET Balance = @BalanceAfter,
      UpdatedAt = SYSUTCDATETIME()
  WHERE UserId = @UserId;

  INSERT INTO dbo.B30WalletTransactions
    (UserId, TransactionType, Amount, BalanceAfter, PaymentMethod, ReferenceType, Description, Metadata)
  VALUES
    (@UserId, ${sqlString(type)}, @Amount, @BalanceAfter, ${sqlString(paymentMethod)}, N'wallet', ${sqlString(description)}, ${sqlJson(body.bankInfo || {})});
END

COMMIT;
SELECT @UserId AS userId, @BalanceAfter AS balanceAfter
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
  return parseSqlJson(await runSql(script, { database: config.database }));
}

async function activateSubscription(body) {
  const plan = body.plan || {};
  const planCode = body.planCode || '';
  const durationMonths = planCode === '3-months' ? 3 : planCode === '6-months' ? 6 : planCode === '12-months' ? 12 : 0;
  const amount = Number(plan.price || 0);
  const script = `
SET NOCOUNT ON;
BEGIN TRAN;
${userPayloadSql(body.user)}

DECLARE @PlanCode NVARCHAR(30) = ${sqlString(planCode)};
DECLARE @PlanName NVARCHAR(100) = ${sqlString(plan.name || planCode)};
DECLARE @Amount DECIMAL(18,2) = ${Number.isFinite(amount) ? amount : 0};
DECLARE @PaymentMethod NVARCHAR(30) = ${sqlString(body.paymentMethod || 'card')};
DECLARE @StartAt DATETIME2(0) = SYSUTCDATETIME();
DECLARE @EndAt DATETIME2(0) = CASE WHEN ${durationMonths} > 0 THEN DATEADD(MONTH, ${durationMonths}, @StartAt) ELSE NULL END;
DECLARE @BalanceAfter DECIMAL(18,2) = COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(@UserPayload, '$.balance')), 0);

IF @UserId IS NOT NULL
BEGIN
  UPDATE dbo.B20Users
  SET PlanCode = @PlanCode,
      PendingPlanCode = NULL,
      RegisteredAt = @StartAt,
      UpdatedAt = SYSUTCDATETIME()
  WHERE UserId = @UserId;

  UPDATE dbo.B30WalletAccounts
  SET Balance = @BalanceAfter,
      UpdatedAt = SYSUTCDATETIME()
  WHERE UserId = @UserId;

  INSERT INTO dbo.B30Subscriptions (UserId, PlanCode, PlanName, Amount, PaymentMethod, Status, StartAt, EndAt)
  VALUES (@UserId, @PlanCode, @PlanName, @Amount, @PaymentMethod, N'active', @StartAt, @EndAt);

  INSERT INTO dbo.B30WalletTransactions
    (UserId, TransactionType, Amount, BalanceAfter, PaymentMethod, ReferenceType, ReferenceId, Description)
  VALUES
    (@UserId, N'subscription_credit', @Amount, @BalanceAfter, @PaymentMethod, N'subscription', CONVERT(NVARCHAR(80), SCOPE_IDENTITY()), @PlanName);
END

COMMIT;
SELECT @UserId AS userId, @PlanCode AS planCode, @BalanceAfter AS balanceAfter
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
  return parseSqlJson(await runSql(script, { database: config.database }));
}

async function saveGiftSchedule(body) {
  const eventData = body.event || {};
  const amount = Number(eventData.priceNum || eventData.amount || 0);
  const paid = eventData.paid ? 1 : 0;
  const script = `
SET NOCOUNT ON;
BEGIN TRAN;
${userPayloadSql(body.user)}

DECLARE @EventPayload NVARCHAR(MAX) = ${sqlJson(eventData)};
DECLARE @LocalEventId NVARCHAR(80) = JSON_VALUE(@EventPayload, '$.id');
DECLARE @RecipientId BIGINT = NULL;
DECLARE @Amount DECIMAL(18,2) = ${Number.isFinite(amount) ? amount : 0};
DECLARE @Paid BIT = ${paid};
DECLARE @PaymentMethod NVARCHAR(30) = ${sqlString(body.paymentMethod || 'bank')};
DECLARE @BalanceAfter DECIMAL(18,2) = COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(@UserPayload, '$.balance')), 0);

IF @UserId IS NOT NULL AND @LocalEventId IS NOT NULL
BEGIN
  SELECT @RecipientId = RecipientId
  FROM dbo.B20GiftRecipients
  WHERE UserId = @UserId AND LocalEventId = @LocalEventId;

  IF @RecipientId IS NULL
  BEGIN
    INSERT INTO dbo.B20GiftRecipients (UserId, LocalEventId, FullName, Phone, Email, Address)
    VALUES (
      @UserId,
      @LocalEventId,
      COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.recipient'), N''), N'Nguoi nhan'),
      COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.phone'), N''), N''),
      NULLIF(JSON_VALUE(@EventPayload, '$.email'), N''),
      COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.address'), N''), N'')
    );
    SET @RecipientId = SCOPE_IDENTITY();
  END
  ELSE
  BEGIN
    UPDATE dbo.B20GiftRecipients
    SET FullName = COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.recipient'), N''), FullName),
        Phone = COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.phone'), N''), Phone),
        Email = NULLIF(JSON_VALUE(@EventPayload, '$.email'), N''),
        Address = COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.address'), N''), Address),
        UpdatedAt = SYSUTCDATETIME()
    WHERE RecipientId = @RecipientId;
  END

  IF EXISTS (SELECT 1 FROM dbo.B30GiftSchedules WHERE UserId = @UserId AND LocalEventId = @LocalEventId)
  BEGIN
    UPDATE dbo.B30GiftSchedules
    SET RecipientId = @RecipientId,
        GiftDate = TRY_CONVERT(DATE, JSON_VALUE(@EventPayload, '$.date')),
        GroupCode = NULLIF(JSON_VALUE(@EventPayload, '$.group'), N''),
        CategoryCode = NULLIF(JSON_VALUE(@EventPayload, '$.cat'), N''),
        TierCode = NULLIF(JSON_VALUE(@EventPayload, '$.tier'), N''),
        PackageName = COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.pkgName'), N''), N'Gift package'),
        Amount = @Amount,
        Paid = @Paid,
        Status = CASE WHEN @Paid = 1 THEN N'paid' ELSE N'pending' END,
        PackageJson = @EventPayload,
        UpdatedAt = SYSUTCDATETIME(),
        DeletedAt = NULL
    WHERE UserId = @UserId AND LocalEventId = @LocalEventId;
  END
  ELSE
  BEGIN
    INSERT INTO dbo.B30GiftSchedules
      (UserId, RecipientId, LocalEventId, GiftDate, GroupCode, CategoryCode, TierCode, PackageName, Amount, Paid, Status, PackageJson)
    VALUES
      (@UserId, @RecipientId, @LocalEventId, TRY_CONVERT(DATE, JSON_VALUE(@EventPayload, '$.date')),
       NULLIF(JSON_VALUE(@EventPayload, '$.group'), N''), NULLIF(JSON_VALUE(@EventPayload, '$.cat'), N''),
       NULLIF(JSON_VALUE(@EventPayload, '$.tier'), N''), COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.pkgName'), N''), N'Gift package'),
       @Amount, @Paid, CASE WHEN @Paid = 1 THEN N'paid' ELSE N'pending' END, @EventPayload);
  END

  IF @Paid = 1 AND @PaymentMethod = N'wallet'
  BEGIN
    UPDATE dbo.B30WalletAccounts
    SET Balance = @BalanceAfter,
        UpdatedAt = SYSUTCDATETIME()
    WHERE UserId = @UserId;

    INSERT INTO dbo.B30WalletTransactions
      (UserId, TransactionType, Amount, BalanceAfter, PaymentMethod, ReferenceType, ReferenceId, Description, Metadata)
    VALUES
      (@UserId, N'gift_schedule_payment', -@Amount, @BalanceAfter, @PaymentMethod, N'gift_schedule', @LocalEventId,
       COALESCE(NULLIF(JSON_VALUE(@EventPayload, '$.pkgName'), N''), N'Thanh toan lich tang qua'), @EventPayload);
  END
END

COMMIT;
SELECT @UserId AS userId, @LocalEventId AS localEventId
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
  return parseSqlJson(await runSql(script, { database: config.database }));
}

async function deleteGiftSchedule(body) {
  const script = `
SET NOCOUNT ON;
${userPayloadSql(body.user)}

DECLARE @LocalEventId NVARCHAR(80) = ${sqlString(body.localEventId)};
IF @UserId IS NOT NULL AND @LocalEventId IS NOT NULL
BEGIN
  UPDATE dbo.B30GiftSchedules
  SET DeletedAt = SYSUTCDATETIME(),
      UpdatedAt = SYSUTCDATETIME(),
      Status = N'deleted'
  WHERE UserId = @UserId AND LocalEventId = @LocalEventId;
END

SELECT @UserId AS userId, @LocalEventId AS localEventId
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
  return parseSqlJson(await runSql(script, { database: config.database }));
}

async function saveOrder(body) {
  const order = body.order || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const subtotal = Number(order.subtotal || 0);
  const shippingFee = Number(order.shippingFee || 0);
  const total = Number(order.total || subtotal + shippingFee);
  const script = `
SET NOCOUNT ON;
BEGIN TRAN;
${userPayloadSql(body.user)}

DECLARE @OrderPayload NVARCHAR(MAX) = ${sqlJson(order)};
DECLARE @ItemsPayload NVARCHAR(MAX) = ${sqlJson(items)};
DECLARE @OrderId BIGINT = NULL;
DECLARE @OrderCode NVARCHAR(40) = CONCAT(N'EB', FORMAT(SYSUTCDATETIME(), 'yyyyMMddHHmmss'), RIGHT(CONVERT(NVARCHAR(36), NEWID()), 6));
DECLARE @PaymentMethod NVARCHAR(30) = COALESCE(NULLIF(JSON_VALUE(@OrderPayload, '$.paymentMethod'), N''), N'card');
DECLARE @PaymentStatus NVARCHAR(30) = CASE WHEN @PaymentMethod = N'cod' THEN N'pending' ELSE N'paid' END;
DECLARE @BalanceAfter DECIMAL(18,2) = COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(@UserPayload, '$.balance')), 0);

INSERT INTO dbo.B30Orders (UserId, OrderCode, Subtotal, ShippingFee, TotalAmount, PaymentMethod, PaymentStatus, OrderStatus)
VALUES (@UserId, @OrderCode, ${Number.isFinite(subtotal) ? subtotal : 0}, ${Number.isFinite(shippingFee) ? shippingFee : 0}, ${Number.isFinite(total) ? total : 0}, @PaymentMethod, @PaymentStatus, N'processing');

SET @OrderId = SCOPE_IDENTITY();

INSERT INTO dbo.B20OrderContacts
  (OrderId, UserId, RecipientName, RecipientPhone, RecipientEmail, ShippingAddress, PersonalMessage, IsAnonymousSender)
VALUES
  (@OrderId, @UserId,
   COALESCE(NULLIF(JSON_VALUE(@OrderPayload, '$.contact.name'), N''), N'Nguoi nhan'),
   COALESCE(NULLIF(JSON_VALUE(@OrderPayload, '$.contact.phone'), N''), N''),
   COALESCE(NULLIF(JSON_VALUE(@OrderPayload, '$.contact.email'), N''), N''),
   COALESCE(NULLIF(JSON_VALUE(@OrderPayload, '$.contact.address'), N''), N''),
   NULLIF(JSON_VALUE(@OrderPayload, '$.contact.message'), N''),
   COALESCE(TRY_CONVERT(BIT, JSON_VALUE(@OrderPayload, '$.contact.anonymousSender')), 0));

INSERT INTO dbo.B30OrderItems
  (OrderId, ProductCode, ProductName, ImagePath, UnitPrice, Quantity, LineTotal, IsScheduledGift, PackageJson)
SELECT
  @OrderId,
  COALESCE(NULLIF(JSON_VALUE(value, '$.id'), N''), N'unknown'),
  COALESCE(NULLIF(JSON_VALUE(value, '$.name'), N''), NULLIF(JSON_VALUE(value, '$.productName'), N''), N'Gift item'),
  NULLIF(JSON_VALUE(value, '$.image'), N''),
  COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(value, '$.unitPrice')),
           TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(value, '$.priceNum')),
           TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(value, '$.pkgPrice')), 0),
  COALESCE(TRY_CONVERT(INT, JSON_VALUE(value, '$.quantity')), 1),
  COALESCE(TRY_CONVERT(DECIMAL(18,2), JSON_VALUE(value, '$.lineTotal')), 0),
  CASE WHEN JSON_VALUE(value, '$.id') LIKE N'evt_%' THEN 1 ELSE 0 END,
  value
FROM OPENJSON(@ItemsPayload);

UPDATE s
SET s.OrderId = @OrderId,
    s.Paid = CASE WHEN @PaymentStatus = N'paid' THEN 1 ELSE s.Paid END,
    s.Status = CASE WHEN @PaymentStatus = N'paid' THEN N'paid' ELSE s.Status END,
    s.UpdatedAt = SYSUTCDATETIME()
FROM dbo.B30GiftSchedules s
JOIN OPENJSON(@ItemsPayload) i ON s.LocalEventId = JSON_VALUE(i.value, '$.id')
WHERE s.UserId = @UserId;

IF @PaymentMethod = N'wallet' AND @UserId IS NOT NULL
BEGIN
  UPDATE dbo.B30WalletAccounts
  SET Balance = @BalanceAfter,
      UpdatedAt = SYSUTCDATETIME()
  WHERE UserId = @UserId;

  INSERT INTO dbo.B30WalletTransactions
    (UserId, TransactionType, Amount, BalanceAfter, PaymentMethod, ReferenceType, ReferenceId, Description, Metadata)
  VALUES
    (@UserId, N'order_payment', -${Number.isFinite(total) ? total : 0}, @BalanceAfter, @PaymentMethod, N'order', @OrderCode, N'Thanh toan don hang', @OrderPayload);
END

COMMIT;

SELECT @OrderId AS orderId, @OrderCode AS orderCode, @PaymentStatus AS paymentStatus
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
  return parseSqlJson(await runSql(script, { database: config.database }));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

async function handleApi(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (req.url === '/api/health' && req.method === 'GET') {
      const result = parseSqlJson(await runSql('SET NOCOUNT ON; SELECT 1 AS ok, DB_NAME() AS databaseName FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;', { database: config.database }));
      sendJson(res, 200, Object.assign({ ok: true }, result));
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    const body = await readBody(req);
    let result;

    if (req.url === '/api/users/upsert') result = await saveUser(body);
    else if (req.url === '/api/subscriptions/activate') result = await activateSubscription(body);
    else if (req.url === '/api/wallet/deposit') result = await saveWalletTransaction(body, 'deposit');
    else if (req.url === '/api/wallet/withdraw') result = await saveWalletTransaction(body, 'withdraw');
    else if (req.url === '/api/gift-schedules') result = await saveGiftSchedule(body);
    else if (req.url === '/api/gift-schedules/delete') result = await deleteGiftSchedule(body);
    else if (req.url === '/api/orders') result = await saveOrder(body);
    else {
      sendJson(res, 404, { ok: false, error: 'API route not found' });
      return;
    }

    sendJson(res, 200, Object.assign({ ok: true }, result));
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.normalize(path.join(rootDir, relativePath));
  if (!filePath.startsWith(rootDir)) return null;
  return filePath;
}

function serveStatic(req, res) {
  const filePath = safeStaticPath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

async function start() {
  await initializeDatabase();
  http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  }).listen(config.port, () => {
    console.log(`EmoBox is running at http://localhost:${config.port}`);
    console.log(`SQL Server: ${config.server}, database: ${config.database}`);
  });
}

start().catch(err => {
  console.error('Cannot start EmoBox server:', err.message);
  process.exit(1);
});
