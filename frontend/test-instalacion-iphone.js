// Verifica el flujo de instalación en iPhone emulando Safari, el navegador
// interno de Instagram y Chrome iOS.  Requiere playwright:
//   npx playwright install chromium && node frontend/test-instalacion-iphone.js
// Prueba el flujo de instalación emulando iPhone real (Safari, y el navegador
// interno de Instagram, que es como llega el link por WhatsApp/redes).
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const FRONT = __dirname;
const PORT = 4610;
const OUT = process.env.GESTIVA_SHOTS || require('os').tmpdir();

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`)); };
const seccion = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.css':'text/css', '.jpeg':'image/jpeg' };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((rq, rs) => {
      const p = decodeURIComponent(rq.url.split('?')[0]);
      if (p === '/gestiva-config.js') { rs.writeHead(200, {'Content-Type':'text/javascript'}); return rs.end("window.API_URL='http://127.0.0.1:1';window.GOOGLE_CLIENT_ID='';"); }
      const f = path.join(FRONT, p === '/' ? 'index.html' : p);
      if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); return rs.end('no'); }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      rs.end(fs.readFileSync(f));
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

const UA_SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_INSTAGRAM  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.0.0.32.98 (iPhone14,3; iOS 17_5; en_US)';
const UA_CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1';

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({ args: ['--no-proxy-server'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });

  async function abrir(ua, pagina) {
    const ctx = await browser.newContext({
      ...devices['iPhone 13'],
      userAgent: ua,
      serviceWorkers: 'block'   // el SW no aporta nada acá y recarga la página
    });
    const page = await ctx.newPage();
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await page.route('https://fonts.gstatic.com/**', r => r.abort());
    await page.goto(`http://127.0.0.1:${PORT}/${pagina}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    return { ctx, page };
  }

  seccion('1. META TAGS DE iOS EN LA APP DEL MOZO');
  {
    const { ctx, page } = await abrir(UA_SAFARI_IOS, 'mozo.html');
    const meta = await page.evaluate(() => ({
      capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
      titulo: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
      icono: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      theme: document.querySelector('meta[name="theme-color"]')?.content
    }));
    check('apple-mobile-web-app-capable presente (abre a pantalla completa)', meta.capable === 'yes', String(meta.capable));
    check('el ícono lleva nombre corto, no el título largo', meta.titulo === 'Gestiva Equipo', String(meta.titulo));
    check('ícono de home screen definido', !!meta.icono);
    check('manifest enlazado', meta.manifest === 'manifest.json');
    check('color de barra definido', meta.theme === '#f97316');
    await ctx.close();
  }

  seccion('2. iPHONE + SAFARI — el mozo abre el link');
  {
    const { ctx, page } = await abrir(UA_SAFARI_IOS, 'mozo.html');
    const st = await page.evaluate(() => GestivaInstall.state());
    check('detecta iPhone', st.ios === true);
    check('no lo confunde con navegador interno', st.needsSafari === false);
    check('la tarjeta de instalar se ve sola', !(await page.locator('#installCard').isHidden()));
    check('dice "Instalar"', (await page.textContent('#installBtn')).trim() === 'Instalar');

    await page.click('#installBtn');
    await page.waitForTimeout(600);
    const guia = await page.evaluate(() => {
      const el = document.querySelector('.gv-ins');
      if (!el) return null;
      return { visible: el.classList.contains('on'), texto: el.innerText, tieneIconoCompartir: !!el.querySelector('.gv-share svg') };
    });
    check('se abre la guía visual (no un alert del sistema)', !!guia && guia.visible);
    check('muestra el ícono real de Compartir', guia?.tieneIconoCompartir === true);
    check('dice "Agregar a inicio"', /Agregar a inicio/i.test(guia?.texto || ''), (guia?.texto||'').slice(0,80));
    await page.screenshot({ path: `${OUT}/iphone-safari-guia.png` });

    await page.click('[data-gv="close"]');
    await page.waitForTimeout(500);
    check('se cierra al confirmar', (await page.locator('.gv-ins').count()) === 0);
    await ctx.close();
  }

  seccion('3. iPHONE DENTRO DE INSTAGRAM — el caso que más falla');
  {
    const { ctx, page } = await abrir(UA_INSTAGRAM, 'mozo.html');
    const st = await page.evaluate(() => GestivaInstall.state());
    check('detecta el navegador interno', st.inApp === true);
    check('sabe que primero hay que ir a Safari', st.needsSafari === true);
    check('el aviso lo dice claro', /Safari/i.test(await page.textContent('#installTitle')));

    await page.click('#installBtn');
    await page.waitForTimeout(600);
    const guia = await page.evaluate(() => {
      const el = document.querySelector('.gv-ins');
      return el ? { texto: el.innerText, tieneCopiar: !!el.querySelector('[data-gv="copy"]') } : null;
    });
    check('muestra la guía para salir a Safari', /Abrilo en Safari/i.test(guia?.texto || ''));
    check('ofrece copiar el link', guia?.tieneCopiar === true);
    check('NO le pide "Agregar a inicio" (no existe acá)', !/Agregar a inicio/i.test(guia?.texto || ''));
    await page.screenshot({ path: `${OUT}/iphone-instagram-guia.png` });
    await ctx.close();
  }

  seccion('4. iPHONE CON CHROME — tampoco puede instalar');
  {
    const { ctx, page } = await abrir(UA_CHROME_IOS, 'mozo.html');
    const st = await page.evaluate(() => GestivaInstall.state());
    check('lo detecta y manda a Safari', st.needsSafari === true);
    await ctx.close();
  }

  seccion('5. LANDING EN iPHONE — el botón Descargar');
  {
    const { ctx, page } = await abrir(UA_SAFARI_IOS, 'landing.html');
    const txt = (await page.textContent('#dlInstallBtn')).trim();
    check('el botón habla de iPhone', /iPhone/i.test(txt), txt);
    await page.click('#dlInstallBtn');
    await page.waitForTimeout(600);
    const hayGuia = await page.locator('.gv-ins').count();
    check('abre la guía visual desde la landing', hayGuia === 1);
    await page.screenshot({ path: `${OUT}/landing-iphone-guia.png` });
    await ctx.close();
  }

  seccion('6. YA INSTALADA — no vuelve a ofrecer');
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], userAgent: UA_SAFARI_IOS, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(window.navigator, 'standalone', { get: () => true }); });
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await page.goto(`http://127.0.0.1:${PORT}/mozo.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    check('detecta que ya está instalada', await page.evaluate(() => GestivaInstall.installed) === true);
    check('esconde la tarjeta de instalación', await page.locator('#installCard').isHidden());
    await ctx.close();
  }

  await browser.close(); srv.close();
  console.log(`\n${'─'.repeat(52)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass+fail} — el flujo de iPhone funciona\x1b[0m`
                         : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
