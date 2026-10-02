// La facturación de punta a punta por la API del servidor, con ARCA simulado:
// cobrar una venta → facturarla → doble toque → corte de internet → reintento.
//
//   DATABASE_URL=postgres://... node scripts/test-facturacion-api.js
'use strict';
process.env.PORT = process.env.PORT_TEST || '3198';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.SKIP_BILLING = '1';
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(1); }

const afip = require('../afip');
const { arcaSimulado, certificadoDePrueba } = require('./arca-simulado');
const arca = arcaSimulado();
afip._internals._setTransport(arca.transport);
require('../server.js');   // mismo proceso: usa este afip con el ARCA simulado

const API = 'http://127.0.0.1:' + process.env.PORT;
let pass = 0, fail = 0;
function check(nombre, ok, detalle) {
  if (ok) { pass++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
function seccion(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }
async function req(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text(); let data = {}; try { data = t ? JSON.parse(t) : {}; } catch (e) { data = { raw: t }; }
  return { status: r.status, data };
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await esperar(1200);
  const email = `fact-${Date.now()}@test.local`;
  const reg = await req('/auth/register', { method: 'POST', body: { email, password: 'Secreta123', restaurantName: 'Bodegón Fiscal' } });
  const T = reg.data.token;
  const prod = (await req('/api/products', { method: 'POST', token: T, body: { name: 'Empanada', cat: 'Comida', price: 1210 } })).data;
  const mesas = (await req('/api/tables', { token: T })).data;
  await req('/api/cash/open', { method: 'POST', token: T, body: { openingAmount: 0 } });
  const mozo = (await req('/api/waiters', { method: 'POST', token: T, body: { name: 'Mozo', pin: '1212' } })).data;
  async function venta(mesa, qty) {
    await req('/api/open-tables', { method: 'POST', token: T, body: { tableId: mesa.id, waiterId: mozo.id } });
    await req('/api/open-tables/' + mesa.id, { method: 'PUT', token: T, body: { items: [{ productId: prod.id, qty }] } });
    return (await req('/api/orders', { method: 'POST', token: T, body: { tableId: mesa.id, paymentMethod: 'efectivo' } })).data;
  }

  seccion('1. DATOS FISCALES: SE VALIDAN AL GUARDAR');
  const malo = await req('/api/fiscal-config', { method: 'PUT', token: T, body: { fiscalCondition: 'responsable_inscripto', fiscalCuit: '20111111113', fiscalPtoVta: 3 } });
  check('un CUIT con dígito verificador mal se rechaza', malo.status === 400 && /CUIT/.test(malo.data.detail), JSON.stringify(malo.data));
  const pvMalo = await req('/api/fiscal-config', { method: 'PUT', token: T, body: { fiscalCuit: '20111111112', fiscalPtoVta: 100000 } });
  check('un punto de venta fuera de rango se rechaza', pvMalo.status === 400);
  const ok = await req('/api/fiscal-config', { method: 'PUT', token: T, body: {
    fiscalCondition: 'responsable_inscripto', fiscalCuit: '20-11111111-2', fiscalRazonSocial: 'Bodegón Fiscal SRL',
    fiscalDomicilio: 'Defensa 1234, CABA', fiscalPtoVta: 3, fiscalIngresosBrutos: '901-123456-7', fiscalInicioActividades: '2020-03-01' } });
  check('datos válidos se guardan y avisa que falta el certificado', ok.status === 200 && ok.data.faltan.join() === 'certificado de ARCA', JSON.stringify(ok.data));

  seccion('2. CERTIFICADO');
  const c1 = certificadoDePrueba(), c2 = certificadoDePrueba();
  const mezcla = await req('/api/fiscal-cert', { method: 'PUT', token: T, body: { cert: c1.certPem, key: c2.keyPem, env: 'homologacion' } });
  check('certificado y clave que no se corresponden se rechazan', mezcla.status === 400 && mezcla.data.error === 'cert_no_coincide', JSON.stringify(mezcla.data));
  const cert = await req('/api/fiscal-cert', { method: 'PUT', token: T, body: { cert: c1.certPem, key: c1.keyPem, env: 'homologacion' } });
  check('certificado correcto se acepta', cert.status === 200);
  const cfg = (await req('/api/fiscal-config', { token: T })).data;
  check('ya no falta nada para facturar', cfg.faltan.length === 0 && !!cfg.certVence, JSON.stringify(cfg.faltan));

  seccion('3. FACTURA B A CONSUMIDOR FINAL');
  const v1 = await venta(mesas[0], 10);   // 10 × 1.210 = 12.100
  const f1 = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v1.id, docTipo: 99, importeTotal: 1 } });
  check('se emite con CAE', f1.status === 200 && f1.data.invoice.status === 'approved' && !!f1.data.invoice.cae, JSON.stringify(f1.data).slice(0, 200));
  check('el importe sale de la venta, no de la pantalla ($12.100, no $1)', Number(f1.data.invoice.importe_total) === 12100);
  check('IVA discriminado (neto 10.000 + IVA 2.100)', Number(f1.data.invoice.importe_neto) === 10000 && Number(f1.data.invoice.importe_iva) === 2100);
  const snap = f1.data.invoice.raw;
  check('guarda los datos del emisor para imprimir', snap && snap.emisor.razonSocial === 'Bodegón Fiscal SRL' && snap.emisor.iibb === '901-123456-7' && snap.emisor.inicioActividades === '2020-03-01');
  check('incluye la leyenda de Transparencia Fiscal (Ley 27.743)', snap && snap.leyendas.transparenciaFiscal && snap.leyendas.transparenciaFiscal.ivaContenido === 2100);
  check('guarda los items de la venta', snap && snap.items.length === 1 && snap.items[0].qty === 10);

  seccion('4. DOBLE TOQUE EN "FACTURAR"');
  const f1b = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v1.id, docTipo: 99 } });
  check('devuelve la MISMA factura', f1b.data.duplicate === true && f1b.data.invoice.cae === f1.data.invoice.cae);
  const v2 = await venta(mesas[1], 1);
  const [x, y] = await Promise.all([
    req('/api/invoices', { method: 'POST', token: T, body: { orderId: v2.id, docTipo: 99 } }),
    req('/api/invoices', { method: 'POST', token: T, body: { orderId: v2.id, docTipo: 99 } })
  ]);
  check('dos pedidos simultáneos → una sola factura', x.data.invoice && y.data.invoice && x.data.invoice.cae === y.data.invoice.cae, `${x.status}/${y.status}`);
  check('ARCA recibió una sola (B nº 1 y nº 2)', arca.st.comprobantes.get('3|6').length === 2, 'B en ARCA: ' + arca.st.comprobantes.get('3|6').length);

  seccion('5. DOS CAJAS FACTURAN A LA VEZ (numeración)');
  const ventas = [];
  for (let i = 2; i < 6; i++) ventas.push(await venta(mesas[i], 1));
  const rs = await Promise.all(ventas.map(v => req('/api/invoices', { method: 'POST', token: T, body: { orderId: v.id, docTipo: 99 } })));
  check('las 4 se emiten sin pisarse el número', rs.every(r => r.status === 200 && r.data.invoice.status === 'approved'), rs.map(r => r.status).join(','));
  const nros = rs.map(r => Number(r.data.invoice.nro)).sort((a, b) => a - b);
  check('números correlativos 3,4,5,6', nros.join() === '3,4,5,6', nros.join());

  seccion('6. SE CORTA INTERNET JUSTO CUANDO ARCA AUTORIZA');
  const v3 = await venta(mesas[6], 2);
  arca.st.cortarProxima = true;
  const corte = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v3.id, docTipo: 96, docNro: '30123456' } });
  check('el cajero ve que no se sabe si salió (503)', corte.status === 503 && corte.data.error === 'arca_sin_respuesta', JSON.stringify(corte.data));
  const enArca = arca.st.comprobantes.get('3|6').length;
  const reint = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v3.id, docTipo: 96, docNro: '30123456' } });
  check('al reintentar recupera el CAE', reint.status === 200 && reint.data.recovered === true && !!reint.data.invoice.cae, JSON.stringify(reint.data).slice(0, 200));
  check('ARCA sigue teniendo una sola factura de esa venta', arca.st.comprobantes.get('3|6').length === enArca);

  seccion('7. FACTURA A A UN MONOTRIBUTISTA');
  const v4 = await venta(mesas[7], 1);
  const fa = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v4.id, docTipo: 80, docNro: '27222222228', condicionReceptor: 'monotributo', nombre: 'María Gómez', domicilio: 'Mitre 55' } });
  check('sale Factura A', fa.status === 200 && fa.data.invoice.letra === 'A', JSON.stringify(fa.data).slice(0, 200));
  check('con la leyenda de la Ley 27.618', fa.data.invoice.raw && /27\.618/.test(fa.data.invoice.raw.leyendas.ley27618 || ''));
  check('y los datos del cliente', fa.data.invoice.cliente_nombre === 'María Gómez' && fa.data.invoice.cliente_domicilio === 'Mitre 55');

  seccion('8. ERRORES CLAROS');
  const v5 = await venta(mesas[8], 1);
  const cuitMalo = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v5.id, docTipo: 80, docNro: '20111111113', condicionReceptor: 'responsable_inscripto' } });
  check('CUIT del cliente inválido → mensaje en castellano', cuitMalo.status === 422 && /CUIT/.test(cuitMalo.data.detail), JSON.stringify(cuitMalo.data));
  const corrige = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v5.id, docTipo: 80, docNro: '30500010912', condicionReceptor: 'responsable_inscripto', nombre: 'Empresa SA' } });
  check('corrigiendo el CUIT, la misma venta se factura', corrige.status === 200 && corrige.data.invoice.letra === 'A');
  const otra = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: '00000000-0000-0000-0000-000000000000', docTipo: 99 } });
  check('una venta inexistente se rechaza', otra.status === 404);

  seccion('9. SE REINICIA EL SERVIDOR (deploy)');
  afip._internals._taCache.clear();
  const logins = arca.st.logins;
  const v6 = await venta(mesas[9], 1);
  const tras = await req('/api/invoices', { method: 'POST', token: T, body: { orderId: v6.id, docTipo: 99 } });
  check('sigue facturando con el ticket guardado en la base', tras.status === 200 && arca.st.logins === logins, `status=${tras.status} logins ${logins}→${arca.st.logins}`);

  seccion('10. CONSULTAR LA FACTURA DE UNA VENTA');
  const g = await req('/api/invoices?orderId=' + v1.id, { token: T });
  check('se puede pedir para reimprimir', g.status === 200 && g.data && g.data.cae === f1.data.invoice.cae);

  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0
    ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — facturación por la API correcta\x1b[0m`
    : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m  (${pass} ok)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
