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
    const result = await runSql(script);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
