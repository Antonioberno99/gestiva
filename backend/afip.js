/* ============================================================
   Gestiva — Integración directa con ARCA (ex-AFIP)
   Factura electrónica: WSAA (login) + WSFEv1 (CAE) + QR (RG 4892).
   Sin terceros: cada restaurante usa SU certificado y clave.
   ------------------------------------------------------------
   Requiere: node-forge (firma CMS del TRA).
   ⚠️ v1 — se valida con la primera factura real contra ARCA y se ajusta.
   ============================================================ */
'use strict';
const https = require('https');
const forge = require('node-forge');

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

// Tipo de comprobante (código ARCA) según condición del emisor + tipo de factura
//  Factura A=1, B=6, C=11. Nota de crédito A=3,B=8,C=13.
function cbteTipoFor(condicion, letra) {
  const map = { A: 1, B: 6, C: 11 };
  return map[letra] || 11;
}
// Letra de factura según condición del EMISOR y del receptor
function letraFactura(condicionEmisor, docTipoReceptor, condicionReceptor) {
  if (condicionEmisor === 'monotributo' || condicionEmisor === 'exento') return 'C';
  // Responsable inscripto: A si el receptor es RI con CUIT, si no B
  if (condicionEmisor === 'responsable_inscripto') {
    return (docTipoReceptor === 80 && condicionReceptor === 'responsable_inscripto') ? 'A' : 'B';
  }
  return 'C';
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
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout ARCA')); });
    req.write(data); req.end();
  });
}

