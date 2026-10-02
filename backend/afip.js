/* ============================================================
   Gestiva — Integración directa con ARCA (ex-AFIP)
   Factura electrónica: WSAA (login) + WSFEv1 (CAE) + QR (RG 4892).
   Sin terceros: cada restaurante usa SU certificado y clave.
   ------------------------------------------------------------
   Requiere: node-forge (firma CMS del TRA).

   Reglas que respeta (verificadas contra la normativa vigente):
   - CondicionIVAReceptorId en cada comprobante (RG 5616; obligatorio con
     rechazo desde el 01/12/2026, manual WSFEv1 v4.8).
   - Factura A de un Responsable Inscripto a otro RI y también a
     monotributistas (RG 5003): clases de receptor 1, 6, 13 y 16.
   - Fecha del comprobante en hora argentina (no UTC).
   - Consumidor final: identificación obligatoria desde $10.000.000
     (RG 5700/2025, ratificado por RG 5866/2026).
   ============================================================ */
'use strict';
const https = require('https');
const forge = require('node-forge');

const TZ = 'America/Argentina/Buenos_Aires';

// Endpoints WSAA / WSFE por entorno
const ENDPOINTS = {
  homologacion: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'
  },
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
  }
};

// ---------- Condición frente al IVA del receptor ----------
// Códigos de FEParamGetCondicionIvaReceptor.
const COND_IVA = {
  responsable_inscripto: 1,
  exento: 4,
  consumidor_final: 5,
  monotributo: 6,
  no_categorizado: 7,
  proveedor_exterior: 8,
  cliente_exterior: 9,
  iva_liberado: 10,
  monotributo_social: 13,
  no_alcanzado: 15,
  monotributo_promovido: 16
};
const COND_IVA_LABEL = {
  1: 'IVA Responsable Inscripto',
  4: 'IVA Sujeto Exento',
  5: 'Consumidor Final',
  6: 'Responsable Monotributo',
  7: 'Sujeto No Categorizado',
  8: 'Proveedor del Exterior',
  9: 'Cliente del Exterior',
  10: 'IVA Liberado - Ley N° 19.640',
  13: 'Monotributista Social',
  15: 'IVA No Alcanzado',
  16: 'Monotributo Trabajador Independiente Promovido'
};
// Receptores que reciben Factura A de un Responsable Inscripto.
const COND_CLASE_A = [1, 6, 13, 16];
// Factura A a monotributistas: leyenda obligatoria (RG 5003, art. 20).
const COND_MONOTRIBUTO = [6, 13, 16];
const LEYENDA_27618 = 'El crédito fiscal discriminado en el presente comprobante, sólo podrá ser computado a efectos del Régimen de Sostenimiento e Inclusión Fiscal para Pequeños Contribuyentes de la Ley Nº 27.618';
// Consumidor final: desde este monto hay que identificarlo (DNI/CUIL/CUIT).
const TOPE_CONSUMIDOR_FINAL = 10000000;

const CONDICION_EMISOR_LABEL = {
  responsable_inscripto: 'IVA Responsable Inscripto',
  monotributo: 'Responsable Monotributo',
  exento: 'IVA Sujeto Exento'
};

function condIvaId(v) {
  if (v === undefined || v === null || v === '') return COND_IVA.consumidor_final;
  const n = Number(v);
  if (Number.isInteger(n) && COND_IVA_LABEL[n]) return n;
  const k = String(v).trim().toLowerCase();
  return COND_IVA[k] || null;
}

// Tipo de comprobante (código ARCA). Factura A=1, B=6, C=11.
function cbteTipoFor(_condicion, letra) {
  const map = { A: 1, B: 6, C: 11 };
  return map[letra] || 11;
}

// Letra según el EMISOR y el receptor. Monotributo y exento emiten C.
// Un RI emite A si el receptor tiene CUIT y es RI o monotributista; si no, B.
function letraFactura(condicionEmisor, docTipoReceptor, condicionReceptor) {
  if (condicionEmisor !== 'responsable_inscripto') return 'C';
  const cond = condIvaId(condicionReceptor);
  return (Number(docTipoReceptor) === 80 && COND_CLASE_A.includes(cond)) ? 'A' : 'B';
}

