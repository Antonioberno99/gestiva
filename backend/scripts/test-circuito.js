// E2E del circuito real de un restaurante:
//   mozo (celular) -> backend -> cocina (KDS) -> comandera (estación de impresión)
// Simula los fallos que pasan en un servicio: wifi que se corta, reintentos,
// dos mozos en la misma mesa, y la PC de comandas que se reinicia.
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

(async () => {
  const email = `resto-${Date.now()}@test.local`;

  seccion('SETUP — restaurante, mozo y productos');
  const reg = await req('/auth/register', {
    method: 'POST',
    body: { email, password: 'Secreta123', restaurantName: 'El Buen Sabor' }
  });
  check('restaurante registrado', reg.status === 200 && !!reg.data.token, JSON.stringify(reg.data).slice(0, 200));
  const owner = reg.data.token;

  const w = await req('/api/waiters', { method: 'POST', token: owner, body: { name: 'Carlos', role: 'Mozo', pin: '4321' } });
  check('mozo creado con PIN', w.status === 200, JSON.stringify(w.data).slice(0, 150));

  const prod = await req('/api/products', { method: 'POST', token: owner, body: { name: 'Milanesa napolitana', cat: 'Comida', price: 12000 } });
  const prodBebida = await req('/api/products', { method: 'POST', token: owner, body: { name: 'Coca 500', cat: 'Bebidas', price: 2500 } });
  check('productos cargados', prod.status === 200 && prodBebida.status === 200);

  const tables = await req('/api/tables', { token: owner });
  check('mesas por defecto creadas', Array.isArray(tables.data) && tables.data.length > 0, `n=${tables.data.length}`);
  const mesa = tables.data[0];

  seccion('1. EL MOZO ENTRA DESDE EL CELULAR');
  const login = await req('/waiter/login', { method: 'POST', body: { email, pin: '4321' } });
  check('login del mozo con email + PIN', login.status === 200 && !!login.data.token, JSON.stringify(login.data).slice(0, 150));
  const mozo = login.data.token;

  const boot = await req('/waiter/bootstrap', { token: mozo });
  check('bootstrap trae mesas y productos', boot.status === 200 && boot.data.tables.length > 0 && boot.data.products.length > 0);

  seccion('2. ABRE MESA Y CARGA EL PEDIDO');
  const open = await req('/waiter/open-tables', { method: 'POST', token: mozo, body: { tableId: mesa.id } });
  check('mesa abierta', open.status === 200, JSON.stringify(open.data).slice(0, 150));
  check('la mesa arranca en rev 0', open.data.rev === 0, `rev=${open.data.rev}`);

  const items1 = [{ productId: prod.data.id, qty: 2, sentToKitchen: false, notes: 'sin sal' }];
  const put1 = await req('/waiter/open-tables/' + mesa.id, { method: 'PUT', token: mozo, body: { items: items1, rev: 0 } });
  check('items guardados y rev sube a 1', put1.status === 200 && put1.data.rev === 1, `rev=${put1.data.rev}`);

  seccion('3. ENVÍA A COCINA — Y SE CORTA EL WIFI (reintento)');
  const ticketId = 'ct-' + Date.now();
  const kitchenBody = {
    tableId: mesa.id,
    clientTicketId: ticketId,
    items: [{ name: 'Milanesa napolitana', qty: 2, cat: 'Comida', notes: 'sin sal' }]
  };
  const env1 = await req('/waiter/kitchen', { method: 'POST', token: mozo, body: kitchenBody });
  check('comanda creada', env1.status === 200 && !!env1.data.id, JSON.stringify(env1.data).slice(0, 150));
  check('primera vez NO es duplicado', env1.data.duplicate === false);

  // El celular no recibió la respuesta (wifi cortado) y reintenta con el mismo id.
  const env2 = await req('/waiter/kitchen', { method: 'POST', token: mozo, body: kitchenBody });
  check('reintento devuelve la MISMA comanda', env2.status === 200 && env2.data.id === env1.data.id, `${env1.data.id} vs ${env2.data.id}`);
  check('el reintento se marca como duplicado', env2.data.duplicate === true);

  // Y un tercer reintento, por las dudas (mozo impaciente que toca dos veces).
  await req('/waiter/kitchen', { method: 'POST', token: mozo, body: kitchenBody });

  const kds1 = await req('/api/kitchen', { token: owner });
  check('la cocina ve UNA sola comanda (no 3)', kds1.data.length === 1, `comandas=${kds1.data.length}`);

  seccion('4. LA COMANDERA IMPRIME (cola persistente en la base)');
  const cola1 = await req('/api/print-queue', { token: owner });
  check('la comanda aparece en la cola de impresión', cola1.data.length === 1, `pendientes=${cola1.data.length}`);
  check('la cola trae los items para el ticket', cola1.data[0].items[0].name === 'Milanesa napolitana');

  const ack = await req('/api/print-queue/ack', { method: 'POST', token: owner, body: { ids: [cola1.data[0].id] } });
  check('la estación confirma la impresión', ack.status === 200 && ack.data.acked.length === 1);

  const cola2 = await req('/api/print-queue', { token: owner });
  check('la cola queda vacía (no reimprime)', cola2.data.length === 0, `pendientes=${cola2.data.length}`);

  seccion('5. SE REINICIA LA PC DE COMANDAS A MITAD DEL SERVICIO');
  // Mientras la estación está caída, entra otro pedido.
  const ticketCaida = 'ct-caida-' + Date.now();
  await req('/waiter/kitchen', {
    method: 'POST', token: mozo,
    body: { tableId: mesa.id, clientTicketId: ticketCaida, items: [{ name: 'Coca 500', qty: 3, cat: 'Bebidas' }] }
  });
  // La estación vuelve y consulta la cola: ANTES esto se perdía para siempre.
  const colaTrasReinicio = await req('/api/print-queue', { token: owner });
  check('el pedido que entró con la PC caída SIGUE en la cola', colaTrasReinicio.data.length === 1, `pendientes=${colaTrasReinicio.data.length}`);
  check('es el pedido correcto', colaTrasReinicio.data[0].items[0].name === 'Coca 500');
  check('la comanda ya impresa NO vuelve a salir', !colaTrasReinicio.data.some(t => t.id === env1.data.id));

  seccion('6. REIMPRESIÓN MANUAL (se trabó el papel)');
  const re = await req(`/api/print-queue/${env1.data.id}/reprint`, { method: 'POST', token: owner });
  check('la comanda vieja vuelve a la cola', re.status === 200);
  const colaRe = await req('/api/print-queue', { token: owner });
  check('ahora hay 2 para imprimir', colaRe.data.length === 2, `pendientes=${colaRe.data.length}`);
  await req('/api/print-queue/ack', { method: 'POST', token: owner, body: { ids: colaRe.data.map(t => t.id) } });

  seccion('7. DOS DISPOSITIVOS EN LA MISMA MESA');
  const estado = await req('/waiter/bootstrap', { token: mozo });
  const otActual = estado.data.openTables.find(o => o.table_id === mesa.id);
  const revActual = otActual.rev;

  // Dispositivo A guarda con el rev correcto.
  const a = await req('/waiter/open-tables/' + mesa.id, {
    method: 'PUT', token: mozo,
    body: { items: [{ productId: prod.data.id, qty: 2, sentToKitchen: true }], rev: revActual }
  });
  check('dispositivo A guarda bien', a.status === 200, `rev=${a.data.rev}`);

  // Dispositivo B tenía la pantalla vieja: manda el rev anterior.
  const b = await req('/waiter/open-tables/' + mesa.id, {
    method: 'PUT', token: mozo,
    body: { items: [{ productId: prodBebida.data.id, qty: 9, sentToKitchen: false }], rev: revActual }
  });
  check('dispositivo B recibe 409 (no pisa)', b.status === 409 && b.data.error === 'rev_conflict', `status=${b.status}`);
  check('el 409 devuelve el estado actual para fusionar', !!b.data.current && Array.isArray(b.data.current.items));

  const trasConflicto = await req('/waiter/bootstrap', { token: mozo });
  const otFinal = trasConflicto.data.openTables.find(o => o.table_id === mesa.id);
  check('los items de A sobrevivieron', otFinal.items.length === 1 && otFinal.items[0].qty === 2, JSON.stringify(otFinal.items));

  seccion('8. LA COCINA MARCA EL PEDIDO');
  const kdsFinal = await req('/api/kitchen', { token: owner });
  const primerTicket = kdsFinal.data[0];
  const prep = await req('/api/kitchen/' + primerTicket.id, { method: 'PUT', token: owner, body: { status: 'preparing' } });
  check('cocina pasa a "en preparación"', prep.status === 200 && prep.data.status === 'preparing');
  const ready = await req('/api/kitchen/' + primerTicket.id, { method: 'PUT', token: owner, body: { status: 'ready' } });
  check('cocina marca "listo"', ready.status === 200 && ready.data.status === 'ready' && !!ready.data.ready_at);

  seccion('9. COMPATIBILIDAD — cliente viejo sin los campos nuevos');
  const viejo = await req('/waiter/kitchen', {
    method: 'POST', token: mozo,
    body: { tableId: mesa.id, items: [{ name: 'Postre', qty: 1 }] }   // sin clientTicketId
  });
  check('una app vieja (sin clientTicketId) sigue funcionando', viejo.status === 200 && !!viejo.data.id);
  const otV = trasConflicto.data.openTables.find(o => o.table_id === mesa.id);
  const putViejo = await req('/waiter/open-tables/' + mesa.id, {
    method: 'PUT', token: mozo, body: { items: otV.items }   // sin rev
  });
  check('guardar sin rev sigue funcionando', putViejo.status === 200);

  console.log(`\n${'─'.repeat(52)}`);
  console.log(fail === 0
    ? `\x1b[32m\x1b[1m✅ ${pass}/${pass + fail} — el circuito completo pasa\x1b[0m`
    : `\x1b[31m\x1b[1m${fail} FALLARON\x1b[0m  (${pass} ok)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\n💥 Error:', e); process.exit(1); });
