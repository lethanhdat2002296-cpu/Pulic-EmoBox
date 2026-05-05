const { runSql, userPayloadSql, sqlString } = require('../../lib/db');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
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
    const result = await runSql(script);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
