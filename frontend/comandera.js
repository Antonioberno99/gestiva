/* ============================================================
   Gestiva — Comandera (impresión de pedidos)
   Soporta TODAS las formas de imprimir el pedido del mozo:
     1) Pantalla de cocina (KDS)  -> ya lo maneja el backend
     2) Por navegador             -> window.print() (cualquier impresora del sistema)
     3) Bluetooth (térmica ESC/POS) -> Web Bluetooth
     4) USB instalada en Windows    -> Gestiva Print Agent local -> cola de impresion
     5) Red / WiFi (IP)            -> Gestiva Print Agent local -> impresora IP:9100
   Config por dispositivo (localStorage), porque la impresora es física del equipo.
   API pública:  window.Comandera = { getCfg, setCfg, print, testPrint, openConfig, ticketHTML }
   ============================================================ */
(function () {
  'use strict';

  const LS_KEY = 'gestiva_comandera_cfg';
  const DEFAULTS = {
    method: 'browser',     // 'screen' | 'browser' | 'bluetooth' | 'usb' | 'network'
    paper: 58,             // 58 | 80 (mm)
    copies: 1,             // 1..3 (ej: cocina + barra)
    autoprint: true,       // (celular) imprimir al enviar a cocina. En el modelo "Fudo" el celular NO imprime.
    kitchenAuto: false,    // (PC estación) imprimir SOLA cada comanda nueva de cocina
    header: '',            // nombre que sale arriba (si vacío usa el del restaurante)
    footer: '',            // pie opcional
    bridgeUrl: 'http://127.0.0.1:7777/print', // agente local para impresoras
    printerMode: '',       // 'windows' | 'network'
    printerName: '',       // nombre de la impresora instalada en Windows (USB)
    printerIp: '',         // IP de la impresora de red
    printerPort: 9100      // puerto ESC/POS estándar
  };
  const DEFAULT_API_URL = 'https://gestiva-backend.onrender.com';

  function getCfg() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch { return Object.assign({}, DEFAULTS); }
  }
  function setCfg(c) { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(getCfg(), c))); }

  // ---------- Utilidades de texto ----------
  const charsPerLine = (paper) => (paper === 80 ? 48 : 32);

  // Translitera acentos/ñ a ASCII para impresoras térmicas (garantiza legibilidad en cualquier modelo)
  function ascii(s) {
    return (s == null ? '' : String(s))
      .replace(/[áàäâ]/g, 'a').replace(/[ÁÀÄÂ]/g, 'A')
      .replace(/[éèëê]/g, 'e').replace(/[ÉÈËÊ]/g, 'E')
      .replace(/[íìïî]/g, 'i').replace(/[ÍÌÏÎ]/g, 'I')
      .replace(/[óòöô]/g, 'o').replace(/[ÓÒÖÔ]/g, 'O')
      .replace(/[úùüû]/g, 'u').replace(/[ÚÙÜÛ]/g, 'U')
      .replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
      .replace(/[¡!]/g, '!').replace(/[¿?]/g, '?')
      .replace(/[^\x20-\x7E]/g, ''); // descarta lo que no sea ASCII imprimible
  }
  function wrap(text, width) {
    const words = ascii(text).split(/\s+/);
    const lines = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > width) { if (cur) lines.push(cur); cur = w; }
      else cur = (cur ? cur + ' ' : '') + w;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtDateTime(d) {
    d = d || new Date();
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  // "Comanda #" corto y legible a partir del id (uuid) o la hora
  function shortRef(ticket) {
    if (ticket.ref) return String(ticket.ref);
    if (ticket.ticketId) return String(ticket.ticketId).replace(/-/g, '').slice(-6).toUpperCase();
    const d = ticket.datetime || new Date();
    return pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  // ---------- 1) Render HTML (navegador + preview) ----------
  function ticketHTML(ticket, cfg) {
    cfg = cfg || getCfg();
    const w = cfg.paper === 80 ? '76mm' : '54mm'; // ancho útil (papel menos márgenes)
    const head = (cfg.header || ticket.restaurant || 'Gestiva');
    const rows = (ticket.items || []).map(it => {
      const mods = (it.modifiers || []).map(m => `<div class="mod">+ ${escapeHTML(m)}</div>`).join('');
      const note = it.notes ? `<div class="note">! ${escapeHTML(it.notes)}</div>` : '';
      return `<div class="item"><span class="qty">${it.qty}x</span><span class="nm">${escapeHTML(it.name)}</span>${mods}${note}</div>`;
    }).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: ${cfg.paper}mm auto; margin: 0; }
      * { box-sizing: border-box; }
      html,body { margin:0; padding:0; }
      .tk { width:${w}; padding:4mm 2mm; font-family:'Courier New',monospace; color:#000; }
      .ctr { text-align:center; }
      .rest { font-size:${cfg.paper === 80 ? 20 : 16}px; font-weight:800; text-transform:uppercase; letter-spacing:1px; }
      .hr { border-top:1px dashed #000; margin:6px 0; }
      .mesa { font-size:${cfg.paper === 80 ? 30 : 24}px; font-weight:800; text-align:center; margin:4px 0; }
      .meta { font-size:12px; line-height:1.5; }
      .item { margin:6px 0; font-size:${cfg.paper === 80 ? 17 : 15}px; font-weight:700; }
      .item .qty { display:inline-block; min-width:30px; }
      .mod { font-size:13px; font-weight:400; padding-left:30px; }
      .note { font-size:13px; font-weight:700; padding-left:30px; text-transform:uppercase; }
      .foot { text-align:center; font-size:12px; margin-top:8px; }
    </style></head><body><div class="tk">
      <div class="ctr rest">${escapeHTML(head)}</div>
      <div class="hr"></div>
      <div class="mesa">${ticket.table ? 'MESA ' + escapeHTML(ticket.table) : 'PARA LLEVAR'}</div>
      <div class="meta ctr">
        ${ticket.waiter ? 'Mozo: ' + escapeHTML(ticket.waiter) + '<br>' : ''}
        ${fmtDateTime(ticket.datetime)} · #${shortRef(ticket)}
      </div>
      <div class="hr"></div>
      ${rows || '<div class="item">(sin items)</div>'}
      <div class="hr"></div>
      <div class="foot">-- COCINA --${cfg.footer ? '<br>' + escapeHTML(cfg.footer) : ''}</div>
    </div></body></html>`;
  }
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 2) Codificación ESC/POS (Bluetooth / USB / Red) ----------
  function escpos(ticket, cfg) {
    cfg = cfg || getCfg();
    const W = charsPerLine(cfg.paper);
    const enc = new TextEncoder(); // ASCII puro (ya transliteramos)
    const bytes = [];
    const push = (arr) => { for (const b of arr) bytes.push(b & 0xFF); };
    const text = (s) => push(Array.from(enc.encode(ascii(s))));
    const line = (s) => { text(s); push([0x0A]); };
    const center = (on) => push([0x1B, 0x61, on ? 1 : 0]);     // ESC a
    const bold = (on) => push([0x1B, 0x45, on ? 1 : 0]);       // ESC E
    const big = (on) => push([0x1D, 0x21, on ? 0x11 : 0x00]);  // GS ! (doble alto+ancho)
    const sep = () => line('-'.repeat(W));

    push([0x1B, 0x40]);            // ESC @  init
    center(true);
    bold(true); big(true);
    line(cfg.header || ticket.restaurant || 'Gestiva');
    big(false);
    bold(false);
    sep();
    // Mesa grande y centrada
    big(true); bold(true);
    line(ticket.table ? 'MESA ' + ticket.table : 'P/LLEVAR');
    big(false); bold(false);
    if (ticket.waiter) line('Mozo: ' + ticket.waiter);
    line(fmtDateTime(ticket.datetime) + '  #' + shortRef(ticket));
    center(false);
    sep();
    // Items
    bold(true);
    for (const it of (ticket.items || [])) {
      const prefix = (it.qty + 'x ');
      const nameLines = wrap(it.name, W - prefix.length);
      line(prefix + nameLines[0]);
      for (let i = 1; i < nameLines.length; i++) line(' '.repeat(prefix.length) + nameLines[i]);
      bold(false);
      for (const m of (it.modifiers || [])) wrap('+ ' + m, W - 2).forEach(l => line('  ' + l));
      if (it.notes) wrap('! ' + it.notes.toUpperCase(), W - 2).forEach(l => line('  ' + l));
      bold(true);
    }
    bold(false);
    sep();
    center(true);
    line('-- COCINA --');
    if (cfg.footer) line(cfg.footer);
    center(false);
    push([0x0A, 0x0A, 0x0A]);      // feed
    push([0x1D, 0x56, 0x42, 0x00]); // GS V B 0  corte parcial (con feed)
    return new Uint8Array(bytes);
  }

  // ---------- Métodos de impresión ----------
  // 2) Navegador (cualquier impresora instalada en el sistema)
  function printBrowser(ticket, cfg) {
    return new Promise((resolve) => {
      const html = ticketHTML(ticket, cfg);
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      document.body.appendChild(ifr);
      ifr.onload = () => {
        try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {}
        setTimeout(() => { ifr.remove(); resolve(true); }, 1500);
      };
      const doc = ifr.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
    });
  }

  // Helper: enviar bytes en bloques (las térmicas BT/USB tienen buffers chicos)
  async function writeChunks(writeFn, data, size) {
    for (let i = 0; i < data.length; i += size) {
      await writeFn(data.slice(i, i + size));
      await new Promise(r => setTimeout(r, 20));
    }
  }

  // 3) Bluetooth (Web Bluetooth + ESC/POS)
  let _btChar = null;
  async function getBluetoothChar() {
    if (_btChar && _btChar.service.device.gatt.connected) return _btChar;
    if (!navigator.bluetooth) throw new Error('Este navegador no soporta Bluetooth (usá Chrome en Android).');
    // Servicios comunes de impresoras térmicas
    const SERVICES = [0x18F0, 0xFF00, 0xFFE0, '000018f0-0000-1000-8000-00805f9b34fb'];
    const device = await navigator.bluetooth.requestDevice({
      filters: SERVICES.map(s => ({ services: [s] })).concat([{ namePrefix: 'Printer' }, { namePrefix: 'BT' }, { namePrefix: 'POS' }, { namePrefix: 'MTP' }, { namePrefix: 'MPT' }]),
      optionalServices: SERVICES
    });
    const server = await device.gatt.connect();
    let ch = null;
    for (const su of SERVICES) {
      try {
        const svc = await server.getPrimaryService(su);
        const chars = await svc.getCharacteristics();
        ch = chars.find(c => c.properties.write || c.properties.writeWithoutResponse) || chars[0];
        if (ch) break;
      } catch (e) {}
    }
    if (!ch) throw new Error('No encontré una característica de escritura en la impresora.');
    _btChar = ch;
    return ch;
  }
  async function printBluetooth(bytes) {
    const ch = await getBluetoothChar();
    const writeFn = ch.properties.writeWithoutResponse
      ? (d) => ch.writeValueWithoutResponse(d)
      : (d) => ch.writeValue(d);
    await writeChunks(writeFn, bytes, 180);
  }

  // 4) USB (WebUSB + ESC/POS)
  let _usbDev = null;
  async function getUsbDevice() {
    if (!navigator.usb) throw new Error('Este navegador no soporta USB (usá Chrome en compu o Android con OTG).');
    if (_usbDev && _usbDev.opened) return _usbDev;
    const dev = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }, {}] }); // 7 = printer
    await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);
    // Buscar interfaz con endpoint OUT
    let claimed = null, epOut = null;
    for (const cfg of dev.configurations) {
      for (const intf of cfg.interfaces) {
        for (const alt of intf.alternates) {
          const out = alt.endpoints.find(e => e.direction === 'out');
          if (out) { claimed = intf; epOut = out.endpointNumber; break; }
        }
        if (claimed) break;
      }
      if (claimed) break;
    }
    if (!claimed) throw new Error('No encontré la interfaz de impresión USB.');
    try { await dev.claimInterface(claimed.interfaceNumber); } catch (e) {}
    dev._epOut = epOut;
    _usbDev = dev;
    return dev;
  }
  async function printUSB(bytes) {
    const dev = await getUsbDevice();
    await writeChunks((d) => dev.transferOut(dev._epOut, d), bytes, 4096);
  }

  function bridgeBaseUrl(cfg) {
    return ((cfg && cfg.bridgeUrl) || DEFAULTS.bridgeUrl).replace(/\/print\/?$/, '').replace(/\/$/, '');
  }
  async function fetchJson(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 3500);
    try {
      const r = await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
      const text = await r.text();
      const data = text ? JSON.parse(text) : {};
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    } finally {
      clearTimeout(t);
    }
  }
  async function checkBridge(cfg) {
    try {
      return await fetchJson(bridgeBaseUrl(cfg) + '/health', null, 2500);
    } catch (e) {
      throw new Error('No detecto el agente de impresion en esta PC. Toca "Instalar / actualizar puente de comandera", abri el archivo descargado y despues volve a buscar comanderas.');
    }
  }
  async function probeNetworkPrinter(cfg) {
    if (!cfg.printerIp) throw new Error('Falta la IP de la comandera.');
    await checkBridge(cfg);
    const url = bridgeBaseUrl(cfg) + '/probe?ip=' + encodeURIComponent(cfg.printerIp) + '&port=' + encodeURIComponent(cfg.printerPort || 9100);
    const data = await fetchJson(url, null, 3500);
    if (!data.reachable) throw new Error('El puente esta activo, pero la comandera no responde en ' + cfg.printerIp + ':' + (cfg.printerPort || 9100) + '. Revisar IP, WiFi/red y puerto 9100.');
    return data;
  }

  async function createPrintStationToken() {
    const token = localStorage.getItem('gestiva_token');
    if (!token) throw new Error('Tenes que iniciar sesion en Gestiva para vincular esta PC.');
    const apiUrl = (window.API_URL || DEFAULT_API_URL).replace(/\/$/, '');
    if (!apiUrl) throw new Error('No encontre la URL del backend de Gestiva.');
    const r = await fetch(apiUrl + '/api/print-station/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'No pude crear la vinculacion de la estacion.');
    return Object.assign({ apiUrl }, data);
  }

  let _stationBase = 'http://127.0.0.1:7777';
  const STATION_BASES = ['http://127.0.0.1:7777', 'http://localhost:7777'];

  async function checkLocalPrintStation() {
    let lastError;
    for (const base of STATION_BASES) {
      try {
        const health = await fetchJson(base + '/health', null, 2200);
        _stationBase = base;
        return health;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error('No detecto la estacion de impresion.');
  }

  function stationMajorVersion(v) {
    return parseInt(String(v || '0').split('.')[0], 10) || 0;
  }

  async function ensurePrintStation() {
    let health;
    try {
      health = await checkLocalPrintStation();
    } catch (e) {
      throw new Error('No detecto la estacion de impresion en esta PC. Toca "Instalar / actualizar estacion", ejecuta el archivo y despues volve a conectar.');
    }
    if (!health || !health.ok || health.mode !== 'station' || stationMajorVersion(health.version) < 3) {
      throw new Error('Esta PC tiene una version vieja del puente de comandera. Toca "Instalar / actualizar estacion", ejecuta el archivo y despues volve a conectar.');
    }
    return health;
  }

  async function pairPrintStation() {
    const data = await createPrintStationToken();
    const publicApiUrl = ((window.API_URL || data.apiUrl || DEFAULT_API_URL)).replace(/\/$/, '');
    await fetchJson(_stationBase + '/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: data.token,
        apiUrl: publicApiUrl,
        restaurant: data.restaurant || ''
      })
    }, 6000);
    return data;
  }

  async function scanPrintStation(port) {
    return await fetchJson(_stationBase + '/scan?port=' + encodeURIComponent(port || 9100), null, 12000);
  }

  async function listPrintStationPrinters() {
    return await fetchJson(_stationBase + '/printers', null, 5000);
  }

  function bytesToBase64(bytes) {
    let b64 = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(b64);
  }

  async function savePrintStationPrinter(ip, port) {
    if (!ip) throw new Error('Falta la IP de la comandera.');
    return await fetchJson(_stationBase + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerIp: ip, printerPort: port || 9100 })
    }, 5000);
  }

  async function savePrintStationWindowsPrinter(printerName) {
    if (!printerName) throw new Error('Falta elegir la impresora USB.');
    return await fetchJson(_stationBase + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerMode: 'windows', printerName })
    }, 5000);
  }

  async function testPrintStation() {
    return await fetchJson(_stationBase + '/test', { method: 'POST' }, 9000);
  }

  // Impresoras USB conectadas pero sin instalar en Windows (para instalarlas de una)
  async function usbDetect() {
    return await fetchJson(_stationBase + '/usb-detect', null, 6000);
  }
  // Instala la USB conectada (crea la cola con driver Generic / Text Only) y devuelve su nombre
  async function usbInstall(port) {
    return await fetchJson(_stationBase + '/usb-install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(port ? { port } : {})
    }, 15000);
  }

  async function printWindowsPrinter(bytes, cfg) {
    if (!cfg.printerName) throw new Error('Falta elegir la impresora USB instalada en Windows.');
    await ensurePrintStation();
    return await fetchJson(_stationBase + '/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerName: cfg.printerName, data: bytesToBase64(bytes) })
    }, 9000);
  }

  // 5) Red / WiFi (IP) via Gestiva Print Agent local
  async function printNetwork(bytes, cfg) {
    if (!cfg.printerIp) throw new Error('Falta la IP de la impresora de red (configurala en Comandera).');
    const b64 = bytesToBase64(bytes);
    let r;
    try {
      r = await fetch(cfg.bridgeUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: cfg.printerIp, port: cfg.printerPort || 9100, data: b64 })
      });
    } catch (e) {
      throw new Error('No pude contactar el agente de impresion. Instala o actualiza el puente desde la configuracion de Comandera y volve a probar.');
    }
    if (!r.ok) throw new Error('El puente respondió con error ' + r.status + '.');
  }

  // ---------- Orquestador ----------
  async function print(ticket, opts) {
    const cfg = Object.assign(getCfg(), opts || {});
    if (cfg.method === 'screen') return { ok: true, method: 'screen' }; // solo KDS
    const copies = Math.max(1, Math.min(3, cfg.copies || 1));
    if (cfg.method === 'browser') {
      // El navegador imprime 1 hoja; para copias repetimos el bloque.
      for (let i = 0; i < copies; i++) await printBrowser(ticket, cfg);
      return { ok: true, method: 'browser' };
    }
    const bytes = escpos(ticket, cfg);
    const all = copies > 1 ? concatCopies(bytes, copies) : bytes;
    if (cfg.method === 'bluetooth') await printBluetooth(all);
    else if (cfg.method === 'usb') {
      if (cfg.printerName || cfg.printerMode === 'windows') await printWindowsPrinter(all, cfg);
      else await printUSB(all);
    }
    else if (cfg.method === 'network') await printNetwork(all, cfg);
    else throw new Error('Método de comandera desconocido: ' + cfg.method);
    return { ok: true, method: cfg.method };
  }
  function concatCopies(bytes, n) {
    const out = new Uint8Array(bytes.length * n);
    for (let i = 0; i < n; i++) out.set(bytes, i * bytes.length);
    return out;
  }

  function testPrint() {
    return print({
      restaurant: getCfg().header || 'GESTIVA',
      table: '5',
      waiter: 'Prueba',
      datetime: new Date(),
      ref: 'TEST',
      items: [
        { name: 'Milanesa napolitana', qty: 2, modifiers: ['sin papas'], notes: 'bien cocida' },
        { name: 'Coca-Cola 500ml', qty: 1, modifiers: [], notes: '' },
        { name: 'Flan con dulce', qty: 1, modifiers: ['extra dulce'], notes: '' }
      ]
    });
  }

  // ---------- UI de configuración (modal autocontenido) ----------
  const METHOD_LABELS = {
    screen: 'Solo pantalla de cocina',
    browser: 'Por navegador',
    bluetooth: 'Bluetooth',
    usb: 'USB',
    network: 'Red / WiFi'
  };

  // Tarjetas visuales: cada tipo de comandera con su explicación simple.
  const METHOD_CARDS = [
    { k: 'network',   code: 'RED', name: 'Red / WiFi',     desc: 'Impresora con IP propia en la red del local.' },
    { k: 'usb',       code: 'USB', name: 'USB',            desc: 'Cable directo a esta PC. Usa la impresora instalada en Windows.' },
    { k: 'bluetooth', code: 'BT',  name: 'Bluetooth',      desc: 'Termica portatil emparejada con este equipo.' },
    { k: 'browser',   code: 'PC',  name: 'Navegador',      desc: 'Abre el dialogo normal de impresion.' },
    { k: 'screen',    code: 'KDS', name: 'Solo pantalla',  desc: 'Los pedidos quedan en la pantalla de cocina.' }
  ];

  function openConfig() {
    const cfg = getCfg();
    const existing = document.getElementById('cmdr-modal');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'cmdr-modal';
    wrap.innerHTML = `
      <style>
        #cmdr-modal{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;font-family:'Inter',system-ui,sans-serif;}
        #cmdr-modal .sheet{background:#fff;width:100%;max-width:520px;max-height:92vh;overflow:auto;border-radius:20px 20px 0 0;padding:20px 18px 28px;box-shadow:0 -10px 40px rgba(0,0,0,.25);}
        @media(min-width:560px){#cmdr-modal{align-items:center}#cmdr-modal .sheet{border-radius:20px}}
        #cmdr-modal h2{font-size:19px;margin:0 0 2px;font-weight:800;color:#0f172a;}
        #cmdr-modal .sub{font-size:12.5px;color:#64748b;margin:0 0 16px;line-height:1.5;}
        #cmdr-modal label{display:block;font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 8px;}
        #cmdr-modal label .step{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#f97316;color:#fff;font-size:11px;margin-right:6px;vertical-align:middle;}
        #cmdr-modal input[type=text],#cmdr-modal input[type=number]{width:100%;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;font-family:inherit;}
        #cmdr-modal .row{display:flex;gap:10px;} #cmdr-modal .row>*{flex:1;}
        #cmdr-modal .cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
        #cmdr-modal .card{display:flex;flex-direction:column;gap:3px;padding:12px;border:2px solid #e2e8f0;border-radius:14px;background:#fff;cursor:pointer;text-align:left;font-family:inherit;transition:.12s;}
        #cmdr-modal .card:hover{border-color:#fdba74;}
        #cmdr-modal .card.on{border-color:#f97316;background:#fff7ed;}
        #cmdr-modal .card .code{display:inline-flex;align-items:center;justify-content:center;width:36px;height:24px;border-radius:999px;background:#f8fafc;color:#64748b;font-size:11px;font-weight:900;letter-spacing:.04em;}
        #cmdr-modal .card .nm{font-weight:800;font-size:14px;color:#0f172a;}
        #cmdr-modal .card .ds{font-size:11px;color:#64748b;line-height:1.35;}
        #cmdr-modal .card.wide{grid-column:1 / -1;flex-direction:row;align-items:center;gap:10px;}
        #cmdr-modal .card.wide .ds{flex:1;}
        #cmdr-modal .panel{margin-top:12px;padding:14px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;}
        #cmdr-modal .panel.hide{display:none;}
        #cmdr-modal .status{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;margin-bottom:10px;}
        #cmdr-modal .dot{width:9px;height:9px;border-radius:50%;background:#ef4444;flex:none;}
        #cmdr-modal .status.ok .dot{background:#10b981;} #cmdr-modal .status.ok{color:#047857;}
        #cmdr-modal .status.off{color:#b91c1c;}
        #cmdr-modal .btn-connect{width:100%;padding:13px;border:none;border-radius:12px;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;}
        #cmdr-modal .seg{display:flex;gap:6px;flex-wrap:wrap;}
        #cmdr-modal .seg button{flex:1;min-width:64px;padding:10px;border:1px solid #e2e8f0;background:#fff;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;color:#475569;font-family:inherit;}
        #cmdr-modal .seg button.on{background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;border-color:transparent;}
        #cmdr-modal .toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px;}
        #cmdr-modal .toggle span{font-size:14px;font-weight:600;color:#0f172a;text-transform:none;letter-spacing:0;}
        #cmdr-modal .sw{width:46px;height:26px;border-radius:999px;background:#cbd5e1;position:relative;cursor:pointer;flex:none;transition:.15s;}
        #cmdr-modal .sw.on{background:#10b981;}
        #cmdr-modal .sw::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.15s;}
        #cmdr-modal .sw.on::after{left:23px;}
        #cmdr-modal .btns{display:flex;gap:10px;margin-top:22px;}
        #cmdr-modal .btn{flex:1;padding:13px;border:none;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;}
        #cmdr-modal .btn-primary{background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;}
        #cmdr-modal .btn-ghost{background:#f1f5f9;color:#475569;}
        #cmdr-modal .btn-test{width:100%;margin-top:14px;padding:12px;border:1px dashed #f97316;background:#fff7ed;color:#ea580c;border-radius:12px;font-weight:700;cursor:pointer;font-family:inherit;}
        #cmdr-modal .flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:8px;margin:12px 0 16px;padding:12px;border:1px solid #e2e8f0;border-radius:14px;background:#f8fafc;color:#475569;font-size:12px;font-weight:800;text-align:center;}#cmdr-modal .flow .arr{color:#94a3b8;}#cmdr-modal .hint{font-size:11.5px;color:#94a3b8;margin-top:8px;line-height:1.5;}
        #cmdr-modal .msg{font-size:13px;margin-top:10px;padding:10px;border-radius:8px;display:none;}
        #cmdr-modal .msg.ok{display:block;background:#d1fae5;color:#047857;}
        #cmdr-modal .msg.err{display:block;background:#fee2e2;color:#b91c1c;}
      </style>
      <div class="sheet">
        <h2>Conectar comandera</h2>
        <p class="sub">Elegí cómo está conectada la comandera en este local. Gestiva conserva todos los métodos: USB, red/IP, Bluetooth, navegador o pantalla.</p>
        <div class="flow"><span>App equipo</span><span class="arr">&rarr;</span><span>Panel central</span><span class="arr">&rarr;</span><span>Comandera</span></div>
        <div class="status off" id="cmdr-main-status"><span class="dot"></span><span id="cmdr-main-status-txt">Sin comandera conectada</span></div>

        <label><span class="step">1</span>Tipo de conexion</label>
        <div class="cards" id="cmdr-cards">
          ${METHOD_CARDS.map(m => `
            <button type="button" class="card ${m.k === 'screen' ? 'wide ' : ''}${cfg.method === m.k ? 'on' : ''}" data-k="${m.k}">
              <span class="code">${m.code}</span>
              <span class="nm">${m.name}</span>
              <span class="ds">${m.desc}</span>
            </button>`).join('')}
        </div>

        <div class="panel hide" id="cmdr-connect-panel">
          <div class="status off" id="cmdr-status"><span class="dot"></span><span id="cmdr-status-txt">Sin conectar</span></div>
          <button type="button" class="btn-connect" id="cmdr-connect">Conectar impresora</button>
          <div class="hint" id="cmdr-connect-hint"></div>
        </div>

        <div class="panel hide" id="cmdr-usb">
          <div class="status off" id="cmdr-usb-status"><span class="dot"></span><span id="cmdr-usb-status-txt">Estacion USB sin vincular</span></div>
          <div class="hint" style="margin:0 0 10px;color:#475569;font-size:12.5px;">Usá esta opción cuando la comandera está conectada con cable USB a esta PC.</div>
          <a href="assets/comandera-bridge/instalar-gestiva-comandera.bat" download class="btn-test" style="display:block;text-align:center;text-decoration:none;margin:0 0 10px;">1. Instalar / actualizar estacion</a>
          <button type="button" class="btn-test" id="cmdr-usb-pair" style="margin:0 0 10px;">2. Detectar Epson USB y probar</button>
          <input type="hidden" id="cmdr-printer-name" value="${escapeHTML(cfg.printerName || '')}">
          <div id="cmdr-usb-results"></div>
          <div class="hint">Si la comandera esta enchufada por USB y prendida, al tocar el boton se instala y conecta sola. No hace falta instalar nada a mano en Windows.</div>
        </div>

        <div class="panel hide" id="cmdr-net">
          <div class="status off" id="cmdr-net-status"><span class="dot"></span><span id="cmdr-net-status-txt">Estacion de impresion sin vincular</span></div>
          <div class="hint" style="margin:0 0 10px;color:#475569;font-size:12.5px;">Usá esta opción cuando la comandera imprime por red, WiFi o Ethernet y tiene una IP propia.</div>
          <a href="assets/comandera-bridge/instalar-gestiva-comandera.bat" download class="btn-test" style="display:block;text-align:center;text-decoration:none;margin:0 0 10px;">1. Instalar / actualizar estacion</a>
          <button type="button" class="btn-test" id="cmdr-pair" style="margin:0 0 10px;">2. Conectar automaticamente</button>
          <div id="cmdr-scan-results"></div>
          <label style="margin-top:12px">Si no la encuentra, escribir IP del selftest</label>
          <div class="row">
            <input type="text" id="cmdr-ip" placeholder="Ej: 192.168.1.200" value="${escapeHTML(cfg.printerIp)}">
            <input type="number" id="cmdr-port" placeholder="9100" value="${cfg.printerPort || 9100}" style="max-width:90px;">
          </div>
          <button type="button" class="btn-test" id="cmdr-save-ip" style="margin:10px 0 0;background:#fff;color:#475569;border-color:#cbd5e1;">Guardar IP e imprimir prueba</button>
          <button type="button" class="btn-test" id="cmdr-download-pair" style="margin:10px 0 0;background:#fff;color:#64748b;border-color:#e2e8f0;">Modo soporte: descargar vinculacion</button>
          <div class="hint">Para ver la IP, muchas comanderas imprimen un selftest al prenderlas manteniendo apretado FEED. Puerto normal: 9100.</div>
        </div>

        <div class="panel hide" id="cmdr-browser-note">
          <div class="hint" style="margin:0;color:#475569;font-size:12.5px;">No hace falta conectar nada. Al imprimir se abre el dialogo del navegador y elegis la impresora instalada en esta computadora.</div>
        </div>

        <label><span class="step">2</span>Ajustes de impresion</label>
        <div class="row">
          <div style="flex:1"><div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;">Ancho de papel</div>
            <div class="seg" id="cmdr-paper">
              <button type="button" data-v="58" class="${cfg.paper === 58 ? 'on' : ''}">58 mm</button>
              <button type="button" data-v="80" class="${cfg.paper === 80 ? 'on' : ''}">80 mm</button>
            </div>
          </div>
          <div style="flex:1"><div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;">Copias</div>
            <div class="seg" id="cmdr-copies">
              ${[1, 2, 3].map(n => `<button type="button" data-v="${n}" class="${cfg.copies === n ? 'on' : ''}">${n}</button>`).join('')}
            </div>
          </div>
        </div>

        <label>Encabezado (opcional)</label>
        <input type="text" id="cmdr-header" placeholder="Nombre del restaurante" value="${escapeHTML(cfg.header)}">
        <label>Pie (opcional)</label>
        <input type="text" id="cmdr-footer" placeholder="Ej: Apurar mesa" value="${escapeHTML(cfg.footer)}">

        <div class="toggle">
          <span>Usar esta PC como estacion central</span>
          <div class="sw ${cfg.kitchenAuto ? 'on' : ''}" id="cmdr-kauto"></div>
        </div>
        <div class="hint">Activa la estacion central solo en la computadora del restaurante que queda abierta junto a la comandera. El celular del mozo no imprime: solo envia el pedido.</div>

        <button type="button" class="btn-test" id="cmdr-test">Imprimir prueba</button>
        <div class="msg" id="cmdr-msg"></div>

        <div class="btns">
          <button type="button" class="btn btn-ghost" id="cmdr-close">Cerrar</button>
          <button type="button" class="btn btn-primary" id="cmdr-save">Guardar</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const $ = (id) => wrap.querySelector(id);
    const msg = (txt, ok) => { const m = $('#cmdr-msg'); m.textContent = txt; m.className = 'msg ' + (ok ? 'ok' : 'err'); };
    const state = { method: cfg.method, paper: cfg.paper, copies: cfg.copies, autoprint: cfg.autoprint, kitchenAuto: cfg.kitchenAuto, printerName: cfg.printerName || '' };

    function setMainStatus(kind, text) {
      const box = $('#cmdr-main-status');
      const txt = $('#cmdr-main-status-txt');
      if (!box || !txt) return;
      box.className = 'status ' + (kind === 'ok' ? 'ok' : 'off');
      txt.textContent = text;
    }
    function connectedTextForCurrentMethod() {
      const ip = ($('#cmdr-ip') ? $('#cmdr-ip').value.trim() : cfg.printerIp) || '';
      const port = ($('#cmdr-port') ? (+$('#cmdr-port').value || 9100) : (cfg.printerPort || 9100));
      const printerName = ($('#cmdr-printer-name') ? $('#cmdr-printer-name').value.trim() : state.printerName) || '';
      if (state.method === 'usb' && printerName) return 'Conectado: USB - ' + printerName;
      if (state.method === 'network' && ip) return 'Conectado: Red/IP - ' + ip + ':' + port;
      if (state.method === 'bluetooth' && isConnected()) return 'Conectado: Bluetooth';
      if (state.method === 'browser') return 'Listo: imprime con el dialogo del sistema';
      if (state.method === 'screen') return 'Listo: pantalla de cocina';
      return '';
    }
    function syncMainStatus() {
      const text = connectedTextForCurrentMethod();
      if (text) setMainStatus('ok', text);
      else setMainStatus('off', 'Sin comandera conectada');
    }
    function setNetworkStatus(kind, text) {
      const box = $('#cmdr-net-status');
      const txt = $('#cmdr-net-status-txt');
      if (!box || !txt) return;
      box.className = 'status ' + (kind === 'ok' ? 'ok' : 'off');
      txt.textContent = text;
    }
    function setUsbStatus(kind, text) {
      const box = $('#cmdr-usb-status');
      const txt = $('#cmdr-usb-status-txt');
      if (!box || !txt) return;
      box.className = 'status ' + (kind === 'ok' ? 'ok' : 'off');
      txt.textContent = text;
    }
    function printerLabel(p) {
      const parts = [p.name];
      if (p.driver && p.driver !== p.name) parts.push(p.driver);
      if (p.port) parts.push('Puerto ' + p.port);
      return parts.filter(Boolean).join(' - ');
    }
    function renderPrinterChoices(printers, onPick) {
      const visible = printers
        .map(p => `<button type="button" class="cmdr-usb-pick" data-name="${escapeHTML(p.name)}" style="display:block;width:100%;text-align:left;margin:0 0 6px;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;font-weight:700;cursor:pointer;font-family:inherit;">${escapeHTML(printerLabel(p))}${p.likelyComandera ? '<br><span style="font-size:11px;color:#10b981;">Recomendada para comandera</span>' : ''}</button>`)
        .join('');
      const box = $('#cmdr-usb-results');
      if (!box) return;
      box.innerHTML = '<div class="hint" style="margin:6px 0 8px;">Toca la Epson USB que queres usar:</div>' + visible;
      box.querySelectorAll('.cmdr-usb-pick').forEach(b => b.onclick = () => onPick(b.dataset.name));
    }
    async function configureUsbPrinter(printerName) {
      await savePrintStationWindowsPrinter(printerName);
      await testPrintStation();
      state.method = 'usb';
      state.kitchenAuto = true;
      state.printerName = printerName;
      const hidden = $('#cmdr-printer-name');
      if (hidden) hidden.value = printerName;
      setCfg(Object.assign(collect(), {
        method: 'usb',
        kitchenAuto: true,
        printerMode: 'windows',
        printerName,
        printerIp: '',
        lastUsbOkAt: new Date().toISOString()
      }));
      setUsbStatus('ok', 'Conectado: USB - ' + printerName);
      setMainStatus('ok', 'Conectado: USB - ' + printerName);
    }
    function showBridgeInstaller(show) {
      const box = $('#cmdr-install-box');
      if (box) box.style.display = show ? 'block' : 'none';
    }
    async function detectNetworkConnection(silent) {
      const next = collect();
      setNetworkStatus('off', 'Verificando puente...');
      try {
        await checkBridge(next);
        setNetworkStatus('off', 'Puente activo. Verificando comandera...');
        await probeNetworkPrinter(next);
        setCfg(Object.assign(next, { lastNetworkOkAt: new Date().toISOString() }));
        setNetworkStatus('ok', 'Conectado: Red/IP - ' + next.printerIp + ':' + (next.printerPort || 9100));
        setMainStatus('ok', 'Conectado: Red/IP - ' + next.printerIp + ':' + (next.printerPort || 9100));
        if (!silent) msg('Comandera conectada. Ya podes imprimir una prueba.', true);
        return true;
      } catch (e) {
        showBridgeInstaller(true);
        setNetworkStatus('off', 'Sin conexion confirmada');
        if (!silent) msg(e.message || 'No se pudo detectar la comandera.', false);
        return false;
      }
    }

    function isConnected() {
      if (state.method === 'bluetooth') return !!(_btChar && _btChar.service.device.gatt.connected);
      if (state.method === 'usb') return !!(_usbDev && _usbDev.opened);
      return false;
    }
    function refreshStatus() {
      const s = $('#cmdr-status'); if (!s) return;
      const ok = isConnected();
      s.className = 'status ' + (ok ? 'ok' : 'off');
      $('#cmdr-status-txt').textContent = ok ? 'Conectado: Bluetooth' : 'Sin conectar';
      $('#cmdr-connect').textContent = ok ? 'Volver a conectar' : 'Conectar impresora';
      syncMainStatus();
    }
    function refreshMethodUI() {
      $('#cmdr-usb').classList.toggle('hide', state.method !== 'usb');
      $('#cmdr-net').classList.toggle('hide', state.method !== 'network');
      const needsConnect = (state.method === 'bluetooth');
      $('#cmdr-connect-panel').classList.toggle('hide', !needsConnect);
      $('#cmdr-browser-note').classList.toggle('hide', state.method !== 'browser');
      if (state.method === 'network') {
        const ip = ($('#cmdr-ip') ? $('#cmdr-ip').value.trim() : cfg.printerIp) || '';
        const port = ($('#cmdr-port') ? (+$('#cmdr-port').value || 9100) : (cfg.printerPort || 9100));
        if (ip) setNetworkStatus('ok', 'Conectado: Red/IP - ' + ip + ':' + port);
        else setNetworkStatus('off', 'Instala la estacion y toca Conectar automaticamente');
      }
      else if (state.method === 'usb') {
        if (state.printerName) setUsbStatus('ok', 'Conectado: USB - ' + state.printerName);
        else setUsbStatus('off', 'Instala la estacion y detecta la Epson USB');
      }
      else showBridgeInstaller(false);
      if (needsConnect) {
        $('#cmdr-connect-hint').textContent = 'Encende la impresora y toca Conectar para emparejarla. Funciona con Chrome en Android.';
        refreshStatus();
      }
      syncMainStatus();
    }
    function selectMethod(k) {
      state.method = k;
      if (k === 'usb' || k === 'network') state.kitchenAuto = true;
      wrap.querySelectorAll('#cmdr-cards .card').forEach(c => c.classList.toggle('on', c.dataset.k === k));
      const kauto = $('#cmdr-kauto');
      if (kauto) kauto.classList.toggle('on', state.kitchenAuto);
      refreshMethodUI();
    }
    refreshMethodUI();

    wrap.querySelectorAll('#cmdr-cards .card').forEach(c => c.onclick = () => selectMethod(c.dataset.k));
    wrap.querySelectorAll('#cmdr-paper button').forEach(b => b.onclick = () => {
      state.paper = +b.dataset.v; wrap.querySelectorAll('#cmdr-paper button').forEach(x => x.classList.toggle('on', x === b));
    });
    wrap.querySelectorAll('#cmdr-copies button').forEach(b => b.onclick = () => {
      state.copies = +b.dataset.v; wrap.querySelectorAll('#cmdr-copies button').forEach(x => x.classList.toggle('on', x === b));
    });
    const autoSwitch = $('#cmdr-auto');
    if (autoSwitch) autoSwitch.onclick = () => { state.autoprint = !state.autoprint; autoSwitch.classList.toggle('on', state.autoprint); };
    $('#cmdr-kauto').onclick = () => { state.kitchenAuto = !state.kitchenAuto; $('#cmdr-kauto').classList.toggle('on', state.kitchenAuto); };
    const pairBtn = $('#cmdr-pair');
    if (pairBtn) pairBtn.onclick = async () => {
      const orig = pairBtn.textContent;
      const box = $('#cmdr-scan-results');
      const port = +($('#cmdr-port')?.value || 9100) || 9100;
      pairBtn.disabled = true; pairBtn.textContent = 'Conectando...';
      if (box) box.innerHTML = '<div class="hint">Revisando estacion de impresion...</div>';
      try {
        state.method = 'network';
        state.kitchenAuto = true;
        setCfg(Object.assign(collect(), { method: 'network', kitchenAuto: true }));
        await ensurePrintStation();
        setNetworkStatus('off', 'Estacion detectada. Vinculando...');
        await pairPrintStation();
        setNetworkStatus('off', 'Vinculada. Buscando comandera...');
        if (box) box.innerHTML = '<div class="hint">Buscando comanderas en la red. Puede tardar unos segundos...</div>';
        const data = await scanPrintStation(port);
        const printers = (data && data.printers) || [];
        const candidates = (data && data.candidates) || [];
        if (printers.length === 1) {
          $('#cmdr-ip').value = printers[0];
          await savePrintStationPrinter(printers[0], port);
          await testPrintStation();
          setNetworkStatus('ok', 'Conectado: Red/IP - ' + printers[0] + ':' + port);
          setMainStatus('ok', 'Conectado: Red/IP - ' + printers[0] + ':' + port);
          if (box) box.innerHTML = '<div class="hint">Comandera encontrada y guardada: ' + escapeHTML(printers[0]) + '</div>';
          msg('Comandera conectada. Se envio una prueba de impresion.', true);
        } else if (printers.length > 1) {
          setNetworkStatus('off', 'Elegir comandera encontrada');
          if (box) {
            box.innerHTML = '<div class="hint" style="margin:6px 0 8px;">Toca la comandera a usar:</div>' +
              printers.map(ip => `<button type="button" class="cmdr-pick" data-ip="${escapeHTML(ip)}" style="display:block;width:100%;text-align:left;margin:0 0 6px;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;font-weight:700;cursor:pointer;font-family:inherit;">${escapeHTML(ip)}</button>`).join('');
            box.querySelectorAll('.cmdr-pick').forEach(b => b.onclick = async () => {
              try {
                $('#cmdr-ip').value = b.dataset.ip;
                await savePrintStationPrinter(b.dataset.ip, port);
                await testPrintStation();
                setNetworkStatus('ok', 'Conectado: Red/IP - ' + b.dataset.ip + ':' + port);
                setMainStatus('ok', 'Conectado: Red/IP - ' + b.dataset.ip + ':' + port);
                msg('Comandera conectada. Se envio una prueba de impresion.', true);
              } catch (e) {
                msg(e.message || 'No se pudo imprimir la prueba.', false);
              }
            });
          }
          msg('Encontre varias comanderas. Elegi una para guardar e imprimir prueba.', true);
        } else {
          setNetworkStatus('off', 'No se encontro automaticamente');
          setMainStatus('off', 'Sin comandera conectada');
          if (box) {
            const visible = candidates
              .slice(0, 8)
              .map(c => '<div class="hint" style="margin:6px 0;padding:8px 10px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;">Equipo visible: <strong>' + escapeHTML(c.ip) + '</strong> - puertos ' + escapeHTML((c.ports || []).join(', ')) + (c.likelyPrinter ? ' - posible impresora' : '') + '</div>')
              .join('');
            box.innerHTML = '<div class="hint">No encontre una comandera con puerto ESC/POS 9100 abierto. Si la Epson esta prendida, probablemente esta en otra red/WiFi o no tiene Ethernet configurado.</div>' +
              (visible ? '<div class="hint" style="margin-top:8px;">Diagnostico de red:</div>' + visible : '') +
              '<div class="hint">Escribi la IP del selftest abajo y toca "Guardar IP e imprimir prueba".</div>';
          }
          msg('No la encontre automaticamente. Carga la IP que imprime el selftest de la comandera.', false);
        }
      } catch (e) {
        setNetworkStatus('off', 'Falta instalar o actualizar estacion');
        setMainStatus('off', 'Sin comandera conectada');
        if (box) box.innerHTML = '<div class="hint">Primero toca "Instalar / actualizar estacion", ejecuta el archivo descargado y despues volve a conectar.</div>';
        msg(e.message || 'No se pudo conectar la estacion.', false);
      } finally {
        pairBtn.disabled = false; pairBtn.textContent = orig;
      }
    };
    const usbPairBtn = $('#cmdr-usb-pair');
    if (usbPairBtn) usbPairBtn.onclick = async () => {
      const orig = usbPairBtn.textContent;
      const box = $('#cmdr-usb-results');
      usbPairBtn.disabled = true; usbPairBtn.textContent = 'Detectando...';
      if (box) box.innerHTML = '<div class="hint">Revisando estacion e impresoras instaladas en Windows...</div>';
      try {
        state.method = 'usb';
        state.kitchenAuto = true;
        setCfg(Object.assign(collect(), { method: 'usb', kitchenAuto: true, printerMode: 'windows' }));
        await ensurePrintStation();
        setUsbStatus('off', 'Estacion detectada. Vinculando...');
        await pairPrintStation();
        const data = await listPrintStationPrinters();
        const printers = (data && data.printers) || [];
        const suggested = data && data.suggested;
        const likely = printers.filter(p => p.likelyComandera && !p.isVirtual);
        const usable = likely.length ? likely : printers.filter(p => !p.isVirtual);
        const autoPick = suggested && suggested.name ? suggested.name : (usable.length === 1 ? usable[0].name : '');
        if (autoPick) {
          await configureUsbPrinter(autoPick);
          if (box) box.innerHTML = '<div class="hint">Impresora USB guardada: <strong>' + escapeHTML(autoPick) + '</strong>. Se envio una prueba.</div>';
          msg('Comandera USB conectada. Se envio una prueba de impresion.', true);
        } else if (usable.length > 1) {
          setUsbStatus('off', 'Elegir impresora USB');
          renderPrinterChoices(usable, async (name) => {
            try {
              await configureUsbPrinter(name);
              if (box) box.innerHTML = '<div class="hint">Impresora USB guardada: <strong>' + escapeHTML(name) + '</strong>. Se envio una prueba.</div>';
              msg('Comandera USB conectada. Se envio una prueba de impresion.', true);
            } catch (e) {
              msg(e.message || 'No pude imprimir la prueba USB.', false);
            }
          });
          msg('Encontre varias impresoras. Elegi la Epson USB para guardar.', true);
        } else {
          // No hay impresora instalada: buscamos una USB conectada-sin-instalar y la instalamos nosotros.
          setUsbStatus('off', 'Buscando comandera USB conectada...');
          if (box) box.innerHTML = '<div class="hint">No hay impresoras instaladas. Reviso si hay una comandera USB conectada para instalarla sola...</div>';
          let pending = [];
          try { const d = await usbDetect(); pending = (d && d.pending) || []; } catch (e) {}
          if (pending.length) {
            try {
              if (box) box.innerHTML = '<div class="hint">Detecte una comandera USB conectada (<strong>' + escapeHTML(pending[0].device) + '</strong>) sin instalar. Instalandola sola...</div>';
              const inst = await usbInstall(pending[0].port);
              const name = inst && inst.printerName;
              if (!name) throw new Error('No se pudo instalar la impresora USB.');
              await configureUsbPrinter(name);
              if (box) box.innerHTML = '<div class="hint">Comandera USB instalada y conectada: <strong>' + escapeHTML(name) + '</strong>. Se envio una prueba.</div>';
              msg('Instale y conecte la comandera USB automaticamente. Se envio una prueba de impresion.', true);
            } catch (e) {
              setUsbStatus('off', 'No pude instalar la comandera USB');
              setMainStatus('off', 'Sin comandera conectada');
              if (box) box.innerHTML = '<div class="hint">Encontre una comandera USB conectada pero no la pude instalar sola: ' + escapeHTML(e.message || '') + '</div>';
              msg(e.message || 'No pude instalar la comandera USB automaticamente.', false);
            }
          } else {
            setUsbStatus('off', 'No hay comandera USB conectada');
            setMainStatus('off', 'Sin comandera conectada');
            if (box) box.innerHTML = '<div class="hint">No detecte ninguna comandera USB conectada a esta PC. Revisa que el cable USB este bien enchufado y la impresora prendida, y volve a tocar detectar.</div>';
            msg('No detecte ninguna comandera USB conectada. Revisa el cable USB y que este prendida.', false);
          }
        }
      } catch (e) {
        setUsbStatus('off', 'Falta instalar o actualizar estacion');
        setMainStatus('off', 'Sin comandera conectada');
        if (box) box.innerHTML = '<div class="hint">Primero toca "Instalar / actualizar estacion", ejecuta el archivo descargado y despues volve a detectar la Epson USB.</div>';
        msg(e.message || 'No se pudo conectar la estacion USB.', false);
      } finally {
        usbPairBtn.disabled = false; usbPairBtn.textContent = orig;
      }
    };
    const saveIpBtn = $('#cmdr-save-ip');
    if (saveIpBtn) saveIpBtn.onclick = async () => {
      const orig = saveIpBtn.textContent;
      const ip = ($('#cmdr-ip')?.value || '').trim();
      const port = +($('#cmdr-port')?.value || 9100) || 9100;
      saveIpBtn.disabled = true; saveIpBtn.textContent = 'Probando...';
      try {
        await ensurePrintStation();
        await pairPrintStation();
        await savePrintStationPrinter(ip, port);
        await testPrintStation();
        state.method = 'network';
        state.kitchenAuto = true;
        setCfg(Object.assign(collect(), { method: 'network', kitchenAuto: true, printerIp: ip, printerPort: port, lastNetworkOkAt: new Date().toISOString() }));
        setNetworkStatus('ok', 'Conectado: Red/IP - ' + ip + ':' + port);
        setMainStatus('ok', 'Conectado: Red/IP - ' + ip + ':' + port);
        msg('Comandera guardada. Se envio una prueba de impresion.', true);
      } catch (e) {
        setNetworkStatus('off', 'No se pudo imprimir prueba');
        setMainStatus('off', 'Sin comandera conectada');
        msg(e.message || 'No se pudo guardar o imprimir la prueba.', false);
      } finally {
        saveIpBtn.disabled = false; saveIpBtn.textContent = orig;
      }
    };
    const downloadPairBtn = $('#cmdr-download-pair');
    if (downloadPairBtn) downloadPairBtn.onclick = async () => {
      const orig = downloadPairBtn.textContent;
      downloadPairBtn.disabled = true; downloadPairBtn.textContent = 'Preparando...';
      try {
        const data = await createPrintStationToken();
        const payload = {
          type: 'gestiva-print-station-pairing',
          token: data.token,
          apiUrl: ((window.API_URL || data.apiUrl || DEFAULT_API_URL)).replace(/\/$/, ''),
          restaurant: data.restaurant || '',
          createdAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        const name = (payload.restaurant || 'gestiva').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'gestiva';
        a.href = URL.createObjectURL(blob);
        a.download = 'gestiva-print-station-' + name + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        msg('Archivo de vinculacion descargado. Usalo solo para soporte tecnico de esta PC.', true);
      } catch (e) {
        msg(e.message || 'No pude preparar la vinculacion.', false);
      } finally {
        downloadPairBtn.disabled = false; downloadPairBtn.textContent = orig;
      }
    };
    function collect() {
      return {
        method: state.method, paper: state.paper, copies: state.copies, autoprint: state.autoprint, kitchenAuto: state.kitchenAuto,
        header: $('#cmdr-header').value.trim(), footer: $('#cmdr-footer').value.trim(),
        printerMode: state.method === 'usb' ? 'windows' : (state.method === 'network' ? 'network' : (cfg.printerMode || '')),
        printerName: ($('#cmdr-printer-name') ? $('#cmdr-printer-name').value.trim() : (state.printerName || cfg.printerName || '')),
        printerIp: ($('#cmdr-ip') ? $('#cmdr-ip').value.trim() : cfg.printerIp),
        printerPort: ($('#cmdr-port') ? (+$('#cmdr-port').value || 9100) : cfg.printerPort),
        bridgeUrl: ($('#cmdr-bridge') ? $('#cmdr-bridge').value.trim() : cfg.bridgeUrl)
      };
    }

    $('#cmdr-connect').onclick = async () => {
      const btn = $('#cmdr-connect'); btn.disabled = true;
      try {
        msg('Buscando impresora...', true);
        if (state.method === 'bluetooth') await getBluetoothChar();
        else await getUsbDevice();
        msg('Impresora conectada. Proba imprimir abajo.', true);
      } catch (e) { msg(e.message || 'No se pudo conectar.', false); }
      btn.disabled = false; refreshStatus();
    };
    $('#cmdr-test').onclick = async () => {
      setCfg(collect());
      if (state.method === 'network') {
        try {
          const ip = ($('#cmdr-ip')?.value || '').trim();
          const port = +($('#cmdr-port')?.value || 9100) || 9100;
          await ensurePrintStation();
          await pairPrintStation();
          await savePrintStationPrinter(ip, port);
          await testPrintStation();
          setNetworkStatus('ok', 'Conectado: Red/IP - ' + ip + ':' + port);
          setMainStatus('ok', 'Conectado: Red/IP - ' + ip + ':' + port);
          msg('Prueba enviada. Si salio el ticket, la comandera ya queda conectada.', true);
        } catch (e) {
          setMainStatus('off', 'Sin comandera conectada');
          msg(e.message || 'No pude imprimir la prueba.', false);
        }
        return;
      }
      if (state.method === 'usb') {
        try {
          const printerName = ($('#cmdr-printer-name')?.value || state.printerName || '').trim();
          await ensurePrintStation();
          await pairPrintStation();
          await savePrintStationWindowsPrinter(printerName);
          await testPrintStation();
          state.printerName = printerName;
          setCfg(Object.assign(collect(), { method: 'usb', kitchenAuto: true, printerMode: 'windows', printerName, printerIp: '', lastUsbOkAt: new Date().toISOString() }));
          setUsbStatus('ok', 'Conectado: USB - ' + printerName);
          setMainStatus('ok', 'Conectado: USB - ' + printerName);
          msg('Prueba enviada. Si salio el ticket, la comandera USB ya queda conectada.', true);
        } catch (e) {
          setMainStatus('off', 'Sin comandera conectada');
          msg(e.message || 'No pude imprimir la prueba USB.', false);
        }
        return;
      }
      try { msg('Enviando prueba...', true); await testPrint(); msg('Prueba enviada ✓ Revisá la impresora.', true); refreshStatus(); }
      catch (e) { msg(e.message || 'No se pudo imprimir.', false); }
    };
    $('#cmdr-save').onclick = () => { setCfg(collect()); wrap.remove(); if (typeof window.onComanderaSaved === 'function') window.onComanderaSaved(getCfg()); };
    $('#cmdr-close').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    if (state.method === 'network' && cfg.printerIp) setNetworkStatus('ok', 'Conectado: Red/IP - ' + cfg.printerIp + ':' + (cfg.printerPort || 9100));
    if (state.method === 'usb' && cfg.printerName) setUsbStatus('ok', 'Conectado: USB - ' + cfg.printerName);
    syncMainStatus();
  }

  // ============================================================
  //  COMPROBANTE DE VENTA (remito para el cliente, al cobrar)
  // ============================================================
  const PAY_LABELS = {
    efectivo: 'Efectivo',
    debito: 'Tarjeta de débito',
    credito: 'Tarjeta de crédito',
    tarjeta: 'Tarjeta',
    transferencia: 'Transferencia',
    mercadopago: 'MercadoPago',
    cuenta_corriente: 'Cuenta corriente'
  };
  const payLabel = (m) => PAY_LABELS[m] || (m ? String(m) : 'Efectivo');
  const money = (n) => '$' + Math.round(parseFloat(n) || 0).toLocaleString('es-AR');

  // sale = { restaurant, table, waiter, datetime, ref, items:[{name,qty,price}],
  //          subtotal, discount, total, payments:[{method,amount}] }
  function normalizePayments(sale) {
    if (Array.isArray(sale.payments) && sale.payments.length) return sale.payments;
    return [{ method: sale.paymentMethod || 'efectivo', amount: sale.total }];
  }

  // ---- HTML (navegador / preview) ----
  function receiptHTML(sale, cfg) {
    cfg = cfg || getCfg();
    const w = cfg.paper === 80 ? '76mm' : '54mm';
    const head = (cfg.header || sale.restaurant || 'Gestiva');
    const pays = normalizePayments(sale);
    const fs = cfg.paper === 80 ? 14 : 12;
    const rows = (sale.items || []).map(it => {
      const line = (it.price != null) ? money(it.price * it.qty) : '';
      return `<div class="ln"><span class="l">${escapeHTML(it.qty + 'x ' + it.name)}</span><span class="r">${line}</span></div>`;
    }).join('');
    const payRows = pays.map(p => `<div class="ln"><span class="l">${escapeHTML(payLabel(p.method))}</span><span class="r">${money(p.amount)}</span></div>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: ${cfg.paper}mm auto; margin: 0; }
      *{box-sizing:border-box;} html,body{margin:0;padding:0;}
      .tk{width:${w};padding:4mm 2mm;font-family:'Courier New',monospace;color:#000;font-size:${fs}px;}
      .ctr{text-align:center;} .rest{font-size:${cfg.paper === 80 ? 19 : 16}px;font-weight:800;text-transform:uppercase;}
      .doc{font-size:${fs}px;font-weight:700;letter-spacing:1px;} .tiny{font-size:10px;}
      .hr{border-top:1px dashed #000;margin:5px 0;}
      .ln{display:flex;justify-content:space-between;gap:8px;margin:2px 0;}
      .ln .l{flex:1;} .ln .r{white-space:nowrap;font-variant-numeric:tabular-nums;}
      .tot{display:flex;justify-content:space-between;font-size:${cfg.paper === 80 ? 22 : 18}px;font-weight:800;margin:4px 0;}
      .pay-h{font-weight:700;margin-top:4px;} .foot{text-align:center;margin-top:8px;font-size:11px;}
    </style></head><body><div class="tk">
      <div class="ctr rest">${escapeHTML(head)}</div>
      <div class="ctr doc">COMPROBANTE DE VENTA</div>
      <div class="ctr tiny">No válido como factura</div>
      <div class="hr"></div>
      <div class="tiny">${fmtDateTime(sale.datetime)}${sale.ref ? ' · #' + shortRef(sale) : ''}</div>
      <div class="tiny">${sale.table ? 'Mesa ' + escapeHTML(sale.table) : 'Mostrador'}${sale.waiter ? ' · ' + escapeHTML(sale.waiter) : ''}</div>
      <div class="hr"></div>
      ${rows || '<div class="ln"><span class="l">(sin items)</span></div>'}
      <div class="hr"></div>
      ${(sale.discount && sale.discount > 0) ? `<div class="ln"><span class="l">Subtotal</span><span class="r">${money(sale.subtotal)}</span></div><div class="ln"><span class="l">Descuento</span><span class="r">-${money(sale.discount)}</span></div>` : ''}
      <div class="tot"><span>TOTAL</span><span>${money(sale.total)}</span></div>
      <div class="hr"></div>
      <div class="pay-h">FORMA DE PAGO</div>
      ${payRows}
      <div class="hr"></div>
      <div class="foot">¡Gracias por su compra!<br>${escapeHTML(head)}<br><span class="tiny">Comprobante no fiscal</span></div>
    </div></body></html>`;
  }

  // ---- ESC/POS (térmica) ----
  function escposReceipt(sale, cfg) {
    cfg = cfg || getCfg();
    const W = charsPerLine(cfg.paper);
    const enc = new TextEncoder();
    const bytes = [];
    const push = (arr) => { for (const b of arr) bytes.push(b & 0xFF); };
    const text = (s) => push(Array.from(enc.encode(ascii(s))));
    const line = (s) => { text(s); push([0x0A]); };
    const center = (on) => push([0x1B, 0x61, on ? 1 : 0]);
    const bold = (on) => push([0x1B, 0x45, on ? 1 : 0]);
    const big = (on) => push([0x1D, 0x21, on ? 0x11 : 0x00]);
    const sep = () => line('-'.repeat(W));
    // Fila a 2 columnas: izquierda + derecha alineada
    const row = (l, r) => {
      l = ascii(l); r = ascii(r);
      const space = Math.max(1, W - l.length - r.length);
      if (l.length + r.length + 1 > W) { line(l); line(' '.repeat(Math.max(0, W - r.length)) + r); }
      else line(l + ' '.repeat(space) + r);
    };
    const pays = normalizePayments(sale);
    const head = cfg.header || sale.restaurant || 'Gestiva';

    push([0x1B, 0x40]);
    center(true); bold(true); big(true); line(head); big(false);
    line('COMPROBANTE DE VENTA'); bold(false);
    line('No valido como factura'); center(false);
    sep();
    line(fmtDateTime(sale.datetime) + (sale.ref ? '  #' + shortRef(sale) : ''));
    line((sale.table ? 'Mesa ' + sale.table : 'Mostrador') + (sale.waiter ? '  ' + sale.waiter : ''));
    sep();
    for (const it of (sale.items || [])) {
      row(it.qty + 'x ' + it.name, it.price != null ? money(it.price * it.qty) : '');
    }
    sep();
    if (sale.discount && sale.discount > 0) {
      row('Subtotal', money(sale.subtotal));
      row('Descuento', '-' + money(sale.discount));
    }
    bold(true); big(true); row('TOTAL', money(sale.total)); big(false); bold(false);
    sep();
    bold(true); line('FORMA DE PAGO'); bold(false);
    for (const p of pays) row(payLabel(p.method), money(p.amount));
    sep();
    center(true); line('Gracias por su compra!'); line(head);
    line('Comprobante no fiscal'); center(false);
    push([0x0A, 0x0A, 0x0A]);
    push([0x1D, 0x56, 0x42, 0x00]);
    return new Uint8Array(bytes);
  }

  async function printReceipt(sale, opts) {
    const cfg = Object.assign(getCfg(), opts || {});
    const copies = Math.max(1, Math.min(3, cfg.copies || 1));
    if (cfg.method === 'screen' || cfg.method === 'browser') {
      // El comprobante siempre se puede imprimir por navegador aunque la comandera
      // esté en "solo pantalla" (al cliente hay que darle algo).
      const html = receiptHTML(sale, cfg);
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      document.body.appendChild(ifr);
      await new Promise((resolve) => {
        ifr.onload = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {} setTimeout(() => { ifr.remove(); resolve(); }, 1500); };
        const d = ifr.contentWindow.document; d.open(); d.write(html); d.close();
      });
      return { ok: true, method: 'browser' };
    }
    let bytes = escposReceipt(sale, cfg);
    if (copies > 1) bytes = concatCopies(bytes, copies);
    if (cfg.method === 'bluetooth') await printBluetooth(bytes);
    else if (cfg.method === 'usb') {
      if (cfg.printerName || cfg.printerMode === 'windows') await printWindowsPrinter(bytes, cfg);
      else await printUSB(bytes);
    }
    else if (cfg.method === 'network') await printNetwork(bytes, cfg);
    return { ok: true, method: cfg.method };
  }

  window.Comandera = {
    getCfg, setCfg, print, testPrint, ticketHTML, escpos, openConfig,
    checkBridge, probeNetworkPrinter,
    receiptHTML, escposReceipt, printReceipt, payLabel,
    METHOD_LABELS, PAY_LABELS,
    _methods: ['screen', 'browser', 'bluetooth', 'usb', 'network']
  };
})();

