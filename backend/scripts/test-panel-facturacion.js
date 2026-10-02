// El panel del local, en un navegador real (Chromium), contra el backend real y
// un ARCA simulado: cobrar una mesa con Factura A a un monotributista, imprimir
// la factura, un corte de ARCA con reintento, y facturar después desde Reportes.
//
//   DATABASE_URL=postgres://... CHROMIUM_PATH=... node scripts/test-panel-facturacion.js
// Requiere playwright (NODE_PATH apuntando a una instalación) y Postgres.
'use strict';
process.env.PORT = '3197';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.SKIP_BILLING = '1';
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(1); }

const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');
const afip = require('../afip');
const { arcaSimulado, certificadoDePrueba } = require('./arca-simulado');
const arca = arcaSimulado();
afip._internals._setTransport(arca.transport);
require('../server.js');

const API = 'http://127.0.0.1:3197';
const FRONT = path.join(__dirname, '..', '..', 'frontend');
const SHOTS = process.env.GESTIVA_SHOTS || require('os').tmpdir();
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`)); };
const seccion = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
async function req(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data = {}; try { data = t ? JSON.parse(t) : {}; } catch (e) {}
  return { status: r.status, data };
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

(async () => {
  await new Promise(r => setTimeout(r, 1200));
  const srv = http.createServer((rq, rs) => {
    const p = decodeURIComponent(rq.url.split('?')[0]);
    if (p === '/gestiva-config.js') { rs.writeHead(200, { 'Content-Type': MIME['.js'] }); return rs.end(`window.API_URL='${API}';window.GOOGLE_CLIENT_ID='';`); }
    const f = path.join(FRONT, p);
    if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); return rs.end(); }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); rs.end(fs.readFileSync(f));
  });
  await new Promise(r => srv.listen(4630, '127.0.0.1', r));

  // --- Local configurado como Responsable Inscripto ---
  const email = `panel-${Date.now()}@test.local`;
  const reg = await req('/auth/register', { method: 'POST', body: { email, password: 'Secreta123', restaurantName: 'La Esquina' } });
  const T = reg.data.token, USER = reg.data.user;
  const c = certificadoDePrueba();
  await req('/api/fiscal-config', { method: 'PUT', token: T, body: { fiscalCondition: 'responsable_inscripto', fiscalCuit: '20111111112', fiscalRazonSocial: 'La Esquina SRL', fiscalDomicilio: 'Corrientes 900', fiscalPtoVta: 2, fiscalIngresosBrutos: '901-1', fiscalInicioActividades: '2021-05-10' } });
  await req('/api/fiscal-cert', { method: 'PUT', token: T, body: { cert: c.certPem, key: c.keyPem, env: 'homologacion' } });
  const prod = (await req('/api/products', { method: 'POST', token: T, body: { name: 'Milanesa', cat: 'Comida', price: 12100 } })).data;
  const mozo = (await req('/api/waiters', { method: 'POST', token: T, body: { name: 'Pepe', pin: '4545' } })).data;
  const mesas = (await req('/api/tables', { token: T })).data;
  await req('/api/cash/open', { method: 'POST', token: T, body: { openingAmount: 0 } });
  async function cargarMesa(m, qty) {
    await req('/api/open-tables', { method: 'POST', token: T, body: { tableId: m.id, waiterId: mozo.id } });
    await req('/api/open-tables/' + m.id, { method: 'PUT', token: T, body: { items: [{ productId: prod.id, qty, sentToKitchen: true }] } });
  }

  const browser = await chromium.launch({ args: ['--no-proxy-server'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('gestiva_token', t); localStorage.setItem('gestiva_user', JSON.stringify(u)); }, [T, USER]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('   [pageerror]', e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  seccion('1. COBRAR UNA MESA CON FACTURA A A UN MONOTRIBUTISTA');
  await cargarMesa(mesas[0], 2);    // 2 × 12.100 = 24.200
  await page.goto(`http://127.0.0.1:4630/app.html#/mesa/${mesas[0].id}`);
  await page.waitForSelector('text=Cobrar', { timeout: 15000 });
  await page.evaluate(() => chargeTable());
  await page.waitForSelector('#docFactura');
  await page.click('#docFactura');
  await page.waitForFunction(() => /Factura/.test((document.getElementById('facLetraInfo') || {}).textContent || ''));
  await page.selectOption('#facTipo', 'mono');
  const letraPrevia = await page.textContent('#facLetraInfo');
  check('el formulario anticipa "Se emite Factura A"', /Factura A/.test(letraPrevia), letraPrevia);
  check('pide el domicilio para la A', await page.isVisible('#facDomicilio'));
  await page.fill('#facDocNro', '27-22222222-8');
  await page.click('#btnConfirmCharge');
  await page.waitForTimeout(800);
  const sinNombre = await page.evaluate(() => !!document.getElementById('btnConfirmCharge'));
  check('sin razón social no cobra (la A la exige)', sinNombre);
  await page.fill('#facNombre', 'María Gómez');
  await page.fill('#facDomicilio', 'Mitre 55');
  await page.click('#btnConfirmCharge');
  await page.waitForSelector('#facturaEstado', { timeout: 15000 });
  await page.waitForTimeout(500);
  const estado = await page.textContent('#facturaEstado');
  check('se cobró y salió la Factura A con CAE', /Factura A emitida/.test(estado) && /CAE/.test(estado), estado.replace(/\s+/g, ' ').slice(0, 120));
  check('el botón ofrece imprimir la FACTURA', /Imprimir factura/.test(await page.textContent('#btnImprimirVenta')));
  const html = await page.evaluate(() => Comandera.invoiceHTML(window.__lastSale.invoice, { paper: 80 }));
  check('la factura a imprimir tiene CAE, receptor y leyenda 27.618', /CAE/.test(html) && /María Gómez/.test(html) && /27\.618/.test(html));
  await page.screenshot({ path: path.join(SHOTS, 'panel-cobro-factura.png') });
  await page.click('text=Listo');

  seccion('2. ARCA NO RESPONDE AL FACTURAR → REINTENTO');
  await cargarMesa(mesas[1], 1);
  await page.goto(`http://127.0.0.1:4630/app.html#/mesa/${mesas[1].id}`);
  await page.waitForSelector('text=Cobrar', { timeout: 15000 });
  await page.evaluate(() => chargeTable());
  await page.waitForSelector('#docFactura');
  await page.click('#docFactura');
  await page.waitForFunction(() => /Factura/.test((document.getElementById('facLetraInfo') || {}).textContent || ''));
  arca.st.cortarProxima = true;
  await page.click('#btnConfirmCharge');
  await page.waitForSelector('#facturaEstado', { timeout: 15000 });
  await page.waitForTimeout(500);
  const est2 = await page.textContent('#facturaEstado');
  check('el cobro queda registrado y avisa que ARCA no respondió', /ARCA no respondió/.test(est2), est2.replace(/\s+/g, ' ').slice(0, 140));
  check('ofrece reintentar', await page.isVisible('text=Reintentar factura'));
  const antes = arca.st.comprobantes.get('2|6').length;
  await page.click('text=Reintentar factura');
  await page.waitForFunction(() => /emitida/.test((document.getElementById('facturaEstado') || {}).textContent || ''), null, { timeout: 15000 });
  check('al reintentar, la factura aparece (recuperada de ARCA)', /Factura B emitida/.test(await page.textContent('#facturaEstado')));
  check('ARCA tiene UNA sola factura de esa venta', arca.st.comprobantes.get('2|6').length === antes);
  await page.click('text=Listo');

  seccion('3. VENTA SIN FACTURA → FACTURARLA DESPUÉS DESDE REPORTES');
  await cargarMesa(mesas[2], 3);
  await page.goto(`http://127.0.0.1:4630/app.html#/mesa/${mesas[2].id}`);
  await page.waitForSelector('text=Cobrar', { timeout: 15000 });
  await page.evaluate(() => chargeTable());
  await page.waitForSelector('#btnConfirmCharge');
  await page.click('#btnConfirmCharge');                       // solo ticket
  await page.waitForSelector('#facturaEstado', { timeout: 15000 });
  await page.click('text=Listo');
  await page.goto('http://127.0.0.1:4630/app.html#/reportes');
  await page.waitForSelector('text=Ventas y facturas', { timeout: 15000 });
  const filas = await page.$$eval('text=Facturar', els => els.length);
  check('la venta sin factura aparece con "Facturar"', filas >= 1, `botones=${filas}`);
  await page.screenshot({ path: path.join(SHOTS, 'panel-ventas-facturas.png'), fullPage: true });
  await page.click('button:has-text("Facturar")');
  await page.waitForSelector('#facTipo', { timeout: 10000 });
  await page.selectOption('#facTipo', 'cf_dni');
  await page.fill('#facDocNro', '30123456');
  await page.click('#btnEmitirFactura');
  await page.waitForFunction(() => /emitida/.test((document.getElementById('facturaEstado') || {}).textContent || ''), null, { timeout: 15000 });
  check('se factura desde Reportes', /Factura B emitida/.test(await page.textContent('#facturaEstado')));
  await page.click('text=Listo');
  await page.waitForTimeout(800);
  const badges = await page.$$eval('.badge.green', els => els.map(e => e.textContent));
  check('la lista muestra las 3 facturas emitidas', badges.length >= 3, badges.join(' | '));

  seccion('4. CAJA: ARQUEO DE EFECTIVO');
  await page.goto('http://127.0.0.1:4630/app.html#/caja');
  await page.waitForSelector('text=Efectivo en el cajón', { timeout: 15000 });
  check('la caja muestra "Efectivo en el cajón" y lo cobrado por método', await page.isVisible('text=Cobrado por método'));
  await page.click('button:has-text("Cerrar caja")');
  await page.waitForSelector('#closeAmt');
  check('el efectivo contado arranca vacío (hay que contar)', (await page.inputValue('#closeAmt')) === '');
  await page.click('#btnCloseCash');
  await page.waitForTimeout(400);
  check('sin escribir lo contado no cierra', await page.isVisible('#closeAmt'));

  await browser.close(); srv.close();
  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — el panel factura de punta a punta\x1b[0m`
                         : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
