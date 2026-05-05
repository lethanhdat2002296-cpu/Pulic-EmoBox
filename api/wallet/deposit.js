const { runSql, userPayloadSql, sqlString, sqlJson } = require('../../lib/db');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const amount = Math.abs(Number(body.amount || 0));
    const paymentMethod = body.paymentMethod || 'bank';
    const description = 'Nap tien vi EmoBox';
    
    const script = `
SET NOCOUNT ON;
BEGIN TRAN;
${userPayloadSql(body.user)}

DECLARE @Amount DECIMAL(18,2) = ${Number.isFinite(amount) ? amount : 0};
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
    (@UserId, N'deposit', @Amount, @BalanceAfter, ${sqlString(paymentMethod)}, N'wallet', ${sqlString(description)}, ${sqlJson(body.bankInfo || {})});
END

COMMIT;
SELECT @UserId AS userId, @BalanceAfter AS balanceAfter
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
    const result = await runSql(script);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
