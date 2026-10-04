// Descarga de la app de mozos, en Chromium emulando cada teléfono y con el
// service worker ACTIVO (la primera visita es la que fallaba):
//   - ninguna página se recarga sola ("aparece y desaparece")
//   - /descargar no pide usuario ni contraseña
//   - Android: instalación nativa con un toque (también si el aviso llega tarde)
//   - iPhone: los pasos correctos para Safari 26, Safari anterior y Chrome
//   - dentro de Instagram/Facebook: salir al navegador
//   - el panel muestra un QR que lleva a /descargar
//
//   CHROMIUM_PATH=... NODE_PATH=<playwright,jsqr,pngjs> node frontend/test-descarga.js
'use strict';
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const FRONT = __dirname;
const PORT = 4650;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`)); };
const seccion = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

const UA = {
  safari18:   'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  // iOS 26 congela la versión del sistema en 18_6; la real está en Version/26
  safari26:   'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeIOS:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  chromeIOSv: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/108.0.5359.112 Mobile/15E148 Safari/604.1',
  instaIOS:   'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.0.0.32.98 (iPhone14,3; iOS 17_5; es_AR)',
  // iPadOS se declara como Mac; se lo distingue por la pantalla táctil
  ipad:       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  android:    'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.70 Mobile Safari/537.36',
  androidWV:  'Mozilla/5.0 (Linux; Android 14; SM-A546E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Mobile Safari/537.36 Instagram 335.0.0.39.93 Android'
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.jpeg': 'image/jpeg', '.css': 'text/css' };
// Como Vercel con cleanUrls: /descargar → descargar.html
const RUTAS = { '/descargar': 'descargar.html', '/mozo': 'mozo.html', '/landing': 'landing.html', '/app': 'app.html' };

// Para simular un deploy nuevo: el sw.js cambia de contenido.
let SW_EXTRA = '';
function servidor() {
  return new Promise(res => {
    const srv = http.createServer((rq, rs) => {
      let p = decodeURIComponent(rq.url.split('?')[0]);
      if (p === '/gestiva-config.js') { rs.writeHead(200, { 'Content-Type': MIME['.js'] }); return rs.end("window.API_URL='http://127.0.0.1:1';window.GOOGLE_CLIENT_ID='';"); }
      if (RUTAS[p]) p = '/' + RUTAS[p];
      const f = path.join(FRONT, p);
      if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); return rs.end('no'); }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      rs.end(p === '/sw.js' && SW_EXTRA ? fs.readFileSync(f, 'utf8') + '\n' + SW_EXTRA : fs.readFileSync(f));
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const srv = await servidor();
  const browser = await chromium.launch({ args: ['--no-proxy-server'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  async function abrir(ua, ruta, extra) {
    const dev = /Android/.test(ua) ? devices['Pixel 7'] : devices['iPhone 13'];
    const ctx = await browser.newContext({ ...dev, userAgent: ua, ...(extra || {}) });   // service worker PERMITIDO
    const page = await ctx.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    const cargas = [];
    page.on('framenavigated', f => { if (f === page.mainFrame()) cargas.push(f.url()); });
    page.on('pageerror', e => console.log('    [pageerror]', e.message));
    await page.goto(BASE + ruta, { waitUntil: 'domcontentloaded' });
    return { ctx, page, cargas };
  }
  const textoGuia = (page) => page.evaluate(() => { const el = document.querySelector('.gv-ins'); return el && el.classList.contains('on') ? el.innerText.replace(/\s+/g, ' ') : null; });

  seccion('1. NINGUNA PÁGINA SE RECARGA SOLA (primera visita, service worker activo)');
  for (const [nombre, ua] of [['iPhone Chrome', UA.chromeIOS], ['iPhone Safari', UA.safari18], ['Android Chrome', UA.android]]) {
    for (const ruta of ['/mozo', '/descargar', '/landing']) {
      const { ctx, page, cargas } = await abrir(ua, ruta);
      await page.waitForTimeout(3500);
      const sw = await page.evaluate(() => !!navigator.serviceWorker.controller);
      check(`${nombre} ${ruta}: se carga una sola vez`, cargas.length === 1, `cargas=${cargas.length} (sw controlando: ${sw})`);
      await ctx.close();
    }
  }

  {
    // Pero cuando sale una versión nueva, la app del mozo SÍ se actualiza sola
    // (una única vez): así le llegan los arreglos sin reinstalar nada.
    const { ctx, page, cargas } = await abrir(UA.android, '/mozo');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 8000 });
    await page.waitForTimeout(500);
    const antes = cargas.length;
    SW_EXTRA = '// versión nueva ' + Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    SW_EXTRA = '';
    check('con una versión nueva publicada, la app del mozo se actualiza sola (una vez)', cargas.length - antes === 2, `cargas después del deploy=${cargas.length - antes} (esperado 2: la del mozo + la de la actualización)`);
    await ctx.close();
  }

  seccion('2. /descargar NO PIDE USUARIO NI CONTRASEÑA');
  {
    const { ctx, page } = await abrir(UA.chromeIOS, '/descargar');
    const campos = await page.$$eval('input', els => els.map(e => e.type));
    check('no hay ningún campo para completar', campos.length === 0, JSON.stringify(campos));
    check('hay un botón grande "Descargar app"', /Descargar app/.test(await page.textContent('#btnDescargar')));
    check('instala la app de MOZOS (manifest de /mozo)', await page.$eval('link[rel="manifest"]', l => l.getAttribute('href')) === 'manifest.json');
    await page.screenshot({ path: path.join(process.env.GESTIVA_SHOTS || require('os').tmpdir(), 'descargar-iphone.png') });
    await ctx.close();
  }

  seccion('3. ANDROID: INSTALACIÓN NATIVA CON UN TOQUE');
  {
    const { ctx, page } = await abrir(UA.android, '/descargar');
    await page.evaluate(() => {   // Chrome avisa que la app se puede instalar
      const ev = new Event('beforeinstallprompt');
      ev.prompt = () => { window.__dialogo = (window.__dialogo || 0) + 1; };
      ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    });
    await page.click('#btnDescargar');
    await page.waitForTimeout(400);
    check('el toque abre el diálogo "Instalar app" del teléfono', await page.evaluate(() => window.__dialogo) === 1);
    check('después muestra "¡Listo!" y el botón pasa a "Abrir la app"', await page.isVisible('#okMsg') && /Abrir la app/.test(await page.textContent('#btnDescargar')));
    check('no se abrió ninguna guía (fue directo)', (await textoGuia(page)) === null);
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.android, '/descargar');
    // El aviso de Chrome llega 0,8 s DESPUÉS del toque
    await page.evaluate(() => setTimeout(() => {
      const ev = new Event('beforeinstallprompt');
      ev.prompt = () => { window.__dialogo = 1; }; ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    }, 800));
    await page.click('#btnDescargar');
    check('mientras espera dice "Preparando..."', /Preparando/.test(await page.textContent('#btnDescargar')));
    await page.waitForTimeout(1500);
    check('si el aviso llega un poco tarde, igual instala directo', await page.evaluate(() => window.__dialogo) === 1);
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.android, '/descargar');
    // Chrome rechaza abrir el diálogo (p. ej. el toque ya "venció")
    await page.evaluate(() => {
      const ev = new Event('beforeinstallprompt');
      ev.prompt = () => Promise.reject(new DOMException('no user gesture', 'NotAllowedError'));
      ev.userChoice = new Promise(() => {});
      window.dispatchEvent(ev);
    });
    await page.click('#btnDescargar');
    await page.waitForTimeout(500);
    const g = await textoGuia(page);
    check('si Chrome no deja abrir el diálogo, muestra los pasos (no se queda sin hacer nada)', !!g && /Instalar app/.test(g), g && g.slice(0, 90));
    check('y el botón vuelve a decir "Descargar app"', /Descargar app/.test(await page.textContent('#btnDescargar')));
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.android, '/descargar');
    await page.click('#btnDescargar');
    await page.waitForTimeout(2600);
    const g = await textoGuia(page);
    check('si el teléfono no ofrece instalar, muestra los pasos con ⋮ → Instalar app', !!g && /Instalar app/.test(g) && /⋮/.test(g), g && g.slice(0, 90));
    await ctx.close();
  }

  seccion('4. IPHONE: LOS PASOS DE SU NAVEGADOR');
  {
    const { ctx, page } = await abrir(UA.safari26, '/descargar');
    await page.click('#btnDescargar'); await page.waitForTimeout(500);
    const g = await textoGuia(page);
    check('Safari de iOS 26: ⋯ → Compartir → Agregar a inicio', !!g && /···/.test(g) && /Compartir/.test(g) && /Agregar a inicio/.test(g) && /Abrir como app web/.test(g), g && g.slice(0, 120));
    await page.waitForTimeout(1500);
    check('la guía se queda en pantalla (no aparece y desaparece)', (await textoGuia(page)) !== null);
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.safari18, '/descargar');
    await page.click('#btnDescargar'); await page.waitForTimeout(500);
    const g = await textoGuia(page);
    check('Safari de iOS 18: Compartir en la barra de abajo → Agregar a inicio', !!g && /Compartir/.test(g) && /barra de abajo/.test(g) && !/al lado de la dirección/.test(g), g && g.slice(0, 120));
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.chromeIOS, '/descargar');
    await page.click('#btnDescargar'); await page.waitForTimeout(500);
    const g = await textoGuia(page);
    check('Chrome en iPhone: se instala desde Chrome (ya NO lo manda a Safari)', !!g && /barra de direcciones/.test(g) && /Agregar a inicio/.test(g) && !/Abrilo en Safari/.test(g), g && g.slice(0, 120));
    await page.screenshot({ path: path.join(process.env.GESTIVA_SHOTS || require('os').tmpdir(), 'descargar-chrome-iphone-guia.png') });
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ ...devices['iPad Mini'], userAgent: UA.ipad });
    const page = await ctx.newPage(); await page.route(/fonts\./, r => r.abort());
    await page.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }));
    await page.goto(BASE + '/descargar', { waitUntil: 'domcontentloaded' });
    await page.click('#btnDescargar'); await page.waitForTimeout(500);
    const g = await textoGuia(page) || '';
    check('iPad (se declara Mac): pasos del iPad, Compartir arriba a la derecha', /en tu iPad/.test(g) && /arriba a la derecha/.test(g) && /Agregar a inicio/.test(g) && !/barra de abajo/.test(g), g.slice(0, 120));
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.chromeIOSv, '/descargar');
    await page.click('#btnDescargar'); await page.waitForTimeout(500);
    check('Chrome en un iPhone viejo (iOS 16.2): "Abrilo en Safari"', /Abrilo en Safari/.test((await textoGuia(page)) || ''));
    await ctx.close();
  }

  seccion('5. DENTRO DE INSTAGRAM / FACEBOOK');
  {
    const { ctx, page } = await abrir(UA.instaIOS, '/descargar');
    await page.click('#btnDescargar'); await page.waitForTimeout(500);
    const g = await textoGuia(page) || '';
    check('iPhone: "Abrilo en Safari" con el link para copiar', /Abrilo en Safari/.test(g) && /Copiar el link/.test(g));
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.androidWV, '/descargar');
    await page.click('#btnDescargar'); await page.waitForTimeout(500);
    check('Android: "Abrilo en Chrome"', /Abrilo en Chrome/.test((await textoGuia(page)) || ''));
    await ctx.close();
  }

  seccion('6. YA INSTALADA');
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], userAgent: UA.safari18, serviceWorkers: 'block' });
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    const page = await ctx.newPage(); await page.route(/fonts\./, r => r.abort());
    await page.goto(BASE + '/descargar');
    await page.waitForTimeout(800);
    check('abierta desde el ícono va directo a la app (/mozo)', /\/mozo$/.test(page.url()), page.url());
    await ctx.close();
  }

  seccion('7. LANDING Y PANEL: TODOS LOS BOTONES LLEVAN A /descargar');
  {
    const { ctx, page } = await abrir(UA.chromeIOS, '/landing');
    const hrefs = await page.$$eval('a', as => as.filter(a => /mozo|equipo/i.test(a.textContent)).map(a => a.textContent.trim().replace(/\s+/g, ' ') + ' → ' + a.getAttribute('href')));
    check('"Descargar app de mozos" → /descargar', hrefs.some(h => /Descargar app de mozos → \/descargar/.test(h)), hrefs.join(' | '));
    check('ningún botón de descarga manda al login (/mozo)', !hrefs.some(h => /Descargar|Instalar/.test(h) && /→ \/?mozo/.test(h)), hrefs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page } = await abrir(UA.android, '/landing');
    await page.click('#dlInstallBtn');
    await page.waitForTimeout(2600);
    check('"Instalar Gestiva" ya no manda al registro (usuario y contraseña)', !/signup/.test(page.url()), page.url());
    await ctx.close();
  }
  {
    // Panel del dueño con la sesión de demo (no necesita backend).
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('gestiva_token', 'gestiva_demo_token');
      localStorage.setItem('gestiva_user', JSON.stringify({ id: 'demo', email: 'demo@gestiva.app', restaurantName: 'Demo', currency: '$', subscriptionStatus: 'active' }));
    });
    const page = await ctx.newPage(); await page.route(/fonts\./, r => r.abort());
    page.on('pageerror', e => console.log('    [pageerror]', e.message));
    await page.goto(BASE + '/app.html#/mozos', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Descargar la app en el celular del equipo', { timeout: 8000 }).catch(() => {});
    const url = await page.evaluate(() => teamAppUrl());
    check('"Copiar link" del panel comparte /descargar', /\/descargar$/.test(url), url);
    const leerQR = async (sel) => {
      const el = await page.$(sel);
      if (!el) return 'no hay QR';
      const png = await el.screenshot();
      try {
        const jsQR = require('jsqr'); const { PNG } = require('pngjs');
        const img = PNG.sync.read(png);
        const r = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
        return r ? r.data : 'no se pudo leer';
      } catch (e) { return 'sin jsqr: ' + e.message; }
    };
    check('la pantalla Equipo muestra un QR que lleva a /descargar', (await leerQR('#view svg[aria-label*="QR"]')) === url);
    const wa = await page.$eval('#view a[href^="https://wa.me/"]', a => decodeURIComponent(a.href)).catch(() => '');
    check('"Enviar por WhatsApp" manda el link de /descargar', wa.includes(url), wa);
    await page.evaluate(() => downloadTeamApk());
    await page.waitForTimeout(300);
    check('"Instalar en celular" abre el QR (ya no baja un .apk inexistente)', (await leerQR('.modal svg[aria-label*="QR"], [class*=modal] svg[aria-label*="QR"]')) === url);
    if (process.env.GESTIVA_SHOTS) await page.screenshot({ path: path.join(process.env.GESTIVA_SHOTS, 'panel-qr-descarga.png') });
    await ctx.close();
  }
  {
    // "Instalar Gestiva" del panel en un iPhone: solo la guía, sin alert encima
    const ctx = await browser.newContext({ ...devices['iPhone 13'], userAgent: UA.chromeIOS, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('gestiva_token', 'gestiva_demo_token');
      localStorage.setItem('gestiva_user', JSON.stringify({ id: 'demo', email: 'demo@gestiva.app', restaurantName: 'Demo', currency: '$', subscriptionStatus: 'active' }));
    });
    const page = await ctx.newPage(); await page.route(/fonts\./, r => r.abort());
    let alertas = 0;
    page.on('dialog', d => { alertas++; d.dismiss().catch(() => {}); });
    await page.goto(BASE + '/app.html#/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById('installBtn').click());
    await page.waitForTimeout(600);
    const g = await textoGuia(page) || '';
    check('panel en iPhone: "Instalar Gestiva" muestra los pasos, sin un alert encima', alertas === 0 && /Agregar a inicio/.test(g), `alerts=${alertas}`);
    await ctx.close();
  }
  {
    const vercel = JSON.parse(fs.readFileSync(path.join(FRONT, '..', 'vercel.json'), 'utf8'));
    const apk = vercel.redirects.find(r => r.source === '/assets/gestiva-equipo.apk');
    check('el link viejo del .apk lleva a /descargar (antes al login)', apk && apk.destination === '/descargar');
  }

  await browser.close(); srv.close();
  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — descarga directa en Android e iPhone\x1b[0m`
                         : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
