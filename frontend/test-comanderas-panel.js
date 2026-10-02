// Comanderas en el panel (sin tocar la conexión): lo que ve el mozo coincide con
// dónde imprime, aviso de comanderas que no recibirían pedidos, pie del ticket
// de barra, y que una sesión vencida no borre la configuración de la PC.
//   GESTIVA_API=http://127.0.0.1:3100 NODE_PATH=<playwright> node frontend/test-comanderas-panel.js
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const API = process.env.GESTIVA_API || 'http://127.0.0.1:3100', FRONT = __dirname;
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`)); };
const req = async (p, { method = 'GET', body, token } = {}) => { const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
(async () => {
  const email = `cmd-${Date.now()}@t.local`;
  const reg = (await req('/auth/register', { method: 'POST', body: { email, password: 'Secreta123', restaurantName: 'Comanderas' } })).data;
  const srv = http.createServer((rq, rs) => { const p = rq.url.split('?')[0];
    if (p === '/gestiva-config.js') { rs.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8'}); return rs.end(`window.API_URL='${API}';`); }
    const f = path.join(FRONT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); return rs.end(); }
    rs.writeHead(200, {'Content-Type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'}); rs.end(fs.readFileSync(f)); });
  await new Promise(r => srv.listen(4632, '127.0.0.1', r));
  const b = await chromium.launch({ args: ['--no-proxy-server'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const ctx = await b.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('gestiva_token', t); localStorage.setItem('gestiva_user', JSON.stringify(u)); }, [reg.token, reg.user]);
  const pg = await ctx.newPage(); await pg.route(/fonts\./, r => r.abort());
  pg.on('pageerror', e => console.log('   [pageerror]', e.message));
  await pg.goto('http://127.0.0.1:4632/app.html#/dashboard'); await pg.waitForTimeout(2500);

  console.log('\n\x1b[1m1. COCINA + BARRA DE RED: LO QUE VE EL MOZO SE SINCRONIZA\x1b[0m');
  const antes = (await req('/auth/me', { token: reg.token })).data.user;
  check('al principio el local no tiene barra', !antes.hasBarStation);
  const toasts = await pg.evaluate(async () => {
    const st = [
      { id: 'a', name: 'Cocina', method: 'network', printerIp: '192.168.1.200', printerPort: 9100, route: 'resto', categories: 'Bebidas,Tragos', receipts: true },
      { id: 'b', name: 'Bar', method: 'network', printerIp: '192.168.1.201', printerPort: 9100, route: 'solo', categories: 'Bebidas, Tragos', receipts: false }
    ];
    Comandera.saveStations(st, { kitchenAuto: true });
    const vistos = []; const orig = window.toast; window.toast = (m, t) => { vistos.push(m); return orig(m, t); };
    await window.onComanderaSaved(Comandera.getCfg());
    await new Promise(r => setTimeout(r, 200));
    window.toast = orig; return vistos;
  });
  const despues = (await req('/auth/me', { token: reg.token })).data.user;
  check('el local queda con barra', despues.hasBarStation === true);
  check('con las categorías de la comandera de barra', despues.barCategories === 'Bebidas,Tragos', despues.barCategories);
  check('se le avisa al dueño', toasts.some(t => /mozos ahora muestra/.test(t)), JSON.stringify(toasts));
  check('sin avisos de comanderas mudas', !toasts.some(t => /no va a recibir|no van a recibir/.test(t)));

  console.log('\n\x1b[1m2. UNA TERCERA COMANDERA QUE NO RECIBIRÍA NADA\x1b[0m');
  const t2 = await pg.evaluate(async () => {
    const cfg = Comandera.getCfg();
    const st = cfg.stations.concat([{ id: 'c', name: 'Parrilla', method: 'network', printerIp: '192.168.1.202', printerPort: 9100, route: 'solo', categories: 'Carnes', receipts: false }]);
    Comandera.saveStations(st, { kitchenAuto: true });
    const vistos = []; const orig = window.toast; window.toast = (m, t) => { vistos.push(m); return orig(m, t); };
    await window.onComanderaSaved(Comandera.getCfg());
    window.toast = orig; return vistos;
  });
  check('avisa que "Parrilla" no va a recibir pedidos', t2.some(t => /Parrilla no va a recibir/.test(t)), JSON.stringify(t2));
  const t3 = await pg.evaluate(async () => {
    const cfg = Comandera.getCfg();
    const st = cfg.stations.map(x => x.id === 'c' ? Object.assign({}, x, { name: 'Caja', route: 'todo', receipts: true }) : x);
    Comandera.saveStations(st, { kitchenAuto: true });
    const vistos = []; const orig = window.toast; window.toast = (m, t) => { vistos.push(m); return orig(m, t); };
    await window.onComanderaSaved(Comandera.getCfg());
    window.toast = orig; return vistos;
  });
  check('una comandera de caja (comprobantes) NO dispara el aviso', !t3.some(t => /no va a recibir/.test(t)), JSON.stringify(t3));

  console.log('\n\x1b[1m3. EL TICKET DE BARRA DICE BARRA\x1b[0m');
  const pies = await pg.evaluate(() => {
    const t = { restaurant: 'X', table: 4, items: [{ name: 'Fernet', qty: 2, cat: 'Tragos' }], datetime: new Date() };
    const multi = Comandera.ticketHTML(t, Object.assign(Comandera.getCfg(), { _nameSuffix: 'BAR' }));
    const solo = Comandera.ticketHTML(t, Object.assign(Comandera.getCfg(), { _nameSuffix: '' }));
    const bytes = Comandera.escpos(t, Object.assign(Comandera.getCfg(), { _nameSuffix: 'BAR' }));
    return { multi: /-- BAR --/.test(multi), solo: /-- COCINA --/.test(solo), esc: /-- BAR --/.test(new TextDecoder().decode(bytes)) };
  });
  check('con varias comanderas, el ticket de barra dice "-- BAR --"', pies.multi && pies.esc);
  check('con una sola comandera sigue diciendo "-- COCINA --"', pies.solo);

  console.log('\n\x1b[1m4. LA SESIÓN VENCIDA NO BORRA LAS COMANDERAS\x1b[0m');
  const sobrevive = await pg.evaluate(async () => {
    const n = Comandera.getStations().length;
    try { await api('/api/cash', { headers: { Authorization: 'Bearer token-vencido' } }); } catch (e) {}
    return { antes: n, despues: JSON.parse(localStorage.getItem('gestiva_comandera_cfg') || '{}').stations?.length || 0, token: localStorage.getItem('gestiva_token') };
  });
  check('tras un 401 la lista de comanderas sigue ahí', sobrevive.despues === sobrevive.antes && sobrevive.antes === 3, JSON.stringify(sobrevive));
  check('y la sesión sí se cerró', sobrevive.token === null);

  await b.close(); srv.close();
  console.log(`\n${'─'.repeat(52)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — comanderas: barra sincronizada y avisos\x1b[0m` : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
