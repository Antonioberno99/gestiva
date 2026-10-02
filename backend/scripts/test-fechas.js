// "Hoy" en hora argentina: una venta de las 22:30 es de HOY (antes, con UTC,
// pasaba al día siguiente y el dashboard se ponía en cero a las 21 hs).
//   DATABASE_URL=... GESTIVA_API=... node scripts/test-fechas.js
'use strict';
const { Pool } = require('pg');
const API = process.env.GESTIVA_API || 'http://127.0.0.1:3100';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`)); };
async function req(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
(async () => {
  const email = `fechas-${Date.now()}@test.local`;
  const reg = await req('/auth/register', { method: 'POST', body: { email, password: 'Secreta123', restaurantName: 'Turno Noche' } });
  const T = reg.data.token;
  const tid = (await pool.query('SELECT id FROM tenants WHERE email=$1', [email])).rows[0].id;
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  const ayer = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(Date.now() - 86400000));
  const venta = (cuando, total) => pool.query(
    `INSERT INTO orders (tenant_id, items, subtotal, total, payment_method, closed_at) VALUES ($1,'[]',$2,$2,'efectivo',$3::timestamptz)`,
    [tid, total, cuando]);
  await venta(`${hoy} 22:30:00-03`, 1000);   // cena de hoy (en UTC ya es mañana)
  await venta(`${hoy} 00:30:00-03`, 200);    // trasnoche de hoy
  await venta(`${ayer} 23:30:00-03`, 50);    // ayer a la noche (en UTC ya es hoy)
  console.log('\n\x1b[1mDASHBOARD: VENTAS DE HOY\x1b[0m');
  const d = await req('/api/dashboard', { token: T });
  const totales = d.data.ordersToday.map(o => Number(o.total)).sort((a, b) => a - b);
  check('la venta de las 22:30 cuenta como de HOY', totales.includes(1000), JSON.stringify(totales));
  check('la de las 00:30 de hoy también', totales.includes(200));
  check('la de ayer 23:30 NO cuenta como de hoy', !totales.includes(50));
  check('las 3 están en la semana', d.data.ordersWeek.length === 3, 'semana=' + d.data.ordersWeek.length);
  await pool.end();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — "hoy" en hora argentina\x1b[0m` : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