// ---------- Validaciones ----------
function soloDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

// CUIT/CUIL: 11 dígitos con dígito verificador módulo 11.
function cuitValido(v) {
  const s = soloDigitos(v);
  if (s.length !== 11) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += w[i] * Number(s[i]);
  let dv = 11 - (sum % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) return false;
  return dv === Number(s[10]);
}
function dniValido(v) {
  const s = soloDigitos(v);
  return s.length >= 7 && s.length <= 8 && Number(s) >= 1000000;
}

// Valida los datos del receptor y devuelve los normalizados, o un error con
// el motivo en castellano (para mostrarle al cajero).
function normalizarReceptor(condicionEmisor, venta) {
  const docTipo = Number(venta.docTipo) || 99;
  if (![80, 86, 96, 99].includes(docTipo)) return { error: 'Tipo de documento no válido.' };
  const docNro = docTipo === 99 ? '0' : soloDigitos(venta.docNro);
  const cond = condIvaId(venta.condicionReceptor);
  if (!cond) return { error: 'Condición frente al IVA del cliente no válida.' };

  if (docTipo === 80 || docTipo === 86) {
    if (!cuitValido(docNro)) return { error: (docTipo === 80 ? 'CUIT' : 'CUIL') + ' inválido: revisá los 11 números.' };
  }
  if (docTipo === 96 && !dniValido(docNro)) return { error: 'DNI inválido.' };

  // Solo un consumidor final puede ir sin identificar.
  if (docTipo === 99 && cond !== COND_IVA.consumidor_final) {
    return { error: 'Para facturar a ' + COND_IVA_LABEL[cond] + ' hace falta el CUIT del cliente.' };
  }
  // RI y monotributistas se identifican con CUIT.
  if ([1, 6, 13, 16, 4].includes(cond) && docTipo !== 80) {
    return { error: 'Para ' + COND_IVA_LABEL[cond] + ' cargá el CUIT del cliente.' };
  }
  const importe = Number(venta.importeTotal) || 0;
  if (cond === COND_IVA.consumidor_final && docTipo === 99 && importe >= TOPE_CONSUMIDOR_FINAL) {
    return { error: 'Desde $10.000.000 hay que identificar al consumidor final (DNI o CUIT).' };
  }
  const letra = letraFactura(condicionEmisor, docTipo, cond);
  return {
    docTipo, docNro, condIvaReceptorId: cond, letra,
    nombre: String(venta.nombre || '').trim().slice(0, 120),
    domicilio: String(venta.domicilio || '').trim().slice(0, 200)
  };
}

// Datos fiscales del emisor que hacen falta para facturar.
function validarEmisor(t) {
  const faltan = [];
  if (!['responsable_inscripto', 'monotributo', 'exento'].includes(t.fiscal_condition)) faltan.push('condición frente al IVA');
  if (!cuitValido(t.fiscal_cuit)) faltan.push('CUIT válido');
  if (!String(t.fiscal_razon_social || '').trim()) faltan.push('razón social');
  if (!String(t.fiscal_domicilio || '').trim()) faltan.push('domicilio fiscal');
  const pv = Number(t.fiscal_pto_vta);
  if (!(Number.isInteger(pv) && pv >= 1 && pv <= 99998)) faltan.push('punto de venta');
  if (!t.fiscal_cert || !t.fiscal_key) faltan.push('certificado de ARCA');
  return faltan;
}

// ---------- Fechas en hora argentina ----------
// YYYYMMDD del día en Argentina. Con UTC, todo lo facturado después de las
// 21 hs salía con la fecha del día siguiente.
function fechaHoyAR(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d || new Date()).replace(/-/g, '');
}

// ---------- HTTP POST (SOAP) ----------
function postSoap(url, body, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(body, 'utf8');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': data.length,
        'SOAPAction': soapAction || ''
      }, timeout: 30000
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', (e) => { e.arcaNetwork = true; reject(e); });
    req.on('timeout', () => { const e = new Error('ARCA no respondió a tiempo'); e.arcaNetwork = true; req.destroy(e); });
    req.write(data); req.end();
  });
}

