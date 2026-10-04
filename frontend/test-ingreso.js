// Ingreso en el navegador (Chromium), contra el backend real:
//   - app del mozo: código del local precargado desde el link/QR, recordado en
//     el celular, y mensajes claros si algo está mal
//   - /descargar?local=...: muestra el código y lo pasa a la app
//   - panel: código en Equipo (QR y WhatsApp lo llevan) y "Cuenta y acceso"
//     en Ajustes, con el botón para vincular Google
//   - login del dueño y cocina con Google: no crean otro restaurante
// El botón de Google se simula (no hay cuentas reales en la prueba).
//
//   Backend con GOOGLE_CLIENT_ID=test-client GOOGLE_TOKENINFO_URL=http://127.0.0.1:4799/tokeninfo
//   GESTIVA_API=http://127.0.0.1:3199 CHROMIUM_PATH=... NODE_PATH=<playwright,jsqr,pngjs> node frontend/test-ingreso.js
'use strict';
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const FRONT = __dirname;
const API = process.env.GESTIVA_API || 'http://127.0.0.1:3100';
const PORT = 4660;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`)); };
const seccion = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.jpeg': 'image/jpeg', '.css': 'text/css' };
const RUTAS = { '/descargar': 'descargar.html', '/mozo': 'mozo.html', '/app': 'app.html', '/cocina': 'cocina.html', '/login': 'login.html' };

function servidor() {
  return new Promise(res => {
    const srv = http.createServer((rq, rs) => {
      let p = decodeURIComponent(rq.url.split('?')[0]);
      if (p === '/gestiva-config.js') {
        rs.writeHead(200, { 'Content-Type': MIME['.js'] });
        return rs.end(`window.API_URL='${API}';window.GOOGLE_CLIENT_ID='test-client';`);
      }
      if (RUTAS[p]) p = '/' + RUTAS[p];
      const f = path.join(FRONT, p);
      if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); return rs.end('no'); }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); rs.end(fs.readFileSync(f));
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

// Google de mentira, del lado del backend (verifica el "credential")…
const cred = (o) => Buffer.from(JSON.stringify({ aud: 'test-client', email_verified: 'true', ...o })).toString('base64url');
function googleFalso() {
  return new Promise((res) => {
    const srv = http.createServer((rq, rs) => {
      try {
        const info = JSON.parse(Buffer.from(new URL(rq.url, 'http://x').searchParams.get('id_token') || '', 'base64url').toString());
        rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(info));
      } catch (e) { rs.writeHead(400); rs.end('{}'); }
    });
    srv.listen(4799, '127.0.0.1', () => res(srv));
  });
}
// …y del lado del navegador: reemplaza la librería de Google y guarda a quién
// avisar cuando "el usuario elige su cuenta".
const GSI_FALSO = () => {
  window.__gsi = { callback: null, botones: 0 };
  window.google = { accounts: { id: {
    initialize: (o) => { window.__gsi.callback = o.callback; },
    renderButton: (el) => { window.__gsi.botones++; el.innerHTML = '<button type="button" class="g-falso">Continuar con Google</button>'; },
    prompt: () => {}
  } } };
};
const elegirCuentaGoogle = (page, c) => page.evaluate((c) => window.__gsi.callback({ credential: c }), c);

async function req(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  const srv = await servidor();
  const google = await googleFalso();
  const browser = await chromium.launch({ args: ['--no-proxy-server'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const id = Date.now();
  const nuevo = async (extra) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', ...(extra || {}) });
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com|accounts\.google\.com/, r => r.abort());
    page.on('pageerror', e => console.log('    [pageerror]', e.message));
    return { ctx, page };
  };

  // Local con email y contraseña, y una moza con PIN
  const reg = await req('/auth/register', { method: 'POST', body: { email: `bodegon-${id}@test.local`, password: 'Secreta123', restaurantName: 'El Bodegón' } });
  const owner = reg.data.token, user = reg.data.user, COD = user.teamCode;
  await req('/api/waiters', { method: 'POST', token: owner, body: { name: 'Lucía', pin: '4826' } });

  seccion('1. APP DEL MOZO: ENTRA CON EL CÓDIGO DEL LOCAL');
  {
    const { ctx, page } = await nuevo(devices['iPhone 13']);
    await page.goto(`${BASE}/mozo?local=${COD}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#local');
    const label = await page.textContent('label[for="local"]');
    check('el campo dice "Código del local" (ya no "Email del restaurante")', /Código del local/.test(label) && !(await page.$('label[for="email"]')));
    check('el link del panel deja el código ya cargado', (await page.inputValue('#local')) === COD);
    await page.fill('#pin', '4826');
    await page.click('#loginBtn');
    await page.waitForSelector('#appScreen', { state: 'visible', timeout: 8000 }).catch(() => {});
    check('con solo el PIN entra a su local', (await page.textContent('#restaurantName')).trim() === 'El Bodegón');
    await page.evaluate(() => logout());
    await page.waitForTimeout(200);
    check('al salir, el código queda recordado en el celular (el próximo solo pone su PIN)', (await page.inputValue('#local')) === COD && (await page.inputValue('#pin')) === '');
    await page.fill('#pin', '0000'); await page.click('#loginBtn'); await page.waitForTimeout(600);
    check('PIN mal → "PIN incorrecto"', /PIN incorrecto/.test(await page.textContent('#loginErr')), await page.textContent('#loginErr'));
    await page.fill('#local', 'QQQQQQ'); await page.fill('#pin', '4826'); await page.click('#loginBtn'); await page.waitForTimeout(600);
    check('código mal → "No encontramos ningún local con ese código"', /No encontramos ningún local/.test(await page.textContent('#loginErr')));
    await page.fill('#local', `bodegon-${id}@test.local`); await page.click('#loginBtn');
    await page.waitForSelector('#appScreen', { state: 'visible', timeout: 8000 }).catch(() => {});
    check('el email del restaurante también sirve (como antes)', (await page.textContent('#restaurantName')).trim() === 'El Bodegón');
    if (process.env.GESTIVA_SHOTS) {
      await page.evaluate(() => logout()); await page.fill('#local', ''); await page.goto(`${BASE}/mozo?local=${COD}`); await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(process.env.GESTIVA_SHOTS, 'mozo-login-codigo.png') });
    }
    await ctx.close();
  }

  seccion('2. DESCARGA CON EL CÓDIGO');
  {
    const { ctx, page } = await nuevo(devices['Pixel 7']);
    await page.goto(`${BASE}/descargar?local=${COD}`, { waitUntil: 'domcontentloaded' });
    check('la página de descarga muestra el código del local', (await page.isVisible('#codigoLocal')) && (await page.textContent('#codigoTxt')) === COD);
    check('"Abrir la app" lo lleva cargado', (await page.getAttribute('#linkAbrir', 'href')) === `/mozo?local=${COD}`);
    if (process.env.GESTIVA_SHOTS) await page.screenshot({ path: path.join(process.env.GESTIVA_SHOTS, 'descargar-codigo.png') });
    await page.goto(`${BASE}/mozo`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#local');
    check('la app instalada (abre en /mozo, sin el link) ya tiene el código', (await page.inputValue('#local')) === COD);
    await ctx.close();
  }
  {
    const { ctx, page } = await nuevo({ ...devices['iPhone 13'] });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await page.goto(`${BASE}/descargar?local=${COD}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    check('abierta desde el ícono va a la app con el código', page.url().endsWith(`/mozo?local=${COD}`), page.url());
    await ctx.close();
  }

  seccion('3. PANEL: EL CÓDIGO EN EQUIPO Y "CUENTA Y ACCESO"');
  {
    const { ctx, page } = await nuevo({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('gestiva_token', t); localStorage.setItem('gestiva_user', JSON.stringify(u)); }, [owner, user]);
    await ctx.addInitScript(GSI_FALSO);
    await page.goto(`${BASE}/app.html#/mozos`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.team-code', { timeout: 10000 }).catch(() => {});
    check('Equipo muestra el código del local bien grande', ((await page.textContent('#view .team-code').catch(() => '')) || '').trim() === COD);
    check('y explica que los mozos no necesitan el email ni la cuenta de Google', /No necesitan tu email ni tu cuenta de Google/.test(await page.textContent('#view')));
    const url = await page.evaluate(() => teamAppUrl());
    check('el link y el QR llevan el código (/descargar?local=...)', url.endsWith(`/descargar?local=${COD}`), url);
    let leido = null;
    try {
      const jsQR = require('jsqr'); const { PNG } = require('pngjs');
      const img = PNG.sync.read(await (await page.$('#view svg[aria-label*="QR"]')).screenshot());
      const r = jsQR(new Uint8ClampedArray(img.data), img.width, img.height); leido = r && r.data;
    } catch (e) { leido = 'sin jsqr: ' + e.message; }
    check('el QR escaneado da ese link', leido === url, String(leido));
    const wa = decodeURIComponent(await page.getAttribute('#view a[href^="https://wa.me/"]', 'href'));
    check('el WhatsApp para el mozo incluye el código del local', wa.includes(`Código del local: ${COD}`) && wa.includes(url));
    if (process.env.GESTIVA_SHOTS) await page.screenshot({ path: path.join(process.env.GESTIVA_SHOTS, 'panel-equipo-codigo.png') });

    await page.goto(`${BASE}/app.html#/ajustes`); await page.waitForSelector('#cuentaCard', { timeout: 10000 }).catch(() => {});
    const card = (await page.textContent('#cuentaCard').catch(() => '')) || '';
    check('Ajustes → "Cuenta y acceso": con qué entra el dueño y el código de los mozos', /Email y contraseña/.test(card) && card.includes(COD), card.replace(/\s+/g, ' ').slice(0, 160));
    check('ofrece vincular Google (botón de Google en la tarjeta)', await page.evaluate(() => window.__gsi.botones > 0 && !!document.querySelector('#gLinkBtn .g-falso')));
    const g = { sub: `pc-${id}`, email: `bodegon.pc.${id}@gmail.com` };
    await elegirCuentaGoogle(page, cred(g));
    await page.waitForFunction(() => /Google/.test((document.querySelector('#cuentaCard') || {}).textContent || '') && !document.querySelector('#gLinkBtn'), null, { timeout: 8000 }).catch(() => {});
    const card2 = (await page.textContent('#cuentaCard').catch(() => '')) || '';
    check('al elegir la cuenta queda vinculada a ESTE restaurante', card2.includes(g.email) && !(await page.$('#gLinkBtn')), card2.replace(/\s+/g, ' ').slice(0, 200));
    if (process.env.GESTIVA_SHOTS) await (await page.$('#cuentaCard')).screenshot({ path: path.join(process.env.GESTIVA_SHOTS, 'ajustes-cuenta.png') });
    const r = await req('/auth/google', { method: 'POST', body: { credential: cred(g), mode: 'login' } });
    check('desde ahí, Google entra al mismo local (no a uno vacío)', r.status === 200 && r.data.user.id === user.id);
    check('la sesión del panel siguió abierta', /app\.html/.test(page.url()));
    await ctx.close();
  }

  seccion('4. LOGIN DEL DUEÑO');
  const gNueva = { sub: `nueva-${id}`, email: `nueva.${id}@gmail.com` };
  {
    const { ctx, page } = await nuevo({ viewport: { width: 1100, height: 900 } });
    await ctx.addInitScript(GSI_FALSO);
    await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gsi && window.__gsi.callback, null, { timeout: 8000 });
    await elegirCuentaGoogle(page, cred(gNueva));
    await page.waitForSelector('#sinCuenta.on', { timeout: 6000 }).catch(() => {});
    const aviso = (await page.textContent('#sinCuenta').catch(() => '')) || '';
    check('Google con una cuenta sin restaurante: avisa en vez de crear uno', /No hay ningún restaurante registrado/.test(aviso) && aviso.includes(gNueva.email), aviso.slice(0, 120));
    check('explica cómo vincularla al restaurante que ya tiene', /Ajustes → Cuenta y acceso/.test(aviso));
    const r = await req('/auth/google', { method: 'POST', body: { credential: cred(gNueva), mode: 'login' } });
    check('y no se creó nada', r.status === 404);
    if (process.env.GESTIVA_SHOTS) await page.screenshot({ path: path.join(process.env.GESTIVA_SHOTS, 'login-sin-cuenta.png') });
    await page.click('#btnCrearConGoogle');
    await page.waitForURL(/onboarding\.html/, { timeout: 8000 }).catch(() => {});
    check('"Es mi primera vez" sí lo crea y sigue al alta (nombre del negocio)', /onboarding\.html/.test(page.url()), page.url());
    await ctx.close();
  }
  {
    const { ctx, page } = await nuevo();
    await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#email', gNueva.email); await page.fill('#password', 'loquesea');
    await page.click('#btn'); await page.waitForTimeout(800);
    check('con contraseña en una cuenta de Google: "entrá con Google" (antes: error)', /se creó con Google/.test(await page.textContent('#err')), await page.textContent('#err'));
    await ctx.close();
  }

  seccion('5. PANTALLA DE COCINA');
  {
    const { ctx, page } = await nuevo({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(GSI_FALSO);
    await page.goto(`${BASE}/cocina`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gsi && window.__gsi.callback, null, { timeout: 8000 }).catch(() => {});
    check('tiene el botón de Google (antes solo email y contraseña)', await page.evaluate(() => !!document.querySelector('#gBtn .g-falso')));
    await elegirCuentaGoogle(page, cred({ sub: `pc-${id}`, email: `bodegon.pc.${id}@gmail.com` }));
    await page.waitForSelector('#appView', { state: 'visible', timeout: 8000 }).catch(() => {});
    check('el dueño entra a la cocina con Google, a su restaurante', await page.isVisible('#appView'));
    await ctx.close();
  }
  {
    const { ctx, page } = await nuevo();
    await ctx.addInitScript(GSI_FALSO);
    await page.goto(`${BASE}/cocina`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gsi && window.__gsi.callback, null, { timeout: 8000 }).catch(() => {});
    const desconocida = { sub: `coc-${id}`, email: `coc.${id}@gmail.com` };
    await elegirCuentaGoogle(page, cred(desconocida));
    await page.waitForTimeout(700);
    check('una cuenta de Google sin restaurante: lo dice y no crea nada', /No hay ningún restaurante/.test(await page.textContent('#loginErr')) &&
      (await req('/auth/google', { method: 'POST', body: { credential: cred(desconocida), mode: 'login' } })).status === 404);
    await page.fill('#loginEmail', gNueva.email); await page.fill('#loginPass', 'x'); await page.click('#loginBtn'); await page.waitForTimeout(700);
    check('con contraseña en una cuenta de Google: "entrá con Google"', /se creó con Google/.test(await page.textContent('#loginErr')));
    await ctx.close();
  }

  await browser.close(); srv.close(); google.close();
  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — ingreso con código del local y con Google\x1b[0m`
                         : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
