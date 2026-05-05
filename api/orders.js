const { runSql, userPayloadSql, sqlString, sqlJson } = require('../lib/db');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
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
    const result = await runSql(script);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
