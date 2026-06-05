#!/usr/bin/env node
/* ============================================================
   Gestiva — Puente de Comandera (impresoras de red / IP)
   ------------------------------------------------------------
   Los navegadores no pueden mandar datos crudos a una impresora
   por su IP. Este pequeño puente corre en la PC del local y recibe
   el pedido desde Gestiva para enviarlo a la impresora (ESC/POS, puerto 9100).

   USO:
     1) Instalá Node.js (https://nodejs.org) si no lo tenés.
     2) Doble clic en "iniciar-comandera.bat" (Windows) o corré:  node comandera-bridge.js
     3) En Gestiva → botón Comandera → elegí "Red / WiFi", poné la IP de la impresora.

   No requiere dependencias. Escucha sólo en esta PC (127.0.0.1:7777).
   ============================================================ */
const http = require('http');
const net = require('net');

const PORT = process.env.COMANDERA_PORT ? parseInt(process.env.COMANDERA_PORT, 10) : 7777;
const HOST = '127.0.0.1';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendToPrinter(ip, port, buffer) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (err) => { if (done) return; done = true; try { socket.destroy(); } catch (e) {} err ? reject(err) : resolve(); };
    socket.setTimeout(8000);
    socket.on('timeout', () => finish(new Error('timeout conectando a la impresora ' + ip + ':' + port)));
    socket.on('error', (e) => finish(e));
    socket.connect(port, ip, () => {
      socket.write(buffer, () => { setTimeout(() => finish(null), 300); });
    });
  });
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Puente de Comandera de Gestiva: ACTIVO ✓\nDejá esta ventana abierta mientras usás el sistema.');
  }

  if (req.method === 'POST' && req.url.replace(/\/$/, '') === '/print') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { ip, port, data } = JSON.parse(body || '{}');
        if (!ip || !data) throw new Error('faltan ip o data');
        const buffer = Buffer.from(data, 'base64');
        await sendToPrinter(ip, parseInt(port, 10) || 9100, buffer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        console.log(new Date().toLocaleTimeString(), '→ impreso en', ip + ':' + (port || 9100), '(' + buffer.length + ' bytes)');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        console.error(new Date().toLocaleTimeString(), '✗ error:', e.message || e);
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log('============================================');
  console.log('  Gestiva — Puente de Comandera ACTIVO');
  console.log('  Escuchando en http://' + HOST + ':' + PORT);
  console.log('  Dejá esta ventana ABIERTA mientras trabajás.');
  console.log('  Para cerrar: cerrá esta ventana.');
  console.log('============================================');
});
