// Asistente de Gestiva — responde dudas del dueño del restaurante con Claude.
// Dos cosas lo hacen útil de verdad:
//  1) conoce Gestiva (manual abajo), así que explica cómo hacer las cosas;
//  2) ve un resumen de los datos REALES del negocio, así que puede responder
//     "¿qué producto me deja más plata?" y no solo generalidades.
//
// Variables de entorno:
//   ANTHROPIC_API_KEY → si falta, el asistente se apaga solo (no rompe nada).
//   ASSISTANT_MODEL   → opcional, por defecto claude-opus-5
const Anthropic = require('@anthropic-ai/sdk');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5';
const client = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

const enabled = () => !!client;

// ============================================================
//  MANUAL DE GESTIVA
//  Va primero y no cambia nunca → se cachea y el costo por pregunta baja mucho.
// ============================================================
const MANUAL = `Sos el asistente de Gestiva, un sistema de gestión para restaurantes, bares y cafeterías de Argentina.
Ayudás al DUEÑO o ENCARGADO del local: gente de gastronomía, no técnica.

## Cómo funciona Gestiva

**Panel principal (la compu del local)** — secciones del menú lateral:
- **Dashboard**: resumen del día (ventas, mesas ocupadas, caja).
- **Mesas**: plano del salón. Cada mesa puede estar libre, ocupada o reservada. Se abre una mesa, se le cargan consumos y al final se cobra. Se pueden agrupar mesas por salón/ambiente.
- **Pedidos**: los pedidos que mandan los mozos desde el celular y esperan preparación.
- **Productos**: la carta. Cada producto tiene nombre, precio, categoría, tipo y sub-segmento, foto, descripción, stock y alerta de stock bajo. También se arma acá la Carta QR.
- **Caja**: apertura y cierre de caja, movimientos, arqueo. Queda historial por día.
- **Clientes**: base de clientes con cuenta corriente (fiado) y su historial.
- **Mozos / Equipo**: se crean los integrantes con un PIN. Con ese PIN entran a la app de mozos. Se registran turnos (ingreso y salida) y horas trabajadas.
- **Reportes**: ventas por período, por producto, por mozo.
- **Ajustes**: datos del negocio, moneda, datos fiscales, carta QR, comanderas, suscripción.

**App de mozos (celular)** — se entra desde gestiva.site/mozo con el email del restaurante + el PIN del mozo. Toman pedidos por mesa, ven su panel y marcan ingreso/salida. Se puede instalar como app.

**Pantalla de cocina (KDS)** — gestiva.site/cocina. Muestra las comandas pendientes para que la cocina las vea en tiempo real.

**Comanderas (impresoras)** — para imprimir comandas hay que instalar la Estación de Impresión en la PC fija del local (Ajustes → Comandera → Instalar). Esa PC busca la impresora en la red (normalmente puerto 9100) e imprime automáticamente. Se puede separar cocina y barra en impresoras distintas.

**Carta QR** — se genera un QR para las mesas. El comensal lo escanea y ve la carta. Puede ser la carta de productos cargados o un PDF subido.

**Facturación electrónica (ARCA, ex-AFIP)** — cada restaurante factura con SU CUIT. Hay que cargar los datos fiscales (CUIT, razón social, domicilio, punto de venta, condición frente al IVA) y subir el certificado de ARCA desde Ajustes → Facturación. El comprobante sale con CAE y QR oficial.

**Suscripción** — planes Start ($11.000), Pro ($20.000) y Full ($34.000) por mes. El primer mes es gratis dejando la tarjeta; después se cobra automático por MercadoPago y se puede cancelar cuando sea.

**Instalar Gestiva** — se puede instalar como aplicación (queda el ícono en el escritorio o el celular). En Chrome/Edge aparece el botón Instalar; en iPhone es Compartir → Agregar a inicio.

## Cómo respondés

- En español rioplatense (vos, no tú). Cálido, directo y corto.
- Si la pregunta es sobre CÓMO hacer algo en Gestiva: dale los pasos concretos, nombrando las secciones tal cual aparecen ("Ajustes → Comandera").
- Si la pregunta es sobre SU NEGOCIO: usá los datos reales que te paso abajo. Citá números concretos.
- Si te preguntan algo que Gestiva no hace todavía (por ejemplo control de insumos por receta, proveedores o compras), decilo con honestidad y ofrecé la mejor alternativa con lo que sí hay. No inventes funciones.
- Si no tenés el dato, decí que no lo tenés. Nunca inventes cifras.
- Nada de markdown pesado ni títulos grandes: respuestas de 2 a 6 líneas, y listas cortas solo si ayudan.
- Si el tema es de plata o impuestos, recordá que no reemplazás a un contador.`;

