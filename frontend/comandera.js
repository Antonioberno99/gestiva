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
    printerPort: 9100,     // puerto ESC/POS estandar
    routingMode: 'single', // 'single' | 'split'
    barCategories: 'Bebidas,Tragos',
    barPrinterMode: 'network',
    barPrinterName: '',
    barPrinterIp: '',
    barPrinterPort: 9100
  };
  const DEFAULT_API_URL = 'https://gestiva-backend.onrender.com';

  function getCfg() {
    let cfg;
    try { cfg = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch { cfg = Object.assign({}, DEFAULTS); }
    // Migración: config vieja de una sola comandera (+bar) → lista de comanderas con nombre
    if (!Array.isArray(cfg.stations)) cfg.stations = legacyToStations(cfg);
    return cfg;
  }
  function setCfg(c) { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign(getCfg(), c))); }

  // ---------- Comanderas con nombre (lista) ----------
  const newId = () => 'st_' + Math.random().toString(36).slice(2, 9);
  // Construye la lista a partir de la config vieja (método único + bar opcional)
  function legacyToStations(cfg) {
    const out = [];
    if (cfg.method && cfg.method !== 'screen') {
      out.push({
        id: newId(), name: 'Cocina', method: cfg.method,
        printerName: cfg.printerName || '', printerIp: cfg.printerIp || '', printerPort: cfg.printerPort || 9100,
        paper: cfg.paper || 58, copies: cfg.copies || 1,
        route: cfg.routingMode === 'split' ? 'resto' : 'todo',
        categories: cfg.routingMode === 'split' ? (cfg.barCategories || 'Bebidas,Tragos') : '',
        receipts: true
      });
      if (cfg.routingMode === 'split' && (cfg.barPrinterIp || cfg.barPrinterName)) {
        out.push({
          id: newId(), name: 'Bar', method: cfg.barPrinterMode === 'windows' ? 'usb' : 'network',
          printerName: cfg.barPrinterName || '', printerIp: cfg.barPrinterIp || '', printerPort: cfg.barPrinterPort || 9100,
          paper: cfg.paper || 58, copies: 1,
          route: 'solo', categories: cfg.barCategories || 'Bebidas,Tragos',
          receipts: false
        });
      }
    }
    return out;
  }
  // Deriva los campos viejos desde la lista (compatibilidad: app/mozo y agente main+bar)
  function deriveLegacy(stations) {
    const agentCapable = (s) => s.method === 'network' || s.method === 'usb';
    const main = stations.find(s => s.route !== 'solo' && agentCapable(s)) || stations.find(s => s.route !== 'solo') || stations[0] || null;
    const bar = stations.find(s => s !== main && s.route === 'solo' && agentCapable(s)) || null;
    const legacy = {
      method: main ? main.method : 'screen',
      printerMode: main ? (main.method === 'usb' ? 'windows' : (main.method === 'network' ? 'network' : '')) : '',
      printerName: (main && main.method === 'usb' && main.printerName) || '',
      printerIp: (main && main.method === 'network' && main.printerIp) || '',
      printerPort: (main && main.printerPort) || 9100,
      paper: (main && main.paper) || 58,
      copies: (main && main.copies) || 1,
      routingMode: bar ? 'split' : 'single',
      barCategories: bar ? (bar.categories || 'Bebidas,Tragos') : 'Bebidas,Tragos',
      barPrinterMode: bar ? (bar.method === 'usb' ? 'windows' : 'network') : 'network',
      barPrinterName: (bar && bar.printerName) || '',
      barPrinterIp: (bar && bar.printerIp) || '',
      barPrinterPort: (bar && bar.printerPort) || 9100
    };
    return legacy;
  }
  function saveStations(stations, extra) {
    setCfg(Object.assign({ stations }, deriveLegacy(stations), extra || {}));
  }
  const getStations = () => getCfg().stations || [];
  // Categorías: "Bebidas,Tragos" → ['bebidas','tragos']
  function parseCats(s) { return String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean); }
  function itemInCats(it, cats) {
    const cat = String((it && (it.cat || it.category || it.type)) || '').trim().toLowerCase();
    const seg = String((it && it.segment) || '').trim().toLowerCase();
    return !!(cat && cats.includes(cat)) || !!(seg && cats.includes(seg));
  }
  // Qué items del pedido imprime esta comandera según su regla
  function stationItems(st, items) {
    items = Array.isArray(items) ? items : [];
    const cats = parseCats(st.categories);
    if (st.route === 'solo') return items.filter(it => itemInCats(it, cats));
    if (st.route === 'resto') return items.filter(it => !itemInCats(it, cats));
    return items;
  }

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

  async function savePrintStationFullConfig(cfg) {
    if (!cfg || (cfg.method !== 'network' && cfg.method !== 'usb')) return null;
    await ensurePrintStation();
    await pairPrintStation();
    const body = {
      printerMode: cfg.method === 'usb' ? 'windows' : 'network',
      printerName: cfg.method === 'usb' ? (cfg.printerName || '') : '',
      printerIp: cfg.method === 'network' ? (cfg.printerIp || '') : '',
      printerPort: cfg.printerPort || 9100,
      routingMode: cfg.routingMode || 'single',
      barCategories: cfg.barCategories || 'Bebidas,Tragos',
      barPrinterMode: cfg.barPrinterMode || 'network',
      barPrinterName: cfg.barPrinterName || '',
      barPrinterIp: cfg.barPrinterIp || '',
      barPrinterPort: cfg.barPrinterPort || 9100
    };
    return await fetchJson(_stationBase + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 6000);
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
  async function printSingle(ticket, cfg) {
    if (cfg.method === 'screen') return { ok: true, method: 'screen' };
    const copies = Math.max(1, Math.min(3, cfg.copies || 1));
    if (cfg.method === 'browser') {
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
    else throw new Error('Metodo de comandera desconocido: ' + cfg.method);
    return { ok: true, method: cfg.method };
  }
  // Config efectiva para imprimir en UNA comandera de la lista
  function stationCfg(st, globalCfg, multi) {
    const base = globalCfg || getCfg();
    return Object.assign({}, base, {
      method: st.method,
      paper: st.paper || base.paper || 58,
      copies: st.copies || 1,
      printerMode: st.method === 'usb' ? 'windows' : (st.method === 'network' ? 'network' : ''),
      printerName: st.printerName || '',
      printerIp: st.printerIp || '',
      printerPort: st.printerPort || 9100,
      // Con varias comanderas, cada ticket dice en cuál salió (BAR, CAJA...)
      header: (base.header || '') ,
      _nameSuffix: multi ? String(st.name || '').toUpperCase() : ''
    });
  }
  async function printStation(st, ticket, globalCfg, multi) {
    const items = stationItems(st, ticket.items);
    if (!items.length) return { ok: true, skipped: true };
    const scfg = stationCfg(st, globalCfg, multi);
    const head = (scfg.header || ticket.restaurant || 'Gestiva') + (scfg._nameSuffix ? ' - ' + scfg._nameSuffix : '');
    return printSingle(Object.assign({}, ticket, { items }), Object.assign({}, scfg, { header: head }));
  }
  // Imprime el pedido en TODAS las comanderas configuradas (cada una con su regla).
  async function print(ticket, opts) {
    const cfg = Object.assign(getCfg(), opts || {});
    const stations = cfg.stations || [];
    if (!stations.length) return { ok: true, method: 'screen' };
    const multi = stations.length > 1;
    const errors = []; const printed = [];
    for (const st of stations) {
      try {
        const r = await printStation(st, ticket, cfg, multi);
        if (!r.skipped) printed.push(st.name);
      } catch (e) {
        errors.push((st.name || 'Comandera') + ': ' + (e.message || e));
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { ok: true, method: cfg.method, printed };
  }
  function concatCopies(bytes, n) {
    const out = new Uint8Array(bytes.length * n);
    for (let i = 0; i < n; i++) out.set(bytes, i * bytes.length);
    return out;
  }

  const TEST_TICKET = () => ({
    restaurant: getCfg().header || 'GESTIVA',
    table: '5',
    waiter: 'Prueba',
    datetime: new Date(),
    ref: 'TEST',
    items: [
      { name: 'Milanesa napolitana', cat: 'Comida', qty: 2, modifiers: ['sin papas'], notes: 'bien cocida' },
      { name: 'Coca-Cola 500ml', cat: 'Bebidas', qty: 1, modifiers: [], notes: '' },
      { name: 'Flan con dulce', cat: 'Postres', qty: 1, modifiers: ['extra dulce'], notes: '' }
    ]
  });
  // Sin id: prueba en todas. Con id: prueba SOLO esa comandera (ticket completo, sin filtrar).
  function testPrint(stationId) {
    if (!stationId) return print(TEST_TICKET());
    const cfg = getCfg();
    const st = (cfg.stations || []).find(s => s.id === stationId);
    if (!st) throw new Error('No encontré esa comandera.');
    const scfg = stationCfg(st, cfg, true);
    const t = TEST_TICKET();
    const head = (scfg.header || t.restaurant) + (scfg._nameSuffix ? ' - ' + scfg._nameSuffix : '');
    return printSingle(t, Object.assign({}, scfg, { header: head }));
  }

  // ---------- UI de configuración (modal autocontenido) ----------
  const METHOD_LABELS = {
    screen: 'Solo pantalla de cocina',
    browser: 'Por navegador',
    bluetooth: 'Bluetooth',
    usb: 'USB',
    network: 'Red / WiFi'
  };

  // Tarjetas visuales: cada tipo de conexión con su explicación simple.
  const METHOD_CARDS = [
    { k: 'network',   code: 'RED', name: 'Red / WiFi',   desc: 'Impresora con IP propia: cable al router o WiFi del local.' },
    { k: 'usb',       code: 'USB', name: 'USB',          desc: 'Cable directo a esta PC. Usa la impresora instalada en Windows.' },
    { k: 'bluetooth', code: 'BT',  name: 'Bluetooth',    desc: 'Termica portatil emparejada con este equipo.' },
    { k: 'browser',   code: 'PC',  name: 'Navegador',    desc: 'Abre el dialogo normal de impresion de la compu.' }
  ];

  function openConfig() {
    const cfg = getCfg();
    let stations = (cfg.stations || []).map(s => Object.assign({}, s));
    let editing = null;   // comandera en edición (copia de trabajo)
    let isNew = false;
    let kitchenAuto = !!cfg.kitchenAuto;
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
        #cmdr-modal .card .code,#cmdr-modal .strow .code{display:inline-flex;align-items:center;justify-content:center;width:36px;height:24px;border-radius:999px;background:#f8fafc;color:#64748b;font-size:11px;font-weight:900;letter-spacing:.04em;flex:none;}
        #cmdr-modal .card .nm{font-weight:800;font-size:14px;color:#0f172a;}
        #cmdr-modal .card .ds{font-size:11px;color:#64748b;line-height:1.35;}
        #cmdr-modal .panel{margin-top:12px;padding:14px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;}
        #cmdr-modal .panel.hide,#cmdr-modal .hide{display:none!important;}
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
        #cmdr-modal .msg{font-size:13px;margin-top:10px;padding:10px;border-radius:8px;display:none;white-space:pre-line;}
        #cmdr-modal .msg.ok{display:block;background:#d1fae5;color:#047857;}
        #cmdr-modal .msg.err{display:block;background:#fee2e2;color:#b91c1c;}
        #cmdr-modal .strow{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #e2e8f0;border-radius:14px;background:#fff;margin-bottom:8px;}
        #cmdr-modal .strow .stinfo{flex:1;min-width:0;}
        #cmdr-modal .strow .stname{font-weight:800;font-size:14.5px;color:#0f172a;}
        #cmdr-modal .strow .stsub{font-size:11.5px;color:#64748b;margin-top:1px;line-height:1.4;}
        #cmdr-modal .stdot{width:9px;height:9px;border-radius:50%;background:#ef4444;flex:none;}
        #cmdr-modal .stdot.ok{background:#10b981;}
        #cmdr-modal .stbtns{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
        #cmdr-modal .stbtn{padding:8px 10px;border:1px solid #e2e8f0;background:#fff;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;color:#475569;font-family:inherit;}
        #cmdr-modal .stbtn.danger{color:#b91c1c;border-color:#fecaca;}
      </style>
      <div class="sheet">

        <!-- VISTA LISTA: mis comanderas -->
        <div id="cmdr-list-view">
          <h2>Mis comanderas</h2>
          <p class="sub">Conectá cada comandera por separado y ponele nombre (Caja, Bar, Cocina...). Cada pedido sale en las que corresponda según lo que imprime cada una.</p>
          <div class="flow"><span>App equipo</span><span class="arr">&rarr;</span><span>Panel central</span><span class="arr">&rarr;</span><span>Comanderas</span></div>
          <div id="cmdr-stlist"></div>
          <button type="button" class="btn-connect" id="cmdr-add" style="margin-top:10px;">+ Conectar comandera</button>

          <label>Encabezado de los tickets (opcional)</label>
          <input type="text" id="cmdr-header" placeholder="Nombre del restaurante" value="${escapeHTML(cfg.header)}">
          <label>Pie (opcional)</label>
          <input type="text" id="cmdr-footer" placeholder="Ej: Apurar mesa" value="${escapeHTML(cfg.footer)}">

          <div class="toggle">
            <span>Usar esta PC como estacion central</span>
            <div class="sw ${cfg.kitchenAuto ? 'on' : ''}" id="cmdr-kauto"></div>
          </div>
          <div class="hint">Activala solo en la computadora del restaurante que queda prendida junto a las comanderas. El celular del mozo no imprime: solo envia el pedido.</div>

          <button type="button" class="btn-test" id="cmdr-test">Imprimir prueba en todas</button>
          <div class="msg" id="cmdr-msg"></div>

          <div class="btns">
            <button type="button" class="btn btn-ghost" id="cmdr-close">Cerrar</button>
            <button type="button" class="btn btn-primary" id="cmdr-save">Guardar</button>
          </div>
        </div>

        <!-- VISTA EDITAR: conectar una comandera -->
        <div id="cmdr-edit-view" class="hide">
          <h2 id="cmdr-edit-title">Conectar comandera</h2>
          <p class="sub">Le pones un nombre, elegis como esta conectada y la probas. Despues podes volver y agregar otra.</p>

          <label><span class="step">1</span>Nombre de la comandera</label>
          <input type="text" id="cmdr-name" placeholder="Ej: Caja, Bar, Cocina" maxlength="24">

          <label><span class="step">2</span>Como esta conectada</label>
          <div class="cards" id="cmdr-cards">
            ${METHOD_CARDS.map(m => `
            <button type="button" class="card" data-k="${m.k}">
              <span class="code">${m.code}</span>
              <span class="nm">${m.name}</span>
              <span class="ds">${m.desc}</span>
            </button>`).join('')}
          </div>

          <div class="panel hide" id="cmdr-net">
            <div class="status off" id="cmdr-net-status"><span class="dot"></span><span>Sin conectar</span></div>
            <a href="assets/comandera-bridge/instalar-gestiva-comandera.bat" download class="btn-test" style="display:block;text-align:center;text-decoration:none;margin:0 0 10px;">1. Instalar / actualizar estacion (una vez por PC)</a>
            <button type="button" class="btn-test" id="cmdr-pair" style="margin:0 0 10px;">2. Buscar comanderas en la red</button>
            <div id="cmdr-scan-results"></div>
            <label style="margin-top:12px">Si no la encuentra, escribi la IP del selftest</label>
            <div class="row">
              <input type="text" id="cmdr-ip" placeholder="Ej: 192.168.1.200">
              <input type="number" id="cmdr-port" placeholder="9100" value="9100" style="max-width:90px;">
            </div>
            <button type="button" class="btn-test" id="cmdr-save-ip" style="margin:10px 0 0;background:#fff;color:#475569;border-color:#cbd5e1;">Usar esta IP e imprimir prueba</button>
            <button type="button" class="btn-test" id="cmdr-download-pair" style="margin:10px 0 0;background:#fff;color:#64748b;border-color:#e2e8f0;">Modo soporte: descargar vinculacion</button>
            <div class="hint">Muchas comanderas imprimen su IP con un selftest: prendelas manteniendo apretado FEED. Puerto normal: 9100.</div>
          </div>

          <div class="panel hide" id="cmdr-usb">
            <div class="status off" id="cmdr-usb-status"><span class="dot"></span><span>Sin conectar</span></div>
            <a href="assets/comandera-bridge/instalar-gestiva-comandera.bat" download class="btn-test" style="display:block;text-align:center;text-decoration:none;margin:0 0 10px;">1. Instalar / actualizar estacion (una vez por PC)</a>
            <button type="button" class="btn-test" id="cmdr-usb-pair" style="margin:0 0 10px;">2. Detectar impresora USB y probar</button>
            <div id="cmdr-usb-results"></div>
            <div class="hint">Si la comandera esta enchufada por USB y prendida, se instala y conecta sola. No hace falta tocar nada en Windows.</div>
          </div>

          <div class="panel hide" id="cmdr-bt">
            <div class="status off" id="cmdr-bt-status"><span class="dot"></span><span>Sin conectar</span></div>
            <button type="button" class="btn-connect" id="cmdr-bt-connect">Conectar impresora Bluetooth</button>
            <div class="hint">Encende la impresora y toca Conectar (Chrome en Android). Se puede usar una comandera Bluetooth por equipo.</div>
          </div>

          <div class="panel hide" id="cmdr-browser-note">
            <div class="hint" style="margin:0;color:#475569;font-size:12.5px;">No hace falta conectar nada: al imprimir se abre el dialogo del navegador y elegis la impresora de esta computadora.</div>
          </div>

          <label><span class="step">3</span>Que imprime esta comandera</label>
          <div class="seg" id="cmdr-route">
            <button type="button" data-v="todo">Todo el pedido</button>
            <button type="button" data-v="solo">Solo estas categorias</button>
            <button type="button" data-v="resto">Todo menos estas</button>
          </div>
          <div id="cmdr-cats-box" class="hide" style="margin-top:10px;">
            <input type="text" id="cmdr-cats" placeholder="Bebidas,Tragos">
            <div class="hint">Separa con comas. Ejemplo: el <b>Bar</b> con "Solo estas categorias" y <b>Bebidas,Tragos</b> imprime unicamente las bebidas; la <b>Cocina</b> con "Todo menos estas" imprime el resto.</div>
          </div>

          <div class="toggle">
            <span>Imprime tambien los comprobantes de venta</span>
            <div class="sw" id="cmdr-receipts"></div>
          </div>
          <div class="hint">Prendelo en la comandera de la <b>caja</b>: ahi sale el ticket para el cliente al cobrar.</div>

          <label><span class="step">4</span>Papel y copias</label>
          <div class="row">
            <div style="flex:1"><div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;">Ancho de papel</div>
              <div class="seg" id="cmdr-paper">
                <button type="button" data-v="58">58 mm</button>
                <button type="button" data-v="80">80 mm</button>
              </div>
            </div>
            <div style="flex:1"><div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:6px;">Copias</div>
              <div class="seg" id="cmdr-copies">
                ${[1, 2, 3].map(n => `<button type="button" data-v="${n}">${n}</button>`).join('')}
              </div>
            </div>
          </div>

          <button type="button" class="btn-test" id="cmdr-etest">Imprimir prueba en esta comandera</button>
          <div class="msg" id="cmdr-emsg"></div>

          <div class="btns">
            <button type="button" class="btn btn-ghost" id="cmdr-back">Volver</button>
            <button type="button" class="btn btn-primary" id="cmdr-esave">Guardar comandera</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const $ = (sel) => wrap.querySelector(sel);
    const msgIn = (sel, txt, ok) => { const m = $(sel); if (!m) return; m.textContent = txt; m.className = txt ? ('msg ' + (ok ? 'ok' : 'err')) : 'msg'; };
    const msg = (txt, ok) => msgIn('#cmdr-msg', txt, ok);
    const emsg = (txt, ok) => msgIn('#cmdr-emsg', txt, ok);

    // ---------- helpers ----------
    function globalNow() {
      return {
        kitchenAuto,
        autoprint: cfg.autoprint,
        header: $('#cmdr-header').value.trim(),
        footer: $('#cmdr-footer').value.trim(),
        bridgeUrl: cfg.bridgeUrl
      };
    }
    function stationReady(st) {
      if (st.method === 'network') return !!st.printerIp;
      if (st.method === 'usb') return !!st.printerName;
      return true;
    }
    function stationSummary(st) {
      if (st.method === 'network') return st.printerIp ? ('Red/IP - ' + st.printerIp + ':' + (st.printerPort || 9100)) : 'Red/IP - falta conectar';
      if (st.method === 'usb') return st.printerName ? ('USB - ' + st.printerName) : 'USB - falta conectar';
      if (st.method === 'bluetooth') return 'Bluetooth' + ((_btChar && _btChar.service.device.gatt.connected) ? ' - conectada' : '');
      if (st.method === 'browser') return 'Navegador (dialogo del sistema)';
      return st.method || '';
    }
    function routeText(st) {
      if (st.route === 'solo') return 'Imprime solo: ' + (st.categories || '—');
      if (st.route === 'resto') return 'Imprime todo menos: ' + (st.categories || '—');
      return 'Imprime todo el pedido';
    }
    function setStatus(sel, ok, text) {
      const box = $(sel); if (!box) return;
      box.className = 'status ' + (ok ? 'ok' : 'off');
      const t = box.querySelector('span:last-child');
      if (t) t.textContent = text;
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
      box.innerHTML = '<div class="hint" style="margin:6px 0 8px;">Toca la impresora USB que corresponde a esta comandera:</div>' + visible;
      box.querySelectorAll('.cmdr-usb-pick').forEach(b => b.onclick = () => onPick(b.dataset.name));
    }
    // Imprime un ticket de prueba SOLO en esta comandera (con su conexión propia)
    async function probeStation(st) {
      const t = TEST_TICKET();
      const g = Object.assign({}, getCfg(), globalNow());
      const scfg = stationCfg(st, g, true);
      const head = (g.header || t.restaurant || 'Gestiva') + ' - ' + String(st.name || 'COMANDERA').toUpperCase();
      await printSingle(t, Object.assign({}, scfg, { header: head }));
    }
    // Mantiene el agente local sincronizado (imprime solo las 2 primeras red/USB en modo automático)
    async function syncAgent() {
      const next = getCfg();
      if (!next.kitchenAuto) return;
      if (!(next.method === 'network' || (next.method === 'usb' && next.printerName))) return;
      await ensurePrintStation();
      await pairPrintStation();
      await savePrintStationFullConfig(next);
    }

    // ---------- vista LISTA ----------
    function renderList() {
      const box = $('#cmdr-stlist');
      if (!stations.length) {
        box.innerHTML = '<div class="panel" style="margin-top:0;text-align:center;color:#64748b;font-size:13px;line-height:1.5;">Todavia no conectaste ninguna comandera.<br>Los pedidos quedan solo en la pantalla de cocina.</div>';
      } else {
        box.innerHTML = stations.map(st => {
          const card = METHOD_CARDS.find(m => m.k === st.method) || { code: '?' };
          return `<div class="strow" data-id="${st.id}">
            <span class="stdot ${stationReady(st) ? 'ok' : ''}"></span>
            <span class="code">${card.code}</span>
            <div class="stinfo">
              <div class="stname">${escapeHTML(st.name || 'Comandera')}</div>
              <div class="stsub">${escapeHTML(stationSummary(st))}<br>${escapeHTML(routeText(st))}${st.receipts ? ' · comprobantes' : ''}</div>
            </div>
            <div class="stbtns">
              <button type="button" class="stbtn st-probar">Probar</button>
              <button type="button" class="stbtn st-editar">Editar</button>
              <button type="button" class="stbtn danger st-borrar">Quitar</button>
            </div>
          </div>`;
        }).join('');
      }
      box.querySelectorAll('.strow').forEach(row => {
        const st = stations.find(s => s.id === row.dataset.id);
        if (!st) return;
        row.querySelector('.st-probar').onclick = async (ev) => {
          const b = ev.target; const o = b.textContent; b.disabled = true; b.textContent = '...';
          try { await probeStation(st); msg('Prueba enviada a "' + (st.name || 'Comandera') + '". Revisa esa impresora.', true); }
          catch (e) { msg((st.name || 'Comandera') + ': ' + (e.message || 'no se pudo imprimir.'), false); }
          b.disabled = false; b.textContent = o;
        };
        row.querySelector('.st-editar').onclick = () => openEditor(st);
        row.querySelector('.st-borrar').onclick = () => {
          if (!confirm('¿Quitar la comandera "' + (st.name || '') + '"? Deja de recibir pedidos desde este equipo.')) return;
          stations = stations.filter(s => s.id !== st.id);
          renderList();
        };
      });
      $('#cmdr-add').textContent = stations.length ? '+ Conectar otra comandera' : '+ Conectar mi primera comandera';
    }
    function showView(which) {
      $('#cmdr-list-view').classList.toggle('hide', which !== 'list');
      $('#cmdr-edit-view').classList.toggle('hide', which !== 'edit');
      const sheet = wrap.querySelector('.sheet');
      if (sheet) sheet.scrollTop = 0;
    }

    // ---------- vista EDITAR ----------
    function openEditor(st) {
      isNew = !st;
      editing = st ? Object.assign({}, st) : {
        id: newId(), name: '', method: 'network', printerName: '', printerIp: '', printerPort: 9100,
        paper: 58, copies: 1, route: 'todo', categories: '', receipts: stations.length === 0
      };
      $('#cmdr-edit-title').textContent = isNew ? 'Conectar comandera' : 'Editar: ' + (editing.name || 'Comandera');
      $('#cmdr-name').value = editing.name || '';
      $('#cmdr-ip').value = editing.printerIp || '';
      $('#cmdr-port').value = editing.printerPort || 9100;
      $('#cmdr-cats').value = editing.categories || '';
      $('#cmdr-scan-results').innerHTML = '';
      $('#cmdr-usb-results').innerHTML = '';
      emsg('', true);
      refreshEditUI();
      showView('edit');
      setTimeout(() => { try { $('#cmdr-name').focus(); } catch (e) {} }, 60);
    }
    function refreshEditUI() {
      if (!editing) return;
      wrap.querySelectorAll('#cmdr-cards .card').forEach(c => c.classList.toggle('on', c.dataset.k === editing.method));
      $('#cmdr-net').classList.toggle('hide', editing.method !== 'network');
      $('#cmdr-usb').classList.toggle('hide', editing.method !== 'usb');
      $('#cmdr-bt').classList.toggle('hide', editing.method !== 'bluetooth');
      $('#cmdr-browser-note').classList.toggle('hide', editing.method !== 'browser');
      wrap.querySelectorAll('#cmdr-route button').forEach(b => b.classList.toggle('on', b.dataset.v === (editing.route || 'todo')));
      $('#cmdr-cats-box').classList.toggle('hide', (editing.route || 'todo') === 'todo');
      wrap.querySelectorAll('#cmdr-paper button').forEach(b => b.classList.toggle('on', +b.dataset.v === (editing.paper || 58)));
      wrap.querySelectorAll('#cmdr-copies button').forEach(b => b.classList.toggle('on', +b.dataset.v === (editing.copies || 1)));
      $('#cmdr-receipts').classList.toggle('on', !!editing.receipts);
      setStatus('#cmdr-net-status', !!editing.printerIp, editing.printerIp ? ('Conectada: Red/IP - ' + editing.printerIp + ':' + (editing.printerPort || 9100)) : 'Sin conectar');
      setStatus('#cmdr-usb-status', !!editing.printerName, editing.printerName ? ('Conectada: USB - ' + editing.printerName) : 'Sin conectar');
      const btOk = !!(_btChar && _btChar.service.device.gatt.connected);
      setStatus('#cmdr-bt-status', btOk, btOk ? 'Conectada: Bluetooth' : 'Sin conectar');
    }
    function collectEditing() {
      editing.name = $('#cmdr-name').value.trim();
      editing.printerIp = $('#cmdr-ip').value.trim();
      editing.printerPort = +$('#cmdr-port').value || 9100;
      editing.categories = $('#cmdr-cats').value.trim();
      return editing;
    }

    // eventos del editor
    wrap.querySelectorAll('#cmdr-cards .card').forEach(c => c.onclick = () => {
      editing.method = c.dataset.k;
      if (c.dataset.k === 'network' || c.dataset.k === 'usb') { kitchenAuto = true; $('#cmdr-kauto').classList.add('on'); }
      refreshEditUI();
    });
    wrap.querySelectorAll('#cmdr-route button').forEach(b => b.onclick = () => { editing.route = b.dataset.v; refreshEditUI(); });
    wrap.querySelectorAll('#cmdr-paper button').forEach(b => b.onclick = () => { editing.paper = +b.dataset.v; refreshEditUI(); });
    wrap.querySelectorAll('#cmdr-copies button').forEach(b => b.onclick = () => { editing.copies = +b.dataset.v; refreshEditUI(); });
    $('#cmdr-receipts').onclick = () => { editing.receipts = !editing.receipts; refreshEditUI(); };

    // RED: buscar comanderas en la red y elegir la de ESTA comandera
    $('#cmdr-pair').onclick = async () => {
      const pairBtn = $('#cmdr-pair');
      const box = $('#cmdr-scan-results');
      const orig = pairBtn.textContent;
      const port = +($('#cmdr-port').value || 9100) || 9100;
      pairBtn.disabled = true; pairBtn.textContent = 'Buscando...';
      box.innerHTML = '<div class="hint">Revisando estacion de impresion...</div>';
      const useIp = async (ip) => {
        editing.printerIp = ip; editing.printerPort = port;
        $('#cmdr-ip').value = ip;
        refreshEditUI();
        try {
          await probeStation(collectEditing());
          box.innerHTML = '<div class="hint">Comandera conectada: <strong>' + escapeHTML(ip) + '</strong>. Se envio una prueba.</div>';
          emsg('Si salio el ticket en esta comandera, toca "Guardar comandera".', true);
        } catch (e) { emsg(e.message || 'No pude imprimir la prueba.', false); }
      };
      try {
        await ensurePrintStation();
        setStatus('#cmdr-net-status', false, 'Estacion detectada. Vinculando...');
        await pairPrintStation();
        box.innerHTML = '<div class="hint">Buscando comanderas en la red. Puede tardar unos segundos...</div>';
        const data = await scanPrintStation(port);
        const found = (data && data.printers) || [];
        const candidates = (data && data.candidates) || [];
        const usedIps = stations.filter(s => s.id !== editing.id && s.method === 'network' && s.printerIp).map(s => s.printerIp);
        if (found.length === 1) await useIp(found[0]);
        else if (found.length > 1) {
          box.innerHTML = '<div class="hint" style="margin:6px 0 8px;">Toca la comandera que corresponde a "' + escapeHTML($('#cmdr-name').value.trim() || 'esta comandera') + '":</div>' +
            found.map(ip => `<button type="button" class="cmdr-pick" data-ip="${escapeHTML(ip)}" style="display:block;width:100%;text-align:left;margin:0 0 6px;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;font-weight:700;cursor:pointer;font-family:inherit;">${escapeHTML(ip)}${usedIps.includes(ip) ? '<br><span style="font-size:11px;color:#94a3b8;">ya usada por otra comandera tuya</span>' : ''}</button>`).join('');
          box.querySelectorAll('.cmdr-pick').forEach(b => b.onclick = () => useIp(b.dataset.ip));
          emsg('Encontre varias comanderas en la red. Toca la que va con esta.', true);
        } else {
          setStatus('#cmdr-net-status', false, 'No se encontro automaticamente');
          const wifi = (data && data.wifi) ? String(data.wifi).trim() : '';
          const subnet = (data && data.subnets && data.subnets[0]) ? (data.subnets[0] + '.x') : '';
          const dondeEstoy = wifi
            ? ('la WiFi <strong>' + escapeHTML(wifi) + '</strong>' + (subnet ? ' (red ' + escapeHTML(subnet) + ')' : ''))
            : (subnet ? ('la red <strong>' + escapeHTML(subnet) + '</strong>') : 'esta red');
          const visible = candidates
            .slice(0, 8)
            .map(c => '<div class="hint" style="margin:6px 0;padding:8px 10px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;">Equipo visible: <strong>' + escapeHTML(c.ip) + '</strong> - puertos ' + escapeHTML((c.ports || []).join(', ')) + (c.likelyPrinter ? ' - posible impresora' : '') + '</div>')
            .join('');
          box.innerHTML =
            '<div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:12px 13px;border-radius:12px;line-height:1.5;font-size:13px;">' +
              '<strong>No hay comanderas en ' + dondeEstoy + '.</strong><br>' +
              'Si tus comanderas ya imprimen con otro sistema, casi seguro <strong>esta PC esta conectada a otra WiFi que las comanderas</strong>.<br><br>' +
              '<strong>&rarr; Conecta esta PC a la misma WiFi/red que las comanderas</strong> y volve a tocar &laquo;Buscar comanderas en la red&raquo;.' +
            '</div>' +
            (visible ? '<div class="hint" style="margin-top:10px;">Otros equipos que vi en la red (por las dudas):</div>' + visible : '') +
            '<div class="hint" style="margin-top:8px;">Si sabes la IP de la comandera (la que imprime el selftest), cargala abajo y toca &laquo;Usar esta IP e imprimir prueba&raquo;.</div>';
          emsg('No hay comanderas en tu red actual. Puede que esta PC este en otra WiFi que las comanderas.', false);
        }
      } catch (e) {
        setStatus('#cmdr-net-status', false, 'Falta instalar o actualizar estacion');
        box.innerHTML = '<div class="hint">Primero toca "Instalar / actualizar estacion", ejecuta el archivo descargado y despues volve a buscar.</div>';
        emsg(e.message || 'No se pudo conectar la estacion.', false);
      } finally {
        pairBtn.disabled = false; pairBtn.textContent = orig;
      }
    };
    // RED: IP manual
    $('#cmdr-save-ip').onclick = async () => {
      const b = $('#cmdr-save-ip'); const orig = b.textContent;
      collectEditing();
      if (!editing.printerIp) { emsg('Escribi la IP de la comandera (ej: 192.168.1.200).', false); return; }
      b.disabled = true; b.textContent = 'Probando...';
      try {
        await probeStation(editing);
        refreshEditUI();
        emsg('Prueba enviada a ' + editing.printerIp + '. Si salio el ticket, toca "Guardar comandera".', true);
      } catch (e) { emsg(e.message || 'No se pudo imprimir en esa IP.', false); }
      b.disabled = false; b.textContent = orig;
    };
    // Soporte: descargar vinculación
    $('#cmdr-download-pair').onclick = async () => {
      const b = $('#cmdr-download-pair'); const orig = b.textContent;
      b.disabled = true; b.textContent = 'Preparando...';
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
        emsg('Archivo de vinculacion descargado. Usalo solo para soporte tecnico de esta PC.', true);
      } catch (e) {
        emsg(e.message || 'No pude preparar la vinculacion.', false);
      } finally {
        b.disabled = false; b.textContent = orig;
      }
    };
    // USB: detectar impresora instalada (o instalarla sola)
    $('#cmdr-usb-pair').onclick = async () => {
      const usbBtn = $('#cmdr-usb-pair');
      const box = $('#cmdr-usb-results');
      const orig = usbBtn.textContent;
      usbBtn.disabled = true; usbBtn.textContent = 'Detectando...';
      box.innerHTML = '<div class="hint">Revisando estacion e impresoras instaladas en Windows...</div>';
      const useName = async (name) => {
        editing.printerName = name;
        refreshEditUI();
        try {
          await probeStation(collectEditing());
          box.innerHTML = '<div class="hint">Impresora USB conectada: <strong>' + escapeHTML(name) + '</strong>. Se envio una prueba.</div>';
          emsg('Si salio el ticket, toca "Guardar comandera".', true);
        } catch (e) { emsg(e.message || 'No pude imprimir la prueba USB.', false); }
      };
      try {
        await ensurePrintStation();
        setStatus('#cmdr-usb-status', false, 'Estacion detectada. Vinculando...');
        await pairPrintStation();
        const data = await listPrintStationPrinters();
        const printers = (data && data.printers) || [];
        const suggested = data && data.suggested;
        const likely = printers.filter(p => p.likelyComandera && !p.isVirtual);
        const usable = likely.length ? likely : printers.filter(p => !p.isVirtual);
        const usedNames = stations.filter(s => s.id !== editing.id && s.method === 'usb' && s.printerName).map(s => s.printerName);
        const fresh = usable.filter(p => !usedNames.includes(p.name));
        const pickFrom = fresh.length ? fresh : usable;
        const autoPick = (suggested && suggested.name && !usedNames.includes(suggested.name)) ? suggested.name : (pickFrom.length === 1 ? pickFrom[0].name : '');
        if (autoPick) await useName(autoPick);
        else if (pickFrom.length > 1) {
          renderPrinterChoices(pickFrom, useName);
          emsg('Encontre varias impresoras. Toca la que corresponde a esta comandera.', true);
        } else {
          box.innerHTML = '<div class="hint">No hay impresoras instaladas. Reviso si hay una comandera USB conectada para instalarla sola...</div>';
          let pending = [];
          try { const d = await usbDetect(); pending = (d && d.pending) || []; } catch (e) {}
          if (pending.length) {
            box.innerHTML = '<div class="hint">Detecte una comandera USB (<strong>' + escapeHTML(pending[0].device) + '</strong>) sin instalar. Instalandola sola...</div>';
            const inst = await usbInstall(pending[0].port);
            const name = inst && inst.printerName;
            if (!name) throw new Error('No se pudo instalar la impresora USB.');
            await useName(name);
          } else {
            setStatus('#cmdr-usb-status', false, 'No hay comandera USB conectada');
            box.innerHTML = '<div class="hint">No detecte ninguna comandera USB conectada a esta PC. Revisa que el cable este bien enchufado y la impresora prendida, y volve a detectar.</div>';
            emsg('No detecte ninguna comandera USB conectada.', false);
          }
        }
      } catch (e) {
        setStatus('#cmdr-usb-status', false, 'Falta instalar o actualizar estacion');
        box.innerHTML = '<div class="hint">Primero toca "Instalar / actualizar estacion", ejecuta el archivo descargado y despues volve a detectar.</div>';
        emsg(e.message || 'No se pudo conectar la estacion USB.', false);
      } finally {
        usbBtn.disabled = false; usbBtn.textContent = orig;
      }
    };
    // BLUETOOTH
    $('#cmdr-bt-connect').onclick = async () => {
      const b = $('#cmdr-bt-connect'); b.disabled = true;
      try {
        emsg('Buscando impresora Bluetooth...', true);
        await getBluetoothChar();
        emsg('Impresora Bluetooth conectada. Proba imprimir abajo.', true);
      } catch (e) { emsg(e.message || 'No se pudo conectar.', false); }
      b.disabled = false; refreshEditUI();
    };
    // Probar SOLO esta comandera
    $('#cmdr-etest').onclick = async () => {
      collectEditing();
      if (!stationReady(editing)) { emsg('Primero conecta la comandera (paso 2).', false); return; }
      const b = $('#cmdr-etest'); b.disabled = true;
      try { emsg('Enviando prueba...', true); await probeStation(editing); emsg('Prueba enviada. Revisa la impresora.', true); }
      catch (e) { emsg(e.message || 'No se pudo imprimir.', false); }
      b.disabled = false;
    };
    // Guardar comandera (vuelve a la lista)
    $('#cmdr-esave').onclick = () => {
      collectEditing();
      if (!editing.name) { emsg('Ponele un nombre a la comandera (ej: Caja, Bar, Cocina).', false); try { $('#cmdr-name').focus(); } catch (e) {} return; }
      if (editing.method === 'network' && !editing.printerIp) { emsg('Falta conectarla: busca la comandera en la red o escribi su IP.', false); return; }
      if (editing.method === 'usb' && !editing.printerName) { emsg('Falta conectarla: detecta la impresora USB.', false); return; }
      if ((editing.route === 'solo' || editing.route === 'resto') && !parseCats(editing.categories).length) { emsg('Escribi las categorias (ej: Bebidas,Tragos).', false); return; }
      const i = stations.findIndex(s => s.id === editing.id);
      if (i >= 0) stations[i] = Object.assign({}, editing); else stations.push(Object.assign({}, editing));
      renderList();
      showView('list');
      msg('Comandera "' + editing.name + '" lista. Toca Guardar para confirmar los cambios.', true);
    };
    $('#cmdr-back').onclick = () => showView('list');

    // eventos vista lista
    $('#cmdr-add').onclick = () => openEditor(null);
    $('#cmdr-kauto').onclick = () => { kitchenAuto = !kitchenAuto; $('#cmdr-kauto').classList.toggle('on', kitchenAuto); };
    $('#cmdr-test').onclick = async () => {
      if (!stations.length) { msg('Conecta al menos una comandera primero.', false); return; }
      const b = $('#cmdr-test'); b.disabled = true;
      msg('Enviando prueba a todas...', true);
      const errs = [];
      for (const st of stations) {
        try { await probeStation(st); } catch (e) { errs.push((st.name || 'Comandera') + ': ' + (e.message || e)); }
      }
      if (errs.length) msg(errs.join('\n'), false);
      else msg('Prueba enviada a ' + stations.length + ' comandera' + (stations.length === 1 ? '' : 's') + '.', true);
      b.disabled = false;
    };
    $('#cmdr-save').onclick = async () => {
      saveStations(stations, globalNow());
      try {
        await syncAgent();
      } catch (e) {
        msg((e.message || 'No pude configurar la estacion de impresion.') + '\nLas comanderas quedaron guardadas igual. Podes cerrar.', false);
        return;
      }
      wrap.remove();
      if (typeof window.onComanderaSaved === 'function') window.onComanderaSaved(getCfg());
    };
    $('#cmdr-close').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });

    renderList();
    showView('list');
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

  // Imprime el comprobante por el navegador (diálogo del sistema)
  function receiptViaBrowser(sale, cfg) {
    const html = receiptHTML(sale, cfg);
    const ifr = document.createElement('iframe');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(ifr);
    return new Promise((resolve) => {
      ifr.onload = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {} setTimeout(() => { ifr.remove(); resolve(); }, 1500); };
      const d = ifr.contentWindow.document; d.open(); d.write(html); d.close();
    });
  }
  // El comprobante sale en las comanderas marcadas "imprime comprobantes" (la caja).
  // Si no hay ninguna, se abre el diálogo del navegador: al cliente hay que darle algo.
  async function printReceipt(sale, opts) {
    const cfg = Object.assign(getCfg(), opts || {});
    const targets = (cfg.stations || []).filter(st => st.receipts);
    if (!targets.length) {
      await receiptViaBrowser(sale, cfg);
      return { ok: true, method: 'browser' };
    }
    const errors = [];
    for (const st of targets) {
      try {
        const scfg = stationCfg(st, cfg, false);
        if (st.method === 'browser') { await receiptViaBrowser(sale, scfg); continue; }
        let bytes = escposReceipt(sale, scfg);
        const copies = Math.max(1, Math.min(3, scfg.copies || 1));
        if (copies > 1) bytes = concatCopies(bytes, copies);
        if (st.method === 'bluetooth') await printBluetooth(bytes);
        else if (st.method === 'usb') {
          if (scfg.printerName) await printWindowsPrinter(bytes, scfg);
          else await printUSB(bytes);
        }
        else if (st.method === 'network') await printNetwork(bytes, scfg);
      } catch (e) {
        errors.push((st.name || 'Comandera') + ': ' + (e.message || e));
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { ok: true, printed: targets.map(t => t.name) };
  }

  window.Comandera = {
    getCfg, setCfg, print, testPrint, ticketHTML, escpos, openConfig,
    checkBridge, probeNetworkPrinter,
    receiptHTML, escposReceipt, printReceipt, payLabel,
    getStations, saveStations,
    METHOD_LABELS, PAY_LABELS,
    _methods: ['screen', 'browser', 'bluetooth', 'usb', 'network']
  };
})();

