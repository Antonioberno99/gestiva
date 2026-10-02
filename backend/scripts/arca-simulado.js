// ARCA simulado para tests: WSAA + WSFEv1 en memoria, con las validaciones del
// real que importan (CondicionIVAReceptorId en su lugar, letra vs condición IVA,
// numeración correlativa, fecha argentina, ticket vigente).
'use strict';
const forge = require('node-forge');

// ---------- Certificado de prueba (para que la firma CMS funcione de verdad) ----------
function certificadoDePrueba() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 86400000);
  const attrs = [{ shortName: 'CN', value: 'gestiva' }, { name: 'serialNumber', value: 'CUIT 20111111112' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

// ---------- ARCA simulado ----------
const hoyAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');
const tag = (x, n) => { const m = String(x).match(new RegExp('<(?:\\w+:)?' + n + '>([\\s\\S]*?)</(?:\\w+:)?' + n + '>')); return m ? m[1] : null; };
const CLASE = { 1: 'A', 6: 'B', 11: 'C' };
const ACEPTA = { A: [1, 6, 13, 16], B: [4, 5, 7, 8, 9, 10, 15], C: [1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16] };

function arcaSimulado() {
  const st = { ta: null, logins: 0, comprobantes: new Map(), cortarProxima: false, ultimoXml: '' };
  const soap = (inner) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
  const err = (accion, code, msg) => ({ status: 200, body: soap(`<${accion}Response><${accion}Result><Errors><Err><Code>${code}</Code><Msg>${msg}</Msg></Err></Errors></${accion}Result></${accion}Response>`) });
  const lista = (pv, tipo) => { const k = pv + '|' + tipo; if (!st.comprobantes.has(k)) st.comprobantes.set(k, []); return st.comprobantes.get(k); };

  async function transport(url, body, action) {
    if (/LoginCms/.test(url)) {
      if (st.ta && st.ta.exp > Date.now()) {
        return { status: 500, body: soap('<soap:Fault><faultcode>ns1:coe.alreadyAuthenticated</faultcode><faultstring>El CEE ya posee un TA valido para el acceso al WSN solicitado</faultstring></soap:Fault>') };
      }
      st.logins++;
      st.ta = { token: 'TOK' + st.logins, sign: 'SIG' + st.logins, exp: Date.now() + 12 * 3600000 };
      const ticket = `<loginTicketResponse><header><expirationTime>${new Date(st.ta.exp).toISOString()}</expirationTime></header><credentials><token>${st.ta.token}</token><sign>${st.ta.sign}</sign></credentials></loginTicketResponse>`;
      const esc = ticket.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return { status: 200, body: soap(`<loginCmsResponse><loginCmsReturn>${esc}</loginCmsReturn></loginCmsResponse>`) };
    }
    const accion = String(action).split('/').pop();
    if (tag(body, 'Token') !== (st.ta && st.ta.token)) return err(accion, '600', 'ValidacionDeToken: No validaron las firmas digitales');

    if (accion === 'FECompUltimoAutorizado') {
      const l = lista(tag(body, 'PtoVta'), tag(body, 'CbteTipo'));
      const n = l.length ? l[l.length - 1].nro : 0;
      return { status: 200, body: soap(`<FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><CbteNro>${n}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`) };
    }
    if (accion === 'FECompConsultar') {
      const l = lista(tag(body, 'PtoVta'), tag(body, 'CbteTipo'));
      const c = l.find(x => x.nro === Number(tag(body, 'CbteNro')));
      if (!c) return err(accion, '602', 'No existen datos en nuestros registros para los parametros ingresados.');
      return { status: 200, body: soap(`<FECompConsultarResponse><FECompConsultarResult><ResultGet><CbteFch>${c.fecha}</CbteFch><ImpTotal>${c.impTotal}</ImpTotal><DocTipo>${c.docTipo}</DocTipo><DocNro>${c.docNro}</DocNro><CodAutorizacion>${c.cae}</CodAutorizacion><FchVto>${c.caeVto}</FchVto><Resultado>A</Resultado></ResultGet></FECompConsultarResult></FECompConsultarResponse>`) };
    }
    if (accion === 'FECAESolicitar') {
      st.ultimoXml = body;
      const pv = tag(body, 'PtoVta'), tipo = Number(tag(body, 'CbteTipo'));
      const l = lista(pv, tipo);
      const nro = Number(tag(body, 'CbteDesde'));
      const cond = tag(body, 'CondicionIVAReceptorId');
      if (cond === null) return err(accion, '10242', 'El campo Condicion Frente al IVA del receptor es obligatorio');
      const iCond = body.indexOf('CondicionIVAReceptorId'), iCot = body.indexOf('MonCotiz'), iIva = body.indexOf('<ar:Iva>');
      if (iCond < iCot || (iIva >= 0 && iCond > iIva)) return err(accion, '10242', 'CondicionIVAReceptorId fuera de lugar (ARCA lo ignora)');
      if (!ACEPTA[CLASE[tipo]].includes(Number(cond))) return err(accion, '10243', `La condicion IVA ${cond} no corresponde a la clase ${CLASE[tipo]}`);
      const ultimo = l.length ? l[l.length - 1].nro : 0;
      if (nro !== ultimo + 1) return err(accion, '10016', 'El numero o fecha del comprobante no se corresponde con el proximo a autorizar');
      if (tag(body, 'CbteFch') !== hoyAR()) return err(accion, '10017', 'Fecha ' + tag(body, 'CbteFch') + ' distinta de hoy en Argentina ' + hoyAR());
      const tot = parseFloat(tag(body, 'ImpTotal')), net = parseFloat(tag(body, 'ImpNeto')), iva = parseFloat(tag(body, 'ImpIVA'));
      if (Math.abs(tot - net - iva) > 0.01) return err(accion, '10048', 'ImpTotal no coincide con la suma de importes');
      const c = { nro, fecha: tag(body, 'CbteFch'), impTotal: tot, docTipo: Number(tag(body, 'DocTipo')), docNro: tag(body, 'DocNro'),
                  cae: String(70000000000000 + l.length + 1 + tipo * 1000), caeVto: '20261231', cond: Number(cond) };
      l.push(c);
      if (st.cortarProxima) {   // ARCA la autoriza pero la respuesta nunca llega
        st.cortarProxima = false;
        const e = new Error('socket hang up'); e.arcaNetwork = true; throw e;
      }
      return { status: 200, body: soap(`<FECAESolicitarResponse><FECAESolicitarResult><FeCabResp><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><Resultado>A</Resultado><CAE>${c.cae}</CAE><CAEFchVto>${c.caeVto}</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`) };
    }
    return { status: 500, body: soap('<soap:Fault><faultstring>accion desconocida ' + accion + '</faultstring></soap:Fault>') };
  }
  return { st, transport };
}


module.exports = { arcaSimulado, certificadoDePrueba, hoyAR };