function unescapeXml(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function tag(xml, name) {
  const m = xml.match(new RegExp('<(?:\\w+:)?' + name + '>([\\s\\S]*?)</(?:\\w+:)?' + name + '>'));
  return m ? m[1] : null;
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

// Cache de tokens por CUIT+entorno (el TA vale ~12h)
const _taCache = new Map();
async function wsaaLogin(cuit, certPem, keyPem, env) {
  const key = cuit + '|' + env;
  const cached = _taCache.get(key);
  if (cached && cached.exp > Date.now() + 60000) return cached;

  const cms = signTRA(buildTRA('wsfe'), certPem, keyPem);
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const r = await postSoap(ENDPOINTS[env].wsaa, envelope, '');
  const ret = tag(r.body, 'loginCmsReturn');
  if (!ret) throw new Error('WSAA sin respuesta: ' + r.body.slice(0, 300));
  const ticket = unescapeXml(ret);
  const token = tag(ticket, 'token');
  const sign = tag(ticket, 'sign');
  const expStr = tag(ticket, 'expirationTime');
  if (!token || !sign) throw new Error('WSAA no devolvió token/sign: ' + ticket.slice(0, 300));
  const ta = { token, sign, cuit, exp: expStr ? new Date(expStr).getTime() : Date.now() + 11 * 3600000 };
  _taCache.set(key, ta);
  return ta;
}

// ---------- WSFEv1 ----------
function fevHeader(ta) {
  return `<ar:Auth><ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign><ar:Cuit>${ta.cuit}</ar:Cuit></ar:Auth>`;
}
async function feCallSoap(env, action, innerXml) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
<soapenv:Header/><soapenv:Body>${innerXml}</soapenv:Body></soapenv:Envelope>`;
  const r = await postSoap(ENDPOINTS[env].wsfe, envelope, 'http://ar.gov.afip.dif.FEV1/' + action);
  return r.body;
}

// Último número autorizado para (ptoVta, cbteTipo)
async function ultimoComprobante(ta, ptoVta, cbteTipo, env) {
  const inner = `<ar:FECompUltimoAutorizado>${fevHeader(ta)}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FECompUltimoAutorizado>`;
  const body = await feCallSoap(env, 'FECompUltimoAutorizado', inner);
  const err = tag(body, 'Errors');
  if (err && tag(err, 'Msg')) throw new Error('ARCA (ult. comprobante): ' + tag(err, 'Msg'));
  return parseInt(tag(body, 'CbteNro') || '0', 10);
}

// Solicita el CAE para una factura. data = { ptoVta, cbteTipo, letra, docTipo, docNro,
//   impTotal, impNeto, impIVA, fecha(YYYYMMDD), concepto }
async function solicitarCAE(ta, data, env) {
  const nro = (await ultimoComprobante(ta, data.ptoVta, data.cbteTipo, env)) + 1;
  const fecha = data.fecha || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const esC = data.letra === 'C'; // C no discrimina IVA
  const impNeto = esC ? (data.impTotal).toFixed(2) : (data.impNeto).toFixed(2);
  const impIVA = esC ? '0.00' : (data.impIVA).toFixed(2);
  // Para A/B: detalle de IVA (alícuota 21% = Id 5). Para C: sin IVA.
  const ivaXml = esC ? '' :
    `<ar:Iva><ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>${impNeto}</ar:BaseImp><ar:Importe>${impIVA}</ar:Importe></ar:AlicIva></ar:Iva>`;
  const inner =
`<ar:FECAESolicitar>${fevHeader(ta)}<ar:FeCAEReq>
<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${data.ptoVta}</ar:PtoVta><ar:CbteTipo>${data.cbteTipo}</ar:CbteTipo></ar:FeCabReq>
<ar:FeDetReq><ar:FECAEDetRequest>
<ar:Concepto>${data.concepto || 1}</ar:Concepto>
<ar:DocTipo>${data.docTipo}</ar:DocTipo><ar:DocNro>${data.docNro || 0}</ar:DocNro>
<ar:CbteDesde>${nro}</ar:CbteDesde><ar:CbteHasta>${nro}</ar:CbteHasta><ar:CbteFch>${fecha}</ar:CbteFch>
<ar:ImpTotal>${(data.impTotal).toFixed(2)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc>
<ar:ImpNeto>${impNeto}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>${impIVA}</ar:ImpIVA>
<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>
${ivaXml}
</ar:FECAEDetRequest></ar:FeDetReq>
</ar:FeCAEReq></ar:FECAESolicitar>`;
  const body = await feCallSoap(env, 'FECAESolicitar', inner);
  const errs = tag(body, 'Errors');
  if (errs && tag(errs, 'Msg')) throw new Error('ARCA (CAE): ' + tag(errs, 'Msg'));
  const resultado = tag(body, 'Resultado');
  const cae = tag(body, 'CAE');
  const caeVto = tag(body, 'CAEFchVto');
  if (resultado !== 'A' || !cae) {
    const obs = tag(body, 'Observaciones');
    throw new Error('ARCA rechazó el comprobante: ' + (obs ? unescapeXml(tag(obs, 'Msg') || '') : (resultado || 'sin CAE')));
  }
  return { nro, cae, caeVto, fecha };
}

// ---------- QR (RG 4892) ----------
function buildQR({ cuit, ptoVta, tipoCmp, nroCmp, importe, tipoDocRec, nroDocRec, cae, fecha }) {
  const payload = {
    ver: 1,
    fecha: (fecha || new Date().toISOString().slice(0, 10).replace(/-/g, '')).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
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

// ---------- Orquestador: emitir una factura ----------
// tenant: fila de la tabla tenants (fiscal_*). venta: { docTipo, docNro, condicionReceptor, importeTotal }
async function emitirFactura(tenant, venta) {
  const env = tenant.fiscal_env === 'produccion' ? 'produccion' : 'homologacion';
  if (!tenant.fiscal_cert || !tenant.fiscal_key) throw new Error('Falta el certificado/clave fiscal del restaurante.');
  if (!tenant.fiscal_pto_vta) throw new Error('Falta el punto de venta.');
  const cuit = String(tenant.fiscal_cuit || '').replace(/\D/g, '');
  if (cuit.length !== 11) throw new Error('CUIT inválido.');

  const ta = await wsaaLogin(cuit, tenant.fiscal_cert, tenant.fiscal_key, env);
  const docTipo = venta.docTipo || 99;          // 80=CUIT, 96=DNI, 99=consumidor final
  const letra = letraFactura(tenant.fiscal_condition, docTipo, venta.condicionReceptor);
  const cbteTipo = cbteTipoFor(tenant.fiscal_condition, letra);
  const impTotal = Math.round(Number(venta.importeTotal) * 100) / 100;
  // A/B: separar neto+IVA 21%. C: el total va sin discriminar.
  const impNeto = letra === 'C' ? impTotal : Math.round((impTotal / 1.21) * 100) / 100;
  const impIVA = letra === 'C' ? 0 : Math.round((impTotal - impNeto) * 100) / 100;

  const cae = await solicitarCAE(ta, {
    ptoVta: tenant.fiscal_pto_vta, cbteTipo, letra,
    docTipo, docNro: venta.docNro || 0, impTotal, impNeto, impIVA, concepto: 1
  }, env);

  const qrUrl = buildQR({
    cuit, ptoVta: tenant.fiscal_pto_vta, tipoCmp: cbteTipo, nroCmp: cae.nro,
    importe: impTotal, tipoDocRec: docTipo, nroDocRec: venta.docNro || 0, cae: cae.cae, fecha: cae.fecha
  });

  return {
    letra, cbteTipo, ptoVta: tenant.fiscal_pto_vta, nro: cae.nro,
    cae: cae.cae, caeVto: cae.caeVto, fecha: cae.fecha,
    docTipo, docNro: venta.docNro || 0,
    impNeto, impIVA, impTotal, qrUrl, env
  };
}

module.exports = { emitirFactura, wsaaLogin, solicitarCAE, ultimoComprobante, buildQR, letraFactura, cbteTipoFor };