let transport = postSoap;
// Solo para tests: reemplaza el transporte HTTP por un ARCA simulado.
function _setTransport(fn) { transport = fn || postSoap; }

function unescapeXml(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function escapeXml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tag(xml, name) {
  const m = String(xml || '').match(new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>'));
  return m ? m[1] : null;
}
function soapFault(body) {
  const f = tag(body, 'faultstring');
  return f ? unescapeXml(f) : null;
}

// ---------- WSAA: login con certificado ----------
function buildTRA(service) {
  const now = Date.now();
  const gen = new Date(now - 10 * 60000).toISOString();
  const exp = new Date(now + 10 * 60000).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
<header><uniqueId>${Math.floor(now / 1000)}</uniqueId><generationTime>${gen}</generationTime><expirationTime>${exp}</expirationTime></header>
<service>${service}</service>
</loginTicketRequest>`;
}

// Firma el TRA en CMS (PKCS#7) con el certificado y la clave (PEM) → base64
function signTRA(traXml, certPem, keyPem) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(forge.pki.certificateFromPem(certPem));
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: forge.pki.certificateFromPem(certPem),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign({ detached: false });
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

// Ticket de acceso (TA): dura ~12 h y ARCA NO entrega otro mientras siga
// vigente ("El CEE ya posee un TA valido"). Por eso se guarda en la base
// (store) además de en memoria: si se guardaba solo en memoria, después de
// cada deploy o reinicio del servidor la facturación quedaba caída hasta que
// venciera el ticket anterior.
const _taCache = new Map();
async function wsaaLogin(cuit, certPem, keyPem, env, store) {
  const key = cuit + '|' + env;
  const vigente = (ta) => ta && ta.token && ta.sign && ta.exp > Date.now() + 120000;
  const cached = _taCache.get(key);
  if (vigente(cached)) return cached;
  if (store && store.get) {
    try {
      const saved = await store.get(env);
      if (vigente(saved)) { const ta = { ...saved, cuit }; _taCache.set(key, ta); return ta; }
    } catch (e) { /* si la base falla, seguimos con un login nuevo */ }
  }

  const cms = signTRA(buildTRA('wsfe'), certPem, keyPem);
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const r = await transport(ENDPOINTS[env].wsaa, envelope, '');
  const ret = tag(r.body, 'loginCmsReturn');
  if (!ret) {
    const fault = soapFault(r.body) || '';
    if (/alreadyAuthenticated|ya posee un TA valido/i.test(fault + r.body)) {
      const e = new Error('ARCA todavía tiene abierta una sesión anterior de este certificado. Se libera sola en unas horas (como máximo 12). Si es urgente, generá un certificado nuevo en ARCA y cargalo en Ajustes.');
      e.arcaRechazo = true;
      throw e;
    }
    const e = new Error('ARCA rechazó el login del certificado: ' + (fault || r.body.slice(0, 200)));
    e.arcaRechazo = true;
    throw e;
  }
  const ticket = unescapeXml(ret);
  const token = tag(ticket, 'token');
  const sign = tag(ticket, 'sign');
  const expStr = tag(ticket, 'expirationTime');
  if (!token || !sign) throw new Error('WSAA no devolvió token/sign: ' + ticket.slice(0, 300));
  const ta = { token, sign, cuit, exp: expStr ? new Date(expStr).getTime() : Date.now() + 11 * 3600000 };
  _taCache.set(key, ta);
  if (store && store.set) { try { await store.set(env, ta); } catch (e) { /* no frena la factura */ } }
  return ta;
}
function olvidarTA(cuit, env) { _taCache.delete(cuit + '|' + env); }

// ---------- WSFEv1 ----------
function fevHeader(ta) {
  return `<ar:Auth><ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign><ar:Cuit>${ta.cuit}</ar:Cuit></ar:Auth>`;
}
async function feCallSoap(env, action, innerXml) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
<soapenv:Header/><soapenv:Body>${innerXml}</soapenv:Body></soapenv:Envelope>`;
  const r = await transport(ENDPOINTS[env].wsfe, envelope, 'http://ar.gov.afip.dif.FEV1/' + action);
  if (r.status >= 500 && !tag(r.body, action + 'Result')) {
    const e = new Error('ARCA respondió con error ' + r.status + (soapFault(r.body) ? ': ' + soapFault(r.body) : ''));
    e.arcaNetwork = true; // el servicio está caído: no sabemos qué pasó
    throw e;
  }
  return r.body;
}
// Errores de WSFE: [{code, msg}]
function feErrores(body) {
  const errs = tag(body, 'Errors');
  if (!errs) return [];
  const out = [];
  const re = /<(?:\w+:)?Err>([\s\S]*?)<\/(?:\w+:)?Err>/g;
  let m;
  while ((m = re.exec(errs))) out.push({ code: tag(m[1], 'Code'), msg: unescapeXml(tag(m[1], 'Msg') || '') });
  if (!out.length && tag(errs, 'Msg')) out.push({ code: tag(errs, 'Code'), msg: unescapeXml(tag(errs, 'Msg')) });
  return out;
}
// 600/601/602x: problemas con el ticket de acceso → hay que volver a loguear.
const ERR_TOKEN = ['600', '601'];

// Último número autorizado para (ptoVta, cbteTipo)
async function ultimoComprobante(ta, ptoVta, cbteTipo, env) {
  const inner = `<ar:FECompUltimoAutorizado>${fevHeader(ta)}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FECompUltimoAutorizado>`;
  const body = await feCallSoap(env, 'FECompUltimoAutorizado', inner);
  const errs = feErrores(body);
  if (errs.length) {
    const e = new Error('ARCA (último comprobante): ' + errs.map(x => x.msg).join(' | '));
    e.arcaRechazo = true; e.arcaCodes = errs.map(x => x.code);
    throw e;
  }
  return parseInt(tag(body, 'CbteNro') || '0', 10);
}

// Un comprobante ya emitido (para recuperar el CAE después de un corte).
// Devuelve null si ARCA no lo tiene.
async function consultarComprobante(ta, ptoVta, cbteTipo, nro, env) {
  const inner = `<ar:FECompConsultar>${fevHeader(ta)}<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${nro}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq></ar:FECompConsultar>`;
  const body = await feCallSoap(env, 'FECompConsultar', inner);
  const res = tag(body, 'ResultGet');
  if (!res) {
    const errs = feErrores(body);
    // 602: "No existen datos en nuestros registros para los parámetros ingresados"
    if (!errs.length || errs.some(x => x.code === '602')) return null;
    const e = new Error('ARCA (consulta): ' + errs.map(x => x.msg).join(' | '));
    e.arcaRechazo = true; e.arcaCodes = errs.map(x => x.code);
    throw e;
  }
  return {
    nro: Number(nro),
    cbteFch: tag(res, 'CbteFch'),
    impTotal: parseFloat(tag(res, 'ImpTotal') || '0'),
    docTipo: parseInt(tag(res, 'DocTipo') || '0', 10),
    docNro: String(tag(res, 'DocNro') || '0'),
    cae: tag(res, 'CodAutorizacion'),
    caeVto: tag(res, 'FchVto'),
    resultado: tag(res, 'Resultado')
  };
}

// Pide el CAE para el número `nro` (lo decide quien llama, ver emitirFactura).
// data = { ptoVta, cbteTipo, letra, docTipo, docNro, condIvaReceptorId,
//          impTotal, impNeto, impIVA, fecha(YYYYMMDD), concepto }
async function solicitarCAE(ta, data, env) {
  const nro = data.nro;
  const fecha = data.fecha || fechaHoyAR();
  const esC = data.letra === 'C'; // C no discrimina IVA
  const impNeto = esC ? data.impTotal.toFixed(2) : data.impNeto.toFixed(2);
  const impIVA = esC ? '0.00' : data.impIVA.toFixed(2);
  // A/B: detalle de IVA (alícuota 21% = Id 5). C: sin IVA.
  const ivaXml = esC ? '' :
    `<ar:Iva><ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>${impNeto}</ar:BaseImp><ar:Importe>${impIVA}</ar:Importe></ar:AlicIva></ar:Iva>`;
  // El orden de los elementos importa (el servicio es .NET): CondicionIVAReceptorId
  // va después de MonCotiz y antes de Iva. Fuera de lugar, ARCA lo ignora.
  const inner =
`<ar:FECAESolicitar>${fevHeader(ta)}<ar:FeCAEReq>
<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${data.ptoVta}</ar:PtoVta><ar:CbteTipo>${data.cbteTipo}</ar:CbteTipo></ar:FeCabReq>
<ar:FeDetReq><ar:FECAEDetRequest>
<ar:Concepto>${data.concepto || 1}</ar:Concepto>
<ar:DocTipo>${data.docTipo}</ar:DocTipo><ar:DocNro>${data.docNro || 0}</ar:DocNro>
<ar:CbteDesde>${nro}</ar:CbteDesde><ar:CbteHasta>${nro}</ar:CbteHasta><ar:CbteFch>${fecha}</ar:CbteFch>
<ar:ImpTotal>${data.impTotal.toFixed(2)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc>
<ar:ImpNeto>${impNeto}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>${impIVA}</ar:ImpIVA>
<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>
<ar:CondicionIVAReceptorId>${data.condIvaReceptorId}</ar:CondicionIVAReceptorId>
${ivaXml}
</ar:FECAEDetRequest></ar:FeDetReq>
</ar:FeCAEReq></ar:FECAESolicitar>`;
  const body = await feCallSoap(env, 'FECAESolicitar', inner);
  const errs = feErrores(body);
  if (errs.length) {
    const e = new Error('ARCA rechazó la factura: ' + errs.map(x => x.msg).join(' | '));
    e.arcaRechazo = true; e.arcaCodes = errs.map(x => x.code);
    throw e;
  }
  const resultado = tag(body, 'Resultado');
  const cae = tag(body, 'CAE');
  const caeVto = tag(body, 'CAEFchVto');
  if (resultado !== 'A' || !cae) {
    if (!resultado) {
      // Respuesta incompleta: no sabemos si quedó autorizada.
      const e = new Error('ARCA devolvió una respuesta incompleta');
      e.arcaNetwork = true;
      throw e;
    }
    const obs = tag(body, 'Observaciones');
    const msgs = [];
    if (obs) {
      const re = /<(?:\w+:)?Obs>([\s\S]*?)<\/(?:\w+:)?Obs>/g; let m;
      while ((m = re.exec(obs))) msgs.push(unescapeXml(tag(m[1], 'Msg') || ''));
    }
    const e = new Error('ARCA rechazó la factura: ' + (msgs.filter(Boolean).join(' | ') || resultado));
    e.arcaRechazo = true;
    throw e;
  }
  return { nro, cae, caeVto, fecha };
}

// ---------- QR (RG 4892) ----------
function buildQR({ cuit, ptoVta, tipoCmp, nroCmp, importe, tipoDocRec, nroDocRec, cae, fecha }) {
  const payload = {
    ver: 1,
    fecha: (fecha || fechaHoyAR()).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
    cuit: Number(cuit),
    ptoVta: Number(ptoVta),
    tipoCmp: Number(tipoCmp),
    nroCmp: Number(nroCmp),
    importe: Number(importe),
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: Number(tipoDocRec) || 99,
    nroDocRec: Number(nroDocRec) || 0,
    tipoCodAut: 'E',
    codAut: Number(cae)
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return 'https://www.afip.gob.ar/fe/qr/?p=' + b64;
}

// ---------- Generar clave + CSR (para que el dueño no use openssl) ----------
function generarKeyYCSR(cuit, razonSocial) {
  const c = soloDigitos(cuit);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { shortName: 'C', value: 'AR' },
    { shortName: 'O', value: (razonSocial || 'Restaurante').slice(0, 60) },
    { shortName: 'CN', value: 'gestiva' },
    { name: 'serialNumber', value: 'CUIT ' + c }
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    csrPem: forge.pki.certificationRequestToPem(csr)
  };
}

// Vencimiento del certificado cargado (los de ARCA duran 2 años).
function vencimientoCertificado(certPem) {
  try { return forge.pki.certificateFromPem(certPem).validity.notAfter; }
  catch (e) { return null; }
}

// ---------- Importes ----------
// A/B: neto + IVA 21% contenido en el total. C: el total sin discriminar.
function calcularImportes(letra, importeTotal) {
  const impTotal = Math.round(Number(importeTotal) * 100) / 100;
  const impNeto = letra === 'C' ? impTotal : Math.round((impTotal / 1.21) * 100) / 100;
  const impIVA = letra === 'C' ? 0 : Math.round((impTotal - impNeto) * 100) / 100;
  return { impTotal, impNeto, impIVA };
}

// ---------- Orquestador: emitir (o recuperar) una factura ----------
// tenant: fila de tenants (fiscal_*).
// venta: { docTipo, docNro, condicionReceptor, importeTotal, nombre, domicilio }
// opts: {
//   store:     { get(env), set(env, ta) }   — persistencia del ticket de acceso
//   reservado: { nro, cbteTipo, ptoVta, impTotal, docNro, fecha } — intento anterior
//              que quedó sin respuesta (corte, timeout). Se consulta a ARCA antes
//              de pedir un número nuevo: si ya estaba autorizado, se recupera el
//              CAE en vez de emitir una segunda factura.
//   onReserva: async (nro, fecha) — se llama justo antes de pedir el CAE, para
//              que quien llama guarde el número reservado.
// }
async function emitirFactura(tenant, venta, opts) {
  opts = opts || {};
  const env = tenant.fiscal_env === 'produccion' ? 'produccion' : 'homologacion';
  const faltan = validarEmisor(tenant);
  if (faltan.length) {
    const e = new Error('Faltan datos fiscales del restaurante: ' + faltan.join(', ') + '. Completalos en Ajustes → Datos fiscales.');
    e.validacion = true;
    throw e;
  }
  const cuit = soloDigitos(tenant.fiscal_cuit);
  const rec = normalizarReceptor(tenant.fiscal_condition, venta);
  if (rec.error) { const e = new Error(rec.error); e.validacion = true; throw e; }

  const letra = rec.letra;
  const cbteTipo = cbteTipoFor(tenant.fiscal_condition, letra);
  const ptoVta = Number(tenant.fiscal_pto_vta);
  const { impTotal, impNeto, impIVA } = calcularImportes(letra, venta.importeTotal);
  if (!(impTotal > 0)) { const e = new Error('El importe a facturar tiene que ser mayor a cero.'); e.validacion = true; throw e; }

  const login = () => wsaaLogin(cuit, tenant.fiscal_cert, tenant.fiscal_key, env, opts.store);
  let ta = await login();
  // Si ARCA no reconoce el ticket guardado, se pide uno nuevo una sola vez.
  const conTA = async (fn) => {
    try { return await fn(ta); }
    catch (e) {
      if (e.arcaCodes && e.arcaCodes.some(c => ERR_TOKEN.includes(String(c)))) {
        olvidarTA(cuit, env);
        if (opts.store && opts.store.clear) { try { await opts.store.clear(env); } catch (_) {} }
        ta = await wsaaLogin(cuit, tenant.fiscal_cert, tenant.fiscal_key, env, null);
        return await fn(ta);
      }
      throw e;
    }
  };

  const armar = (cae, d) => {
    d = d || { letra, cbteTipo, ptoVta, rec, impTotal };
    const imps = calcularImportes(d.letra, d.impTotal);
    const qrUrl = buildQR({
      cuit, ptoVta: d.ptoVta, tipoCmp: d.cbteTipo, nroCmp: cae.nro, importe: imps.impTotal,
      tipoDocRec: d.rec.docTipo, nroDocRec: d.rec.docNro, cae: cae.cae, fecha: cae.fecha
    });
    return {
      letra: d.letra, cbteTipo: d.cbteTipo, ptoVta: d.ptoVta, nro: cae.nro,
      cae: cae.cae, caeVto: cae.caeVto, fecha: cae.fecha,
      docTipo: d.rec.docTipo, docNro: d.rec.docNro,
      condIvaReceptorId: d.rec.condIvaReceptorId,
      condIvaReceptor: COND_IVA_LABEL[d.rec.condIvaReceptorId],
      receptorNombre: d.rec.nombre || '', receptorDomicilio: d.rec.domicilio || '',
      impNeto: imps.impNeto, impIVA: imps.impIVA, impTotal: imps.impTotal, qrUrl, env,
      recuperada: !!cae.recuperada
    };
  };

  // 1) ¿Quedó un intento anterior sin respuesta? Antes de pedir un número nuevo
  //    le preguntamos a ARCA por el número reservado, con los datos de AQUEL
  //    intento (si el cajero corrigió el cliente o la letra, igual hay que
  //    saber si la primera salió: si salió, esa es la factura de la venta).
  const prev = opts.reservado;
  if (prev && prev.nro && prev.cbteTipo && prev.ptoVta) {
    const enArca = await conTA(t => consultarComprobante(t, Number(prev.ptoVta), Number(prev.cbteTipo), Number(prev.nro), env));
    if (enArca && enArca.cae) {
      const prevTotal = Number(prev.impTotal != null ? prev.impTotal : impTotal);
      const prevDocTipo = Number(prev.docTipo != null ? prev.docTipo : rec.docTipo);
      const prevDocNro = String(prev.docNro != null ? prev.docNro : rec.docNro);
      const mismoImporte = Math.abs(enArca.impTotal - prevTotal) < 0.01;
      const mismoDoc = enArca.docTipo === prevDocTipo && Number(enArca.docNro) === Number(prevDocNro);
      const ajena = opts.numeroUsadoPorOtra ? await opts.numeroUsadoPorOtra(prev) : false;
      if (mismoImporte && mismoDoc && !ajena) {
        const prevLetra = prev.letra || ({ 1: 'A', 6: 'B', 11: 'C' })[Number(prev.cbteTipo)] || letra;
        const prevRec = {
          docTipo: prevDocTipo, docNro: prevDocNro,
          condIvaReceptorId: condIvaId(prev.condIvaReceptorId) || rec.condIvaReceptorId,
          nombre: prev.nombre != null ? prev.nombre : rec.nombre,
          domicilio: prev.domicilio != null ? prev.domicilio : rec.domicilio
        };
        return armar(
          { nro: enArca.nro, cae: enArca.cae, caeVto: enArca.caeVto, fecha: enArca.cbteFch, recuperada: true },
          { letra: prevLetra, cbteTipo: Number(prev.cbteTipo), ptoVta: Number(prev.ptoVta), rec: prevRec, impTotal: prevTotal }
        );
      }
      // Ese número lo tiene otro comprobante: el nuestro nunca llegó a ARCA.
    }
  }

  // 2) Número nuevo = último autorizado + 1. Se reserva ANTES de pedir el CAE.
  const ultimo = await conTA(t => ultimoComprobante(t, ptoVta, cbteTipo, env));
  const nro = ultimo + 1;
  const fecha = fechaHoyAR();
  if (opts.onReserva) {
    await opts.onReserva({ nro, cbteTipo, ptoVta, fecha, letra, impTotal,
      docTipo: rec.docTipo, docNro: rec.docNro, condIvaReceptorId: rec.condIvaReceptorId,
      nombre: rec.nombre, domicilio: rec.domicilio });
  }

  const cae = await conTA(t => solicitarCAE(t, {
    nro, ptoVta, cbteTipo, letra, fecha,
    docTipo: rec.docTipo, docNro: rec.docNro, condIvaReceptorId: rec.condIvaReceptorId,
    impTotal, impNeto, impIVA, concepto: 1
  }, env));
  return armar(cae);
}

module.exports = {
  emitirFactura, generarKeyYCSR, wsaaLogin, solicitarCAE, ultimoComprobante, consultarComprobante,
  buildQR, letraFactura, cbteTipoFor, condIvaId, cuitValido, dniValido, normalizarReceptor,
  validarEmisor, fechaHoyAR, calcularImportes, vencimientoCertificado,
  COND_IVA, COND_IVA_LABEL, COND_CLASE_A, COND_MONOTRIBUTO, CONDICION_EMISOR_LABEL,
  LEYENDA_27618, TOPE_CONSUMIDOR_FINAL,
  _internals: { feErrores, tag, escapeXml, ENDPOINTS, _setTransport, olvidarTA, _taCache }
};
