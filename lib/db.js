const sql = require('mssql');
const crypto = require('crypto');

const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER, 
  port: process.env.SQL_PORT ? parseInt(process.env.SQL_PORT, 10) : 1433,
  database: process.env.SQL_DATABASE,
  options: {
    encrypt: true, // For Azure
    trustServerCertificate: true // For local dev
  }
};

let poolPromise = null;

function getConnection() {
  if (!poolPromise) {
    if (!config.server || !config.user) {
       console.error("Missing SQL environment variables.");
    }
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then(pool => {
        console.log('Connected to SQL Server');
        return pool;
      })
      .catch(err => {
        console.error('Database Connection Failed! Bad Config: ', err);
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

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

async function runSql(script) {
  const pool = await getConnection();
  const request = pool.request();
  const result = await request.query(script);
  
  if (result.recordset && result.recordset.length > 0) {
    const keys = Object.keys(result.recordset[0]);
    if (keys.length > 0) {
      let jsonStr = '';
      for (const row of result.recordset) {
        jsonStr += row[keys[0]];
      }
      return parseSqlJson(jsonStr);
    }
  }
  return {};
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

module.exports = {
  getConnection,
  sqlString,
  sqlJson,
  sha256,
  runSql,
  userPayloadSql
};
