const { query, setCors } = require('../lib/db');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const result = await query('SELECT 1 AS ok, current_database() AS database_name');
    return res.status(200).json({
      ok: true,
      databaseName: result.rows[0].database_name
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
