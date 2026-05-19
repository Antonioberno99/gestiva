// Applies schema.sql to DATABASE_URL — runs on Render start.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('[migrate] DATABASE_URL missing'); process.exit(1); }
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('render.com') || url.includes('amazonaws') ? { rejectUnauthorized: false } : false
  });
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('[migrate] schema applied OK');
  } catch (e) {
    console.error('[migrate] error:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
