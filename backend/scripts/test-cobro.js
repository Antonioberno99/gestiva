// Integridad del cobro y la caja: lo que pasa en el mostrador cuando el cajero
// toca dos veces "Confirmar cobro", cuando dos personas cobran a la vez y
// cuando se cierra la caja.
//
//   GESTIVA_API=http://127.0.0.1:3100 node scripts/test-cobro.js
const API = process.env.GESTIVA_API || 'http://127.0.0.1:3100';

let pass = 0, fail = 0;
function check(nombre, ok, detalle) {
  if (ok) { pass++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${detalle ? '  → ' + detalle : ''}`); }
}
function seccion(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

async function req(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  return { status: r.status, data };
}

async function nuevoLocal(nombre) {
  const email = `cobro-${Date.now()}-${Math.random().toString(16).slice(2, 6)}@test.local`;
  const reg = await req('/auth/register', { method: 'POST', body: { email, password: 'Secreta123', restaurantName: nombre } });
  const owner = reg.data.token;
  const prod = await req('/api/products', { method: 'POST', token: owner, body: { name: 'Bife de chorizo', cat: 'Comida', price: 10000, stock: 50 } });
  const tables = await req('/api/tables', { token: owner });
  const w = await req('/api/waiters', { method: 'POST', token: owner, body: { name: 'Mozo Test', pin: '7777' } });
  return { email, owner, prod: prod.data, tables: tables.data, waiterId: w.data.id };
}

async function abrirMesaConItems(L, mesa, qty) {
  await req('/api/open-tables', { method: 'POST', token: L.owner, body: { tableId: mesa.id, waiterId: L.waiterId } });
  await req('/api/open-tables/' + mesa.id, { method: 'PUT', token: L.owner, body: { items: [{ productId: L.prod.id, qty, sentToKitchen: true }] } });
}

(async () => {
  seccion('SETUP');
  const L = await nuevoLocal('Parrilla Doble Toque');
  check('local creado', !!L.owner && !!L.prod.id && L.tables.length > 2);
  const caja = await req('/api/cash/open', { method: 'POST', token: L.owner, body: { openingAmount: 5000 } });
  check('caja abierta con $5.000', caja.status === 200);

  seccion('1. EL CAJERO TOCA DOS VECES "CONFIRMAR COBRO"');
  const mesa1 = L.tables[0];
  await abrirMesaConItems(L, mesa1, 2);   // 2 × $10.000 = $20.000
  const cobro = { tableId: mesa1.id, paymentMethod: 'efectivo' };
  const [a, b] = await Promise.all([
    req('/api/orders', { method: 'POST', token: L.owner, body: cobro }),
    req('/api/orders', { method: 'POST', token: L.owner, body: cobro })
  ]);
  const okCount = [a, b].filter(r => r.status === 200).length;
  check('solo UNO de los dos cobros se registra', okCount === 1, `status: ${a.status} y ${b.status}`);
  const rechazado = [a, b].find(r => r.status !== 200);
  check('el segundo recibe un error claro (ya cobrada)', !!rechazado && /table_not_open|already/.test(rechazado.data.error || ''), JSON.stringify(rechazado && rechazado.data));

  const ordenes = await req('/api/orders?limit=50', { token: L.owner });
  check('queda UNA venta registrada', ordenes.data.length === 1, `ventas=${ordenes.data.length}`);

  let cash = (await req('/api/cash', { token: L.owner })).data.current;
  const ingresos = (cash.transactions || []).filter(t => t.type === 'in');
  check('la caja tiene UN ingreso de $20.000 (no dos)', ingresos.length === 1 && Number(ingresos[0].amount) === 20000,
        JSON.stringify(ingresos.map(t => t.amount)));

  const prods = await req('/api/products', { token: L.owner });
  const bife = prods.data.find(p => p.id === L.prod.id);
  check('el stock baja 2, no 4', Number(bife.stock) === 48, `stock=${bife.stock}`);

  seccion('2. DOS CAJAS COBRAN DISTINTAS MESAS AL MISMO TIEMPO');
  const mesas = L.tables.slice(1, 6);   // 5 mesas
  for (const m of mesas) await abrirMesaConItems(L, m, 1);
  const res = await Promise.all(mesas.map(m =>
    req('/api/orders', { method: 'POST', token: L.owner, body: { tableId: m.id, paymentMethod: 'efectivo' } })));
  check('las 5 mesas se cobran', res.every(r => r.status === 200), res.map(r => r.status).join(','));
  cash = (await req('/api/cash', { token: L.owner })).data.current;
  const nIn = (cash.transactions || []).filter(t => t.type === 'in').length;
  check('la caja registra los 6 cobros (ninguno se pisa)', nIn === 6, `ingresos en caja=${nIn}`);

  seccion('3. DELIVERY: DOBLE TOQUE AL COBRAR UN PEDIDO');
  const po = await req('/api/pending-orders', {
    method: 'POST', token: L.owner,
    body: { kind: 'delivery', customerName: 'Juana', deliveryAddress: 'Calle 1', items: [{ productId: L.prod.id, name: 'Bife de chorizo', qty: 1 }] }
  });
  check('pedido de delivery creado', po.status === 200 && !!po.data.id);
  const cobroPo = { paymentMethod: 'transferencia' };
  const [p1, p2] = await Promise.all([
    req(`/api/pending-orders/${po.data.id}/charge`, { method: 'POST', token: L.owner, body: cobroPo }),
    req(`/api/pending-orders/${po.data.id}/charge`, { method: 'POST', token: L.owner, body: cobroPo })
  ]);
  check('solo UN cobro del delivery se registra', [p1, p2].filter(r => r.status === 200).length === 1, `status: ${p1.status} y ${p2.status}`);
  const p3 = await req(`/api/pending-orders/${po.data.id}/charge`, { method: 'POST', token: L.owner, body: cobroPo });
  check('cobrarlo de nuevo más tarde también se rechaza', p3.status === 409, `status=${p3.status}`);
  const ventas = await req('/api/orders?limit=50', { token: L.owner });
  check('ventas totales = 7 (1 + 5 mesas + 1 delivery)', ventas.data.length === 7, `ventas=${ventas.data.length}`);

  seccion('4. CIERRE DE CAJA: EL EFECTIVO SE COMPARA CON EL EFECTIVO');
  // Hasta acá: apertura 5.000 + efectivo 20.000 + 5×10.000 = 75.000 en el cajón.
  // La transferencia de 10.000 del delivery NO está en el cajón.
  const mesaTarjeta = L.tables[6];
  await abrirMesaConItems(L, mesaTarjeta, 3);   // 30.000 con débito
  await req('/api/orders', { method: 'POST', token: L.owner, body: { tableId: mesaTarjeta.id, paymentMethod: 'debito' } });
  await req('/api/cash/movement', { method: 'POST', token: L.owner, body: { type: 'out', amount: 2000, desc: 'Hielo', method: 'efectivo' } });
  // En el cajón: 75.000 − 2.000 = 73.000. El cajero cuenta 73.000 justo.
  const cierre = await req('/api/cash/close', { method: 'POST', token: L.owner, body: { closingAmount: 73000 } });
  check('cierre OK', cierre.status === 200, JSON.stringify(cierre.data));
  check('efectivo esperado = $73.000 (sin tarjeta ni transferencia)', Number(cierre.data.expectedCash) === 73000, `esperado=${cierre.data.expectedCash}`);
  check('diferencia = $0 si el cajero contó bien', Number(cierre.data.diff) === 0, `diff=${cierre.data.diff}`);
  check('informa lo cobrado por cada método', cierre.data.byMethod && Number(cierre.data.byMethod.debito) === 30000 && Number(cierre.data.byMethod.transferencia) === 10000,
        JSON.stringify(cierre.data.byMethod));

  seccion('5. NO SE PUEDE BORRAR UN PRODUCTO QUE ESTÁ EN UNA MESA ABIERTA');
  await req('/api/cash/open', { method: 'POST', token: L.owner, body: { openingAmount: 0 } });
  const mesaAbierta = L.tables[7];
  await abrirMesaConItems(L, mesaAbierta, 1);
  const del = await req('/api/products/' + L.prod.id, { method: 'DELETE', token: L.owner });
  check('el borrado se rechaza con un motivo claro', del.status === 409 && del.data.error === 'product_in_open_order', `status=${del.status} ${JSON.stringify(del.data)}`);
  const cobroAbierta = await req('/api/orders', { method: 'POST', token: L.owner, body: { tableId: mesaAbierta.id, paymentMethod: 'efectivo' } });
  check('la mesa se cobra a precio completo ($10.000, no $0)', cobroAbierta.status === 200 && Number(cobroAbierta.data.total) === 10000, `total=${cobroAbierta.data.total}`);

  console.log(`\n${'─'.repeat(54)}`);
  console.log(fail === 0
    ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — cobro y caja sin duplicados ni pérdidas\x1b[0m`
    : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m  (${pass} ok)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\n💥 Error:', e); process.exit(1); });
