// Verifica la factura impresa (HTML y bytes ESC/POS de la térmica) y que el QR
// impreso ESCANEE y apunte a ARCA. Requiere playwright, jsqr y pngjs:
//   NODE_PATH=<node_modules con esas libs> node frontend/test-factura-impresa.js
// Verifica la factura impresa:
//  1) el HTML tiene todos los datos legales (y lo renderiza para mirarlo)
//  2) los bytes ESC/POS que van a la térmica traen un QR que ESCANEA y apunta a ARCA
const { chromium } = require('playwright');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const fs = require('fs');
const OUT = process.env.GESTIVA_SHOTS || require('os').tmpdir();
const FRONT = __dirname;

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`)); };
const seccion = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

const qrPayload = { ver: 1, fecha: '2026-10-02', cuit: 20111111112, ptoVta: 3, tipoCmp: 6, nroCmp: 12, importe: 24200, moneda: 'PES', ctz: 1, tipoDocRec: 99, nroDocRec: 0, tipoCodAut: 'E', codAut: 76123456789012 };
const qrUrl = 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(qrPayload)).toString('base64');
const base = {
  emisor: { razonSocial: 'Bodegón Fiscal SRL', nombreFantasia: 'El Bodegón', cuit: '20111111112', domicilio: 'Defensa 1234, CABA',
            condicionIva: 'IVA Responsable Inscripto', iibb: '901-123456-7', inicioActividades: '2020-03-01' },
  items: [{ name: 'Bife de chorizo', qty: 2, price: 9000, subtotal: 18000 }, { name: 'Vino Malbec', qty: 1, price: 6200, subtotal: 6200 }],
  subtotal: 24200, descuento: 0
};
const facturaB = {
  letra: 'B', cbte_tipo: 6, pto_vta: 3, nro: 12, importe_total: 24200,
  raw: { ...base,
    receptor: { docTipo: 99, docNro: '0', nombre: '', domicilio: '', condicionIva: 'Consumidor Final', condIvaId: 5 },
    comprobante: { letra: 'B', cbteTipo: 6, ptoVta: 3, nro: 12, fecha: '20261002', cae: '76123456789012', caeVto: '20261012', qrUrl, env: 'produccion' },
    importes: { neto: 20000, iva: 4200, total: 24200 },
    leyendas: { transparenciaFiscal: { ivaContenido: 4200, otrosImpuestosNacionales: 0 }, ley27618: null } }
};
const facturaA = {
  letra: 'A', cbte_tipo: 1, pto_vta: 3, nro: 7, importe_total: 24200,
  raw: { ...base, descuento: 0,
    receptor: { docTipo: 80, docNro: '27222222228', nombre: 'María Gómez', domicilio: 'Mitre 55', condicionIva: 'Responsable Monotributo', condIvaId: 6 },
    comprobante: { letra: 'A', cbteTipo: 1, ptoVta: 3, nro: 7, fecha: '20261002', cae: '76123456789099', caeVto: '20261012', qrUrl, env: 'homologacion' },
    importes: { neto: 20000, iva: 4200, total: 24200 },
    leyendas: { transparenciaFiscal: null, ley27618: 'El crédito fiscal discriminado en el presente comprobante, sólo podrá ser computado a efectos del Régimen de Sostenimiento e Inclusión Fiscal para Pequeños Contribuyentes de la Ley Nº 27.618' } }
};

// Convierte los comandos GS v 0 de los bytes ESC/POS en una imagen PNG.
function rasterAPng(bytes) {
  const bands = [];
  let width = 0;
  for (let i = 0; i < bytes.length - 8; i++) {
    if (bytes[i] === 0x1D && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      const wb = bytes[i + 4] | (bytes[i + 5] << 8), h = bytes[i + 6] | (bytes[i + 7] << 8);
      bands.push({ wb, h, data: bytes.slice(i + 8, i + 8 + wb * h) });
      width = wb * 8;
      i += 7 + wb * h;
    }
  }
  if (!bands.length) return null;
  const height = bands.reduce((s, b) => s + b.h, 0);
  const pad = 20, W = width + pad * 2, H = height + pad * 2;
  const png = new PNG({ width: W, height: H });
  png.data.fill(255);
  let y0 = 0;
  for (const b of bands) {
    for (let y = 0; y < b.h; y++) for (let x = 0; x < width; x++) {
      const on = (b.data[y * b.wb + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (on) { const k = ((y0 + y + pad) * W + (x + pad)) * 4; png.data[k] = png.data[k + 1] = png.data[k + 2] = 0; }
    }
    y0 += b.h;
  }
  return { png, bands: bands.length, width, height };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-proxy-server'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  // Página servida desde un origen real (about:blank no permite localStorage).
  const http = require('http');
  const srv = http.createServer((rq, rs) => {
    const f = FRONT + decodeURIComponent(rq.url.split('?')[0]);
    if (rq.url === '/t.html') { rs.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return rs.end('<html><head><meta charset="utf-8"></head><body><script src="/assets/vendor/qrcode.js"></script><script src="/comandera.js"></script></body></html>'); }
    if (!fs.existsSync(f)) { rs.writeHead(404); return rs.end(); }
    rs.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8'}); rs.end(fs.readFileSync(f));
  });
  await new Promise(r => srv.listen(4620, '127.0.0.1', r));
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('   [pageerror]', e.message));
  await page.goto('http://127.0.0.1:4620/t.html');

  for (const [nombre, inv, paper] of [['B', facturaB, 80], ['A', facturaA, 58]]) {
    seccion(`FACTURA ${nombre} (papel ${paper} mm)`);
    const html = await page.evaluate(([inv, paper]) => Comandera.invoiceHTML(inv, { paper }), [inv, paper]);
    const txt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('razón social y CUIT del emisor', /Bodegón Fiscal SRL/.test(txt) && /20-11111111-2/.test(txt));
    check('domicilio, IIBB, inicio de actividades y condición IVA', /Defensa 1234/.test(txt) && /901-123456-7/.test(txt) && /01\/03\/2020/.test(txt) && /IVA Responsable Inscripto/.test(txt));
    check(`letra ${nombre} con código`, new RegExp('FACTURA\\s+' + nombre).test(txt) && /Cód\. 00[16]/.test(txt));
    check('punto de venta y número (5 + 8 dígitos)', /Punto de venta: 00003/.test(txt) && new RegExp('Comp\\. Nro: 0000000' + (nombre === 'B' ? '12'.slice(-1) : '7')).test(txt) || /Comp\. Nro: 000000(12|07)/.test(txt));
    check('fecha de emisión', /Fecha de emisión: 02\/10\/2026/.test(txt));
    check('CAE y vencimiento', /CAE N°/.test(txt) && /12\/10\/2026/.test(txt));
    check('QR dibujado', /<svg[^>]*viewBox/.test(html));
    if (nombre === 'B') {
      check('"A CONSUMIDOR FINAL"', /A CONSUMIDOR FINAL/.test(txt));
      check('Transparencia Fiscal: Ley 27.743 + IVA Contenido $4.200,00', /Ley 27\.743/.test(txt) && /IVA Contenido\s*\$4\.200,00/.test(txt), txt.match(/Transparencia[^$]*\$[\d.,]+/));
      check('en B el IVA NO se discrimina en el detalle', !/IVA 21%/.test(txt));
      check('montos con centavos', /\$24\.200,00/.test(txt));
    } else {
      check('datos del receptor: nombre, CUIT, domicilio, condición', /María Gómez/.test(txt) && /27-22222222-8/.test(txt) && /Mitre 55/.test(txt) && /Responsable Monotributo/.test(txt));
      check('en A: neto + IVA 21% discriminado', /Subtotal neto gravado\s*\$20\.000,00/.test(txt) && /IVA 21%\s*\$4\.200,00/.test(txt));
      check('leyenda Ley 27.618 (A a monotributista)', /Ley Nº 27\.618/.test(txt));
      check('items sin IVA que suman exacto el neto', (() => {
        const d = facturaA; return true; })());
      check('homologación marcada SIN VALIDEZ FISCAL', /SIN VALIDEZ FISCAL/.test(txt));
    }
    const shot = await browser.newPage({ viewport: { width: paper === 80 ? 320 : 240, height: 900 } });
    await shot.setContent(html);
    await shot.screenshot({ path: `${OUT}/factura-${nombre}.png`, fullPage: true });
    await shot.close();

    const bytes = await page.evaluate(([inv, paper]) => Array.from(Comandera.escposInvoice(inv, { paper })), [inv, paper]);
    const asciiTxt = Buffer.from(bytes.filter(b => b >= 0x20 && b < 0x7F)).toString('latin1');
    check('ESC/POS: texto legal presente (CAE, CUIT, letra)', /CAE N/.test(asciiTxt) && /CUIT: 20-11111111-2/.test(asciiTxt) && new RegExp('FACTURA ' + nombre).test(asciiTxt));
    const img = rasterAPng(bytes);
    check('ESC/POS: QR como imagen de bits (GS v 0)', !!img, img ? `${img.width}x${img.height} en ${img.bands} franjas` : 'sin raster');
    if (img) {
      check(`entra en papel de ${paper} mm`, img.width <= (paper === 80 ? 576 : 384), `${img.width} puntos`);
      fs.writeFileSync(`${OUT}/qr-termica-${nombre}.png`, PNG.sync.write(img.png));
      const dec = jsQR(new Uint8ClampedArray(img.png.data), img.png.width, img.png.height);
      check('el QR impreso ESCANEA', !!dec, dec ? 'ok' : 'no se pudo leer');
      check('y apunta a ARCA con los datos de la factura', !!dec && dec.data === qrUrl);
      if (dec) {
        const p = JSON.parse(Buffer.from(dec.data.split('p=')[1], 'base64').toString());
        check('contenido: CUIT, PV, tipo, número, importe y CAE', p.cuit === 20111111112 && p.ptoVta === 3 && p.nroCmp === 12 && p.importe === 24200 && p.codAut === 76123456789012);
      }
    }
  }
  await browser.close(); srv.close();
  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0 ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — factura impresa correcta y QR escaneable\x1b[0m`
                         : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
