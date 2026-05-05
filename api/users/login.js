const { runSql, sqlString, sha256 } = require('../../lib/db');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const email = body.email;
    const password = body.password;
    
    const script = `
SET NOCOUNT ON;
DECLARE @Email NVARCHAR(255) = ${sqlString(email)};
DECLARE @PasswordHash NVARCHAR(255) = ${sqlString(sha256(password))};
DECLARE @UserId INT = NULL;
DECLARE @FullName NVARCHAR(255);
DECLARE @Phone NVARCHAR(50);
DECLARE @Address NVARCHAR(MAX);
DECLARE @PlanCode NVARCHAR(50);
DECLARE @PendingPlanCode NVARCHAR(50);
DECLARE @RegisteredAt DATETIME2(0);
DECLARE @Balance DECIMAL(18,2) = 0;

SELECT 
  @UserId = u.UserId,
  @FullName = u.FullName,
  @Phone = u.Phone,
  @Address = u.Address,
  @PlanCode = u.PlanCode,
  @PendingPlanCode = u.PendingPlanCode,
  @RegisteredAt = u.RegisteredAt
FROM dbo.B20Users u
WHERE u.Email = @Email AND (u.PasswordHash = @PasswordHash OR u.PasswordHash IS NULL OR u.PasswordHash = '');

IF @UserId IS NULL
BEGIN
  IF EXISTS(SELECT 1 FROM dbo.B20Users WHERE Email = @Email)
    SELECT 'INVALID_PASSWORD' AS error FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
  ELSE
    SELECT 'NOT_FOUND' AS error FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
END
ELSE
BEGIN
  SELECT @Balance = Balance FROM dbo.B30WalletAccounts WHERE UserId = @UserId;
  SELECT 
    @UserId AS userId, 
    @FullName AS name, 
    @Email AS email, 
    @Phone AS phone, 
    @Address AS address, 
    @PlanCode AS [plan], 
    @PendingPlanCode AS pendingPlan, 
    @RegisteredAt AS registeredAt, 
    @Balance AS balance
  FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
END
`;
    const result = await runSql(script);
    
    if (result.error === 'NOT_FOUND') {
      return res.status(500).json({ ok: false, error: 'Tài khoản chưa tồn tại!' });
    } else if (result.error === 'INVALID_PASSWORD') {
      return res.status(500).json({ ok: false, error: 'Sai mật khẩu!' });
    }
    
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
