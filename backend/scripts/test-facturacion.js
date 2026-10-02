// Facturación electrónica contra un ARCA SIMULADO que valida lo mismo que el
// real en los puntos donde Gestiva fallaba:
//   - CondicionIVAReceptorId presente y en su lugar (RG 5616)
//   - letra de la factura compatible con la condición IVA del receptor
//   - numeración correlativa (último + 1)
//   - fecha del comprobante = día en Argentina
//   - ARCA no da un ticket nuevo si hay uno vigente (coe.alreadyAuthenticated)
//
//   node scripts/test-facturacion.js
'use strict';
const afip = require('../afip');
const { _setTransport, olvidarTA, _taCache } = afip._internals;

let pass = 0, fail = 0;
function check(nombre, ok, detalle) {
  if (ok) { pass++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
function seccion(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

const { arcaSimulado, certificadoDePrueba, hoyAR } = require('./arca-simulado');

// ---------- Datos del restaurante ----------
const { certPem, keyPem } = certificadoDePrueba();
const tenantRI = {
  fiscal_condition: 'responsable_inscripto', fiscal_cuit: '20111111112', fiscal_razon_social: 'Parrilla SRL',
  fiscal_domicilio: 'Av. Siempre Viva 123', fiscal_pto_vta: 3, fiscal_env: 'homologacion',
  fiscal_cert: certPem, fiscal_key: keyPem
};
const tenantMono = { ...tenantRI, fiscal_condition: 'monotributo', fiscal_cuit: '27222222228' };
// Persistencia del ticket en "la base" (acá un objeto).
function storeEnMemoria() {
  const db = {};
  return { db, get: async (env) => db[env] || null, set: async (env, ta) => { db[env] = ta; }, clear: async (env) => { delete db[env]; } };
}

(async () => {
  seccion('VALIDACIONES LOCALES');
  check('CUIT válido (dígito verificador)', afip.cuitValido('20-11111111-2'));
  check('CUIT con dígito mal se rechaza', !afip.cuitValido('20111111113'));
  check('CUIT de empresa (30-...) válido', afip.cuitValido('30500010912'));
  check('fecha de hoy en Argentina (no UTC)', afip.fechaHoyAR() === hoyAR(), afip.fechaHoyAR());
  const noche = new Date('2026-10-03T01:30:00Z');   // 22:30 del 2/10 en Argentina
  check('a las 22:30 sigue siendo el mismo día', afip.fechaHoyAR(noche) === '20261002', afip.fechaHoyAR(noche));
  check('RI → RI con CUIT = Factura A', afip.letraFactura('responsable_inscripto', 80, 'responsable_inscripto') === 'A');
  check('RI → Monotributista con CUIT = Factura A (RG 5003)', afip.letraFactura('responsable_inscripto', 80, 'monotributo') === 'A');
  check('RI → Consumidor final = Factura B', afip.letraFactura('responsable_inscripto', 99, 'consumidor_final') === 'B');
  check('RI → Consumidor final con CUIT = Factura B', afip.letraFactura('responsable_inscripto', 80, 'consumidor_final') === 'B');
  check('RI → Exento = Factura B', afip.letraFactura('responsable_inscripto', 80, 'exento') === 'B');
  check('Monotributo emite siempre C', afip.letraFactura('monotributo', 80, 'responsable_inscripto') === 'C');
  const sinCuit = afip.normalizarReceptor('responsable_inscripto', { docTipo: 99, condicionReceptor: 'responsable_inscripto', importeTotal: 1000 });
  check('pedir Factura A sin CUIT da un error claro', !!sinCuit.error, JSON.stringify(sinCuit));
  const tope = afip.normalizarReceptor('responsable_inscripto', { docTipo: 99, importeTotal: 10000000 });
  check('consumidor final desde $10.000.000 exige identificarlo', !!tope.error && /10\.000\.000/.test(tope.error));
  const imp = afip.calcularImportes('B', 12100);
  check('B $12.100 = neto $10.000 + IVA $2.100', imp.impNeto === 10000 && imp.impIVA === 2100, JSON.stringify(imp));
  const raro = afip.calcularImportes('B', 99.99);
  check('neto + IVA suman exacto el total (redondeo)', Math.abs(raro.impNeto + raro.impIVA - 99.99) < 0.001, JSON.stringify(raro));

  seccion('1. FACTURA B A CONSUMIDOR FINAL');
  let arca = arcaSimulado(); _setTransport(arca.transport); _taCache.clear();
  let store = storeEnMemoria();
  const f1 = await afip.emitirFactura(tenantRI, { docTipo: 99, importeTotal: 24200 }, { store });
  check('ARCA la autoriza (CAE)', !!f1.cae && f1.letra === 'B' && f1.nro === 1, JSON.stringify({ letra: f1.letra, nro: f1.nro }));
  check('se informó CondicionIVAReceptorId = 5', /<ar:CondicionIVAReceptorId>5<\/ar:CondicionIVAReceptorId>/.test(arca.st.ultimoXml));
  check('IVA discriminado: neto 20.000 + IVA 4.200', f1.impNeto === 20000 && f1.impIVA === 4200);
  check('el QR lleva CUIT, comprobante y CAE', (() => {
    const p = JSON.parse(Buffer.from(f1.qrUrl.split('p=')[1], 'base64').toString());
    return p.cuit === 20111111112 && p.ptoVta === 3 && p.tipoCmp === 6 && p.nroCmp === 1 && p.codAut === Number(f1.cae) && p.importe === 24200;
  })());

  seccion('2. FACTURA A A UN MONOTRIBUTISTA (antes salía B)');
  const f2 = await afip.emitirFactura(tenantRI, { docTipo: 80, docNro: '20-11111111-2', condicionReceptor: 'monotributo', importeTotal: 12100, nombre: 'Juan Perez' }, { store });
  check('sale Factura A (código 1)', f2.letra === 'A' && f2.cbteTipo === 1, f2.letra);
  check('con CondicionIVAReceptorId = 6', f2.condIvaReceptorId === 6 && /<ar:CondicionIVAReceptorId>6</.test(arca.st.ultimoXml));
  check('la numeración de A es independiente de B', f2.nro === 1);

  seccion('3. FACTURA A A UN RESPONSABLE INSCRIPTO');
  const f3 = await afip.emitirFactura(tenantRI, { docTipo: 80, docNro: '30500010912', condicionReceptor: 'responsable_inscripto', importeTotal: 50000, nombre: 'Empresa SA', domicilio: 'Calle 2' }, { store });
  check('Factura A nº 2', f3.letra === 'A' && f3.nro === 2);

  seccion('4. MONOTRIBUTISTA EMITE FACTURA C');
  const arcaC = arcaSimulado(); _setTransport(arcaC.transport); _taCache.clear();
  const f4 = await afip.emitirFactura(tenantMono, { docTipo: 99, importeTotal: 8000 }, { store: storeEnMemoria() });
  check('Factura C sin IVA discriminado', f4.letra === 'C' && f4.cbteTipo === 11 && f4.impIVA === 0 && f4.impNeto === 8000);
  check('la C no manda bloque de IVA', !/<ar:Iva>/.test(arcaC.st.ultimoXml));

  seccion('5. SE REINICIA EL SERVIDOR (deploy) Y SE SIGUE FACTURANDO');
  _setTransport(arca.transport);
  _taCache.clear();                        // el servidor perdió la memoria
  const loginsAntes = arca.st.logins;
  const f5 = await afip.emitirFactura(tenantRI, { docTipo: 99, importeTotal: 1000 }, { store });
  check('usa el ticket guardado en la base: no vuelve a loguear', arca.st.logins === loginsAntes && !!f5.cae, `logins ${loginsAntes} → ${arca.st.logins}`);
  _taCache.clear();
  let errSinStore = null;
  try { await afip.emitirFactura(tenantRI, { docTipo: 99, importeTotal: 1000 }, {}); } catch (e) { errSinStore = e; }
  check('sin guardarlo en la base, ARCA rechaza (así fallaba antes)', !!errSinStore && /sesión anterior/.test(errSinStore.message), errSinStore && errSinStore.message);

  seccion('6. SE CORTA LA RESPUESTA DE ARCA DESPUÉS DE AUTORIZAR');
  _taCache.clear();
  const venta = { docTipo: 96, docNro: '30123456', condicionReceptor: 'consumidor_final', importeTotal: 15500 };
  let reservado = null, errCorte = null;
  arca.st.cortarProxima = true;
  try {
    await afip.emitirFactura(tenantRI, venta, { store, onReserva: async (r) => { reservado = r; } });
  } catch (e) { errCorte = e; }
  check('el cajero recibe un error de red (no sabe si salió)', !!errCorte && errCorte.arcaNetwork === true);
  check('el número quedó reservado antes de pedir el CAE', !!reservado && reservado.nro === 3, JSON.stringify(reservado));
  const enArcaAntes = arca.st.comprobantes.get('3|6').length;
  const f6 = await afip.emitirFactura(tenantRI, venta, { store, reservado });
  check('al reintentar se RECUPERA el CAE de ARCA', f6.recuperada === true && f6.nro === 3, JSON.stringify({ rec: f6.recuperada, nro: f6.nro }));
  check('y NO se emite una segunda factura', arca.st.comprobantes.get('3|6').length === enArcaAntes, `comprobantes B: ${enArcaAntes} → ${arca.st.comprobantes.get('3|6').length}`);

  seccion('7. EL CORTE FUE ANTES DE LLEGAR A ARCA');
  const reservaFantasma = { nro: 4, cbteTipo: 6, ptoVta: 3 };   // reservado pero nunca enviado
  const f7 = await afip.emitirFactura(tenantRI, { docTipo: 99, importeTotal: 777 }, { store, reservado: reservaFantasma });
  check('ARCA no la tiene: se emite normal con ese número', f7.recuperada === false && f7.nro === 4, JSON.stringify({ rec: f7.recuperada, nro: f7.nro }));

  seccion('8. EL NÚMERO RESERVADO LO USÓ OTRA FACTURA');
  const reservaPisada = { nro: 4, cbteTipo: 6, ptoVta: 3 };     // la 4 es de otra venta (importe 777)
  const f8 = await afip.emitirFactura(tenantRI, { docTipo: 99, importeTotal: 5000 }, { store, reservado: reservaPisada });
  check('no se queda con el CAE ajeno: emite la suya (nº 5)', f8.recuperada === false && f8.nro === 5, JSON.stringify({ rec: f8.recuperada, nro: f8.nro }));

  seccion('8b. CORTE + EL CAJERO CORRIGE EL CLIENTE (de B a A) Y REINTENTA');
  _taCache.clear();
  let reserva2 = null;
  arca.st.cortarProxima = true;
  const ventaB = { docTipo: 99, condicionReceptor: 'consumidor_final', importeTotal: 3300 };
  try { await afip.emitirFactura(tenantRI, ventaB, { store, onReserva: async (r) => { reserva2 = r; } }); } catch (e) {}
  const bAntes = arca.st.comprobantes.get('3|6').length, aAntes = (arca.st.comprobantes.get('3|1') || []).length;
  // El cajero ahora dice que el cliente es RI con CUIT (pediría Factura A)
  const f8b = await afip.emitirFactura(tenantRI,
    { docTipo: 80, docNro: '30500010912', condicionReceptor: 'responsable_inscripto', importeTotal: 3300 },
    { store, reservado: reserva2 });
  check('se recupera la B que ARCA ya había autorizado', f8b.recuperada === true && f8b.letra === 'B', JSON.stringify({ rec: f8b.recuperada, letra: f8b.letra }));
  check('no se emite una A extra por la misma venta',
        arca.st.comprobantes.get('3|6').length === bAntes && (arca.st.comprobantes.get('3|1') || []).length === aAntes);

  seccion('9. DATOS FISCALES INCOMPLETOS');
  let errDatos = null;
  try { await afip.emitirFactura({ ...tenantRI, fiscal_domicilio: '', fiscal_pto_vta: null }, { importeTotal: 100 }, { store }); } catch (e) { errDatos = e; }
  check('avisa exactamente qué falta', !!errDatos && /domicilio fiscal/.test(errDatos.message) && /punto de venta/.test(errDatos.message), errDatos && errDatos.message);

  _setTransport(null);
  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0
    ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — facturación ARCA correcta\x1b[0m`
    : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m  (${pass} ok)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
