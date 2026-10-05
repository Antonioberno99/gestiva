// Ingreso al sistema: los mozos entran con el CÓDIGO DEL LOCAL (no con el email
// del dueño) y el dueño puede entrar con Google sin que se cree otro
// restaurante. Usa un "Google de mentira" para no depender de cuentas reales.
//
//   El backend tiene que correr con:
//     GOOGLE_CLIENT_ID=test-client GOOGLE_TOKENINFO_URL=http://127.0.0.1:4799/tokeninfo
//   GESTIVA_API=http://127.0.0.1:3199 DATABASE_URL=postgres://... node scripts/test-ingreso.js
const http = require('http');
const API = process.env.GESTIVA_API || 'http://127.0.0.1:3100';
const pool = process.env.DATABASE_URL ? new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL }) : null;

let pass = 0, fail = 0;
function check(nombre, ok, detalle) {
  if (ok) { pass++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
function seccion(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

async function req(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  return { status: r.status, data };
}

// Google de mentira: el "credential" es lo que Google diría de esa cuenta.
const cred = (o) => Buffer.from(JSON.stringify({ aud: 'test-client', email_verified: 'true', ...o })).toString('base64url');
function googleFalso() {
  return new Promise((res) => {
    const srv = http.createServer((rq, rs) => {
      try {
        const u = new URL(rq.url, 'http://x');
        const info = JSON.parse(Buffer.from(u.searchParams.get('id_token') || '', 'base64url').toString());
        if (info.invalido) throw new Error('token inválido');
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify(info));
      } catch (e) { rs.writeHead(400, { 'Content-Type': 'application/json' }); rs.end('{"error":"invalid_token"}'); }
    });
    srv.listen(4799, '127.0.0.1', () => res(srv));
  });
}

const CODIGO = /^[A-HJKMNP-Z2-9]{6}$/;   // sin 0/O/1/I/L

(async () => {
  const google = await googleFalso();
  const id = Date.now();

  seccion('1. CADA LOCAL TIENE SU CÓDIGO');
  const x = await req('/auth/register', { method: 'POST', body: { email: `parrilla-${id}@test.local`, password: 'Secreta123', restaurantName: 'La Parrilla' } });
  const ownerX = x.data.token;
  const codX = x.data.user && x.data.user.teamCode;
  check('al registrarse recibe un código de 6 (sin letras que se confundan)', CODIGO.test(codX || ''), codX);
  const meX = await req('/auth/me', { token: ownerX });
  check('el panel lo muestra siempre igual', meX.data.user && meX.data.user.teamCode === codX);
  const y = await req('/auth/register', { method: 'POST', body: { email: `cantina-${id}@test.local`, password: 'Secreta123', restaurantName: 'La Cantina' } });
  const ownerY = y.data.token, codY = y.data.user && y.data.user.teamCode;
  check('otro local tiene otro código', CODIGO.test(codY || '') && codY !== codX);
  await req('/api/waiters', { method: 'POST', token: ownerX, body: { name: 'Carla', pin: '2468' } });
  await req('/api/waiters', { method: 'POST', token: ownerY, body: { name: 'Beto', pin: '2468' } });

  seccion('2. EL MOZO ENTRA CON EL CÓDIGO DEL LOCAL Y SU PIN');
  let r = await req('/waiter/login', { method: 'POST', body: { local: codX, pin: '2468' } });
  check('código + PIN → entra a SU local', r.status === 200 && r.data.restaurant.restaurantName === 'La Parrilla' && r.data.waiter.name === 'Carla', JSON.stringify(r.data).slice(0, 160));
  check('a la app del mozo no le llegan datos de la cuenta del dueño', r.data.restaurant && !('googleEmail' in r.data.restaurant) && !('hasPassword' in r.data.restaurant));
  r = await req('/waiter/login', { method: 'POST', body: { local: ' ' + codX.slice(0, 3).toLowerCase() + '-' + codX.slice(3).toLowerCase() + ' ', pin: '2468' } });
  check('en minúsculas, con espacios o guion también', r.status === 200);
  r = await req('/waiter/login', { method: 'POST', body: { local: codY, pin: '2468' } });
  check('mismo PIN en otro local: entra al otro local (no se mezclan)', r.status === 200 && r.data.restaurant.restaurantName === 'La Cantina');
  r = await req('/waiter/login', { method: 'POST', body: { email: `parrilla-${id}@test.local`, pin: '2468' } });
  check('las apps viejas (email + PIN) siguen entrando', r.status === 200 && r.data.restaurant.restaurantName === 'La Parrilla');
  r = await req('/waiter/login', { method: 'POST', body: { local: `PARRILLA-${id}@TEST.LOCAL`, pin: '2468' } });
  check('en el campo nuevo también sirve el email del restaurante', r.status === 200);
  r = await req('/waiter/login', { method: 'POST', body: { local: 'ZZZZZZ', pin: '2468' } });
  check('código que no existe → "no encontramos ese local"', r.status === 401 && r.data.error === 'local_not_found', JSON.stringify(r.data));
  r = await req('/waiter/login', { method: 'POST', body: { local: codX, pin: '9999' } });
  check('código bien, PIN mal → "PIN incorrecto"', r.status === 401 && r.data.error === 'invalid_pin', JSON.stringify(r.data));
  r = await req('/waiter/login', { method: 'POST', body: { local: `parrilla-${id}@test.local`, pin: '9999' } });
  check('con email no se revela si el email existe', r.status === 401 && r.data.error === 'invalid_credentials');

  seccion('3. DUEÑO QUE SE REGISTRA CON GOOGLE');
  const g1 = { sub: `g1-${id}`, email: `duena-${id}@gmail.com`, name: 'Ana' };
  const sg = await req('/auth/google', { method: 'POST', body: { credential: cred(g1), mode: 'signup' } });
  const ownerG = sg.data.token, codG = sg.data.user && sg.data.user.teamCode;
  check('alta con Google: local nuevo, con código', sg.status === 200 && sg.data.isNew === true && CODIGO.test(codG || ''), JSON.stringify(sg.data).slice(0, 160));
  check('el panel sabe que entra con Google y que no tiene contraseña', sg.data.user.hasGoogle === true && sg.data.user.hasPassword === false && sg.data.user.googleEmail === g1.email);
  r = await req('/auth/login', { method: 'POST', body: { email: g1.email, password: 'cualquiera' } });
  check('si intenta con contraseña: "entrá con Google" (antes: error del servidor)', r.status === 401 && r.data.error === 'use_google', `${r.status} ${JSON.stringify(r.data)}`);
  await req('/api/waiters', { method: 'POST', token: ownerG, body: { name: 'Dani', pin: '1357' } });
  r = await req('/waiter/login', { method: 'POST', body: { local: codG, pin: '1357' } });
  check('sus mozos entran con el código del local (no necesitan su Gmail)', r.status === 200 && r.data.waiter.name === 'Dani');
  r = await req('/waiter/login', { method: 'POST', body: { local: g1.email, pin: '1357' } });
  check('y también con su Gmail, como antes', r.status === 200);
  r = await req('/auth/google', { method: 'POST', body: { credential: cred(g1), mode: 'login' } });
  check('vuelve a entrar con Google al mismo local', r.status === 200 && r.data.isNew === false && r.data.user.id === sg.data.user.id);

  seccion('4. "INICIAR SESIÓN CON GOOGLE" NO CREA OTRO RESTAURANTE');
  const g2 = { sub: `g2-${id}`, email: `otra-${id}@gmail.com` };
  r = await req('/auth/google', { method: 'POST', body: { credential: cred(g2), mode: 'login' } });
  check('cuenta de Google sin restaurante → avisa, no crea', r.status === 404 && r.data.error === 'no_account' && r.data.email === g2.email, JSON.stringify(r.data));
  if (pool) {
    const n = (await pool.query('SELECT count(*)::int AS n FROM tenants WHERE email=$1 OR google_id=$2', [g2.email, g2.sub])).rows[0].n;
    check('en la base no apareció ningún local nuevo', n === 0, `locales=${n}`);
  }
  r = await req('/auth/google', { method: 'POST', body: { credential: cred(g2), mode: 'signup' } });
  check('si elige "crear mi restaurante", ahí sí se crea', r.status === 200 && r.data.isNew === true);
  const g3 = { sub: `g3-${id}`, email: `vieja-${id}@gmail.com` };
  r = await req('/auth/google', { method: 'POST', body: { credential: cred(g3) } });
  check('pantallas viejas (sin "mode") siguen funcionando como antes', r.status === 200 && r.data.isNew === true);
  r = await req('/auth/google', { method: 'POST', body: { credential: cred({ sub: 'x', email: 'x@gmail.com', invalido: true }), mode: 'login' } });
  check('token de Google inválido → 401 claro (antes: error del servidor)', r.status === 401 && r.data.error === 'invalid_credential', `${r.status} ${JSON.stringify(r.data)}`);

  seccion('5. VINCULAR GOOGLE AL LOCAL QUE YA EXISTE');
  const g4 = { sub: `g4-${id}`, email: `dueno-parrilla-${id}@gmail.com` };
  r = await req('/api/account/google', { method: 'POST', token: ownerX, body: { credential: cred(g4) } });
  check('el dueño de La Parrilla vincula su Gmail', r.status === 200 && r.data.user.hasGoogle === true && r.data.user.googleEmail === g4.email && r.data.user.hasPassword === true, JSON.stringify(r.data).slice(0, 160));
  r = await req('/auth/google', { method: 'POST', body: { credential: cred(g4), mode: 'login' } });
  check('desde la PC entra con Google a La Parrilla (no a uno nuevo)', r.status === 200 && r.data.user.id === x.data.user.id && r.data.isNew === false);
  const tokG4 = r.data.token;
  r = await req('/api/waiters', { token: tokG4 });
  check('ve a Carla, la moza que ya tenía', r.status === 200 && r.data.some(w => w.name === 'Carla'));
  r = await req('/waiter/login', { method: 'POST', body: { local: g4.email, pin: '2468' } });
  check('si un mozo usa ese Gmail, también entra a La Parrilla', r.status === 200 && r.data.restaurant.restaurantName === 'La Parrilla');
  r = await req('/auth/login', { method: 'POST', body: { email: `parrilla-${id}@test.local`, password: 'Secreta123' } });
  check('y con email y contraseña sigue entrando igual', r.status === 200 && r.data.user.id === x.data.user.id);
  r = await req('/api/account/google', { method: 'POST', token: ownerX, body: { credential: cred(g4) } });
  check('vincular dos veces la misma cuenta no rompe nada', r.status === 200);
  r = await req('/api/account/google', { method: 'POST', token: ownerX, body: { credential: cred({ sub: `g5-${id}`, email: `g5-${id}@gmail.com` }) } });
  check('no pisa otra cuenta de Google ya vinculada', r.status === 409 && r.data.error === 'otra_google_vinculada' && !!r.data.detail);
  r = await req('/api/account/google', { method: 'POST', token: ownerY, body: { credential: cred(g1) } });
  check('no se puede robar la cuenta de Google de un local en uso', r.status === 409 && r.data.error === 'google_en_otro_local' && /La Parrilla|Mi restaurante/.test(r.data.detail || '') === true, JSON.stringify(r.data));
  r = await req('/auth/google', { method: 'POST', body: { credential: cred(g1), mode: 'login' } });
  check('esa cuenta sigue entrando a su propio local', r.status === 200 && r.data.user.id === sg.data.user.id);
  r = await req('/api/account/google', { method: 'POST', token: ownerY, body: { credential: cred({ sub: 'z', email: 'z@gmail.com', invalido: true }) } });
  check('Google inválido al vincular → 400, NO 401 (el panel no cierra la sesión)', r.status === 400, `${r.status}`);
  const est = await req('/api/print-station/token', { method: 'POST', token: ownerX });
  r = await req('/api/account/google', { method: 'POST', token: est.data.token, body: { credential: cred({ sub: `g7-${id}`, email: `g7-${id}@gmail.com` }) } });
  check('el token de la PC de comandas no puede vincular cuentas', r.status === 403, `${r.status}`);

  if (pool) {
    seccion('6. EL QUE YA CAYÓ EN LA TRAMPA (restaurante vacío creado por error)');
    // Producción: un alta con Google queda 'pending' hasta dejar la tarjeta.
    const g6 = { sub: `g6-${id}`, email: `trampa-${id}@gmail.com` };
    const dup = await req('/auth/google', { method: 'POST', body: { credential: cred(g6), mode: 'signup' } });
    await pool.query("UPDATE tenants SET subscription_status='pending' WHERE id=$1", [dup.data.user.id]);
    r = await req('/api/account/google', { method: 'POST', token: ownerY, body: { credential: cred(g6) } });
    check('La Cantina vincula esa cuenta: se pasa del local vacío al suyo', r.status === 200 && r.data.user.googleEmail === g6.email, JSON.stringify(r.data).slice(0, 160));
    r = await req('/auth/google', { method: 'POST', body: { credential: cred(g6), mode: 'login' } });
    check('ahora Google entra a La Cantina', r.status === 200 && r.data.user.id === y.data.user.id);
    const quedo = (await pool.query('SELECT google_id FROM tenants WHERE id=$1', [dup.data.user.id])).rows[0];
    check('el local vacío no se borró (solo perdió el vínculo)', quedo && quedo.google_id === null);
    r = await req('/waiter/login', { method: 'POST', body: { local: g6.email, pin: '2468' } });
    check('un mozo que usa ese Gmail entra a La Cantina (no al local vacío)', r.status === 200 && r.data.restaurant.restaurantName === 'La Cantina', JSON.stringify(r.data).slice(0, 120));

    seccion('7. SI HAY DOS LOCALES POSIBLES, GANA EL VINCULADO');
    const gb = { sub: `gb-${id}`, email: `compartido-${id}@gmail.com` };
    const b = await req('/auth/register', { method: 'POST', body: { email: gb.email, password: 'Secreta123', restaurantName: 'Local B' } });
    const a = await req('/auth/register', { method: 'POST', body: { email: `local-a-${id}@test.local`, password: 'Secreta123', restaurantName: 'Local A' } });
    await req('/api/account/google', { method: 'POST', token: a.data.token, body: { credential: cred(gb) } });
    r = await req('/auth/google', { method: 'POST', body: { credential: cred(gb), mode: 'login' } });
    check('Google entra al local donde se vinculó (antes: uno al azar)', r.status === 200 && r.data.user.id === a.data.user.id && b.data.user.id !== a.data.user.id);

    seccion('8. LA BASE: LOCALES VIEJOS Y NUEVOS');
    const sinCodigo = (await pool.query('SELECT count(*)::int AS n FROM tenants WHERE team_code IS NULL')).rows[0].n;
    check('ningún local quedó sin código (también los que existían antes)', sinCodigo === 0, `sin código=${sinCodigo}`);
    const dist = (await pool.query('SELECT count(*)::int AS n, count(DISTINCT team_code)::int AS d FROM tenants')).rows[0];
    check('no hay dos locales con el mismo código', dist.n === dist.d, `${dist.n} locales / ${dist.d} códigos`);
    const ins = (await pool.query(`INSERT INTO tenants (email, password_hash, restaurant_name) VALUES ($1, 'x', 'Directo') RETURNING team_code`, [`directo-${id}@test.local`])).rows[0];
    check('cualquier alta nueva recibe código sola (también fuera de la API)', CODIGO.test(ins.team_code || ''), ins.team_code);
    await pool.query('DELETE FROM tenants WHERE email=$1', [`directo-${id}@test.local`]);
    const conNumeros = (await pool.query("SELECT count(*)::int AS n FROM tenants WHERE team_code !~ '[A-Z]'")).rows[0].n;
    check('todo código de local lleva alguna letra (no choca con los personales)', conNumeros === 0, `solo números=${conNumeros}`);
    const sinPersonal = (await pool.query('SELECT count(*)::int AS n FROM waiters WHERE staff_code IS NULL')).rows[0].n;
    check('todos los integrantes tienen código personal (también los que ya existían)', sinPersonal === 0, `sin código=${sinPersonal}`);
  }

  seccion('9. CÓDIGO PERSONAL DE CADA INTEGRANTE');
  const p = await req('/auth/register', { method: 'POST', body: { email: `pizzeria-${id}@test.local`, password: 'Secreta123', restaurantName: 'La Pizzería' } });
  const ownerP = p.data.token;
  const mozoP = await req('/api/waiters', { method: 'POST', token: ownerP, body: { name: 'Martín', role: 'Mozo', pin: '2580' } });
  const chefP = await req('/api/waiters', { method: 'POST', token: ownerP, body: { name: 'Rosa', role: 'Cocina', pin: '1470' } });
  const codM = mozoP.data.staffCode, codC = chefP.data.staffCode;
  check('al agregar a alguien se le genera un código de 6 números', /^\d{6}$/.test(codM || '') && /^\d{6}$/.test(codC || ''), `${codM} / ${codC}`);
  check('cada uno tiene el suyo', codM !== codC);
  const lista = await req('/api/waiters', { token: ownerP });
  check('el panel ve el código de cada integrante', lista.data.some(w => w.staffCode === codM) && lista.data.some(w => w.staffCode === codC));
  r = await req('/waiter/login', { method: 'POST', body: { local: codC, pin: '1470' } });
  check('con su código y su clave entra la persona correcta', r.status === 200 && r.data.waiter.name === 'Rosa' && r.data.restaurant.restaurantName === 'La Pizzería', JSON.stringify(r.data).slice(0, 120));
  r = await req('/waiter/login', { method: 'POST', body: { local: codM.slice(0, 3) + ' ' + codM.slice(3), pin: '2580' } });
  check('el código con espacio en el medio también sirve', r.status === 200 && r.data.waiter.name === 'Martín');
  r = await req('/waiter/login', { method: 'POST', body: { local: codM, pin: '1470' } });
  check('con la clave de OTRO no entra (cada código mira solo su clave)', r.status === 401 && r.data.error === 'invalid_pin', JSON.stringify(r.data));
  let inexistente = '100000';
  if (inexistente === codM || inexistente === codC) inexistente = '100001';
  r = await req('/waiter/login', { method: 'POST', body: { local: inexistente, pin: '2580' } });
  check('código que no existe → "no encontramos ese código"', r.status === 401 && r.data.error === 'codigo_no_encontrado', JSON.stringify(r.data));
  r = await req('/waiter/login', { method: 'POST', body: { local: p.data.user.teamCode, pin: '1470' } });
  check('el código del local + clave sigue funcionando', r.status === 200 && r.data.waiter.name === 'Rosa');
  r = await req('/api/waiters', { method: 'POST', token: ownerP, body: { name: 'Repetido', pin: '2580' } });
  check('no deja repetir la clave de otro del mismo local (y dice de quién es)', r.status === 409 && r.data.error === 'pin_en_uso' && /Martín/.test(r.data.detail || ''), JSON.stringify(r.data));
  r = await req('/api/waiters', { method: 'POST', token: ownerX, body: { name: 'Otro local', pin: '2580' } });
  check('en otro restaurante esa clave sí se puede usar', r.status === 200 && /^\d{6}$/.test(r.data.staffCode || ''));
  for (const mala of ['12', 'abcd', '1234567', '12 34']) {
    r = await req('/api/waiters', { method: 'POST', token: ownerP, body: { name: 'Mala', pin: mala } });
    if (r.status !== 400 || r.data.error !== 'pin_invalido') { check(`clave "${mala}" rechazada`, false, JSON.stringify(r.data)); break; }
  }
  check('la clave tiene que ser de 4 a 6 números', r.status === 400 && r.data.error === 'pin_invalido');
  r = await req('/api/waiters/' + chefP.data.id, { method: 'PUT', token: ownerP, body: { pin: '2580' } });
  check('al cambiar la clave tampoco deja usar la de otro', r.status === 409 && r.data.error === 'pin_en_uso');
  r = await req('/api/waiters/' + chefP.data.id, { method: 'PUT', token: ownerP, body: { pin: '1470', name: 'Rosa M.' } });
  check('volver a poner su propia clave sí se puede', r.status === 200 && r.data.name === 'Rosa M.');
  r = await req('/api/waiters/' + chefP.data.id, { method: 'PUT', token: ownerP, body: { pin: '3690' } });
  check('cambiar la clave no cambia el código', r.status === 200 && r.data.staffCode === codC);
  r = await req('/waiter/login', { method: 'POST', body: { local: codC, pin: '3690' } });
  check('entra con la clave nueva', r.status === 200);
  r = await req('/waiter/login', { method: 'POST', body: { local: codC, pin: '1470' } });
  check('y la vieja ya no sirve', r.status === 401);

  google.close();
  if (pool) await pool.end();
  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — código personal del equipo y dueño con Google\x1b[0m`
                         : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('💥', e); process.exit(1); });