// ============================================================
//  Resumen de los datos del negocio (lo que hace útil al asistente)
// ============================================================
async function contextoDelNegocio(q, tenant) {
  const id = tenant.id;
  const num = (r, k = 'n') => (r.rows[0] && r.rows[0][k] != null ? r.rows[0][k] : 0);
  // Si una consulta falla no tumbamos el asistente, pero lo dejamos en el log:
  // un dato en cero por error es peor que un error visible.
  const fallidas = [];
  const safe = async (sql, params) => {
    try { return await q(sql, params); }
    catch (e) {
      fallidas.push(e.message);
      console.error('[asistente] consulta de contexto falló:', e.message);
      return { rows: [], _fallo: true };
    }
  };

  const [prod, mesas, mozos, hoy, mes, topProd, sinStock, caja, clientes] = await Promise.all([
    safe('SELECT count(*)::int AS n FROM products WHERE tenant_id=$1', [id]),
    safe('SELECT count(*)::int AS n FROM tables WHERE tenant_id=$1', [id]),
    safe('SELECT count(*)::int AS n FROM waiters WHERE tenant_id=$1', [id]),
    // closed_at = cuando se cobró la venta (es lo que usan los reportes)
    safe(`SELECT count(*)::int AS n, COALESCE(sum(total),0)::float AS total
          FROM orders WHERE tenant_id=$1 AND closed_at >= date_trunc('day', now())`, [id]),
    safe(`SELECT count(*)::int AS n, COALESCE(sum(total),0)::float AS total
          FROM orders WHERE tenant_id=$1 AND closed_at >= now() - interval '30 days'`, [id]),
    // Los items se guardan como JSON dentro de la venta; contamos por nombre para
    // no depender de que el id del producto siga existiendo.
    safe(`SELECT it->>'name' AS name, count(*)::int AS veces
          FROM orders o
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) it
          WHERE o.tenant_id=$1 AND o.closed_at >= now() - interval '30 days'
            AND it->>'name' IS NOT NULL
          GROUP BY it->>'name' ORDER BY veces DESC LIMIT 5`, [id]),
    safe(`SELECT name, stock FROM products
          WHERE tenant_id=$1 AND stock IS NOT NULL AND low_stock_alert IS NOT NULL
            AND stock <= low_stock_alert ORDER BY stock ASC LIMIT 5`, [id]),
    safe('SELECT * FROM current_cash WHERE tenant_id=$1 LIMIT 1', [id]),
    safe('SELECT count(*)::int AS n FROM customers WHERE tenant_id=$1', [id]),
  ]);

  const money = (v) => '$' + Math.round(v || 0).toLocaleString('es-AR');
  const lineas = [
    `Restaurante: ${tenant.restaurant_name}`,
    `Plan: ${tenant.plan || 'pro'} · estado: ${tenant.subscription_status}`,
    `Cargados: ${num(prod)} productos, ${num(mesas)} mesas, ${num(mozos)} mozos, ${num(clientes)} clientes`,
    `Hoy: ${num(hoy)} ventas por ${money(hoy.rows[0]?.total)}`,
    `Últimos 30 días: ${num(mes)} ventas por ${money(mes.rows[0]?.total)}`,
  ];
  if (topProd.rows.length) {
    lineas.push('Más vendidos (30 días): ' + topProd.rows.map(r => `${r.name} (${r.veces})`).join(', '));
  }
  if (sinStock.rows.length) {
    lineas.push('Stock bajo: ' + sinStock.rows.map(r => `${r.name} (quedan ${r.stock})`).join(', '));
  }
  const c = caja.rows[0];
  lineas.push(c ? `Caja: abierta` : `Caja: cerrada o sin abrir hoy`);

  // Si algo no se pudo leer, se lo avisamos al asistente para que no afirme
  // cifras que en realidad no tiene.
  if (fallidas.length) {
    lineas.push(`ATENCIÓN: no se pudieron leer algunos datos (${fallidas.length} consultas fallaron). No afirmes cifras: decile al usuario que no pudiste leer sus datos en este momento.`);
  }

  return lineas.join('\n');
}

// ============================================================
//  Consulta principal
// ============================================================
async function preguntar({ q, tenant, mensajes }) {
  if (!client) return { ok: false, error: 'asistente_no_configurado' };

  const contexto = await contextoDelNegocio(q, tenant);

  // El manual va primero y con cache: se cobra ~10% en cada pregunta siguiente.
  const system = [
    { type: 'text', text: MANUAL, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `## Datos actuales de este negocio\n${contexto}\n\nHoy es ${new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.` },
  ];

  const historial = (mensajes || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .slice(-10)     // últimas 10 para acotar el costo
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 4000) }));

  if (!historial.length || historial[0].role !== 'user') {
    return { ok: false, error: 'sin_pregunta' };
  }

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system,
    messages: historial,
  });

  if (resp.stop_reason === 'refusal') {
    return { ok: true, texto: 'Perdón, con esa no puedo ayudarte. ¿Probamos con otra consulta sobre tu local?' };
  }

  const texto = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return {
    ok: true,
    texto: texto || 'No pude generar una respuesta. ¿Me lo preguntás de otra forma?',
    uso: {
      entrada: resp.usage.input_tokens,
      cacheLeido: resp.usage.cache_read_input_tokens || 0,
      salida: resp.usage.output_tokens,
    },
  };
}

module.exports = { preguntar, enabled };
