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
    const result = await runSql(script);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
