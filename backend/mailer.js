// Mailer de Gestiva — envía emails vía Resend (https://resend.com).
// Si RESEND_API_KEY no está configurado, NO falla: solo loguea (degradación elegante).
// Variables de entorno:
//   RESEND_API_KEY  → API key de Resend (empieza con 're_...')
//   MAIL_FROM       → remitente. Ideal: 'Gestiva <hola@gestiva.site>' (dominio verificado)
//   MAIL_REPLY_TO   → a dónde llegan las respuestas del cliente (ej: somosgestiva@gmail.com)
//   ADMIN_EMAIL     → destinatario de notificaciones al dueño de Gestiva
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Gestiva <onboarding@resend.dev>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || 'somosgestiva@gmail.com';
const APP_URL = process.env.APP_URL || 'https://www.gestiva.site';

async function sendEmail({ to, subject, html, replyTo }) {
  if (!RESEND_API_KEY) {
    console.warn('[mail] RESEND_API_KEY no configurado — email NO enviado:', subject, '->', to);
    return { sent: false, reason: 'no_api_key' };
  }
  if (!to) {
    console.warn('[mail] sin destinatario para:', subject);
    return { sent: false, reason: 'no_recipient' };
  }
  try {
    const body = { from: MAIL_FROM, to: [to], subject, html };
    const rt = replyTo || MAIL_REPLY_TO;
    if (rt) body.reply_to = [rt];
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[mail] error Resend:', r.status, JSON.stringify(data));
      return { sent: false, reason: 'resend_error', detail: data };
    }
    return { sent: true, id: data.id };
  } catch (e) {
    console.error('[mail] excepción:', e.message);
    return { sent: false, reason: 'exception', detail: e.message };
  }
}

const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const fecha = (d) => new Date(d || Date.now()).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });

// Botón principal (naranja de marca)
function button(label, href) {
  return `<a href="${href}" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:13px 26px;border-radius:11px;font-weight:700;font-size:15px;">${label}</a>`;
}

// Envoltorio de marca. El logo se sirve desde el sitio (los clientes de correo
// no renderizan SVG, por eso usamos el PNG del ícono).
function wrap(title, bodyHtml, opts = {}) {
  const preheader = opts.preheader || '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#f8fafc;font-family:Inter,-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;">
    ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>` : ''}
    <div style="max-width:560px;margin:0 auto;padding:24px;">
      <div style="text-align:center;margin-bottom:18px;">
        <img src="${APP_URL}/assets/icon-192.png" width="52" height="52" alt="Gestiva"
             style="width:52px;height:52px;border-radius:14px;display:inline-block;">
      </div>
      <div style="background:#fff;border-radius:18px;padding:32px;border:1px solid #e2e8f0;">
        <h1 style="font-size:21px;margin:0 0 16px;line-height:1.3;">${title}</h1>
        ${bodyHtml}
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px;line-height:1.6;">
        Gestiva · Sistema de administración para gastronomía<br>
        ¿Necesitás ayuda? Respondé este correo y te contestamos.
      </p>
    </div>
  </body></html>`;
}

const P = 'color:#475569;font-size:14px;line-height:1.6;margin:0 0 14px;';

// ============================================================
//                  EMAILS AL DUEÑO DEL RESTAURANTE
// ============================================================

// 1) Bienvenida (+ verificación del correo si hace falta).
// Verificación "suave": puede usar Gestiva igual. Las cuentas creadas con Google
// llegan sin verifyUrl porque Google ya confirmó el correo.
async function sendWelcomeVerify(tenant, verifyUrl) {
  const nombre = tenant.owner_name || tenant.restaurant_name || '';
  const bloqueVerificacion = verifyUrl ? `
    <p style="${P}">Para asegurar tu cuenta y poder recuperar el acceso si olvidás la contraseña, confirmá tu correo:</p>
    <p style="margin:22px 0;">${button('Verificar mi correo', verifyUrl)}</p>
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0 0 18px;">Si el botón no funciona, copiá y pegá este link en tu navegador:<br>
      <span style="color:#64748b;word-break:break-all;">${verifyUrl}</span><br>El link vence en 7 días.</p>` : '';
  const html = wrap('¡Bienvenido a Gestiva! 🟠', `
    <p style="${P}">${nombre ? `Hola ${esc(nombre)}, g` : 'G'}racias por sumarte. Ya podés empezar a usar Gestiva para controlar mesas, caja, cocina y reportes en tiempo real.</p>
    ${bloqueVerificacion}
    <div style="${verifyUrl ? 'border-top:1px solid #e2e8f0;padding-top:18px;' : ''}">
      <p style="${P}"><strong>Primeros pasos</strong></p>
      <p style="${P}">1. Cargá tus productos y precios<br>2. Configurá tus mesas<br>3. Sumá a tus mozos con su PIN</p>
      <p style="margin:6px 0 0;">${button('Entrar a mi panel', APP_URL + '/app.html')}</p>
    </div>
  `, { preheader: verifyUrl ? 'Confirmá tu correo y empezá a usar Gestiva.' : 'Tu cuenta de Gestiva ya está lista.' });
  return sendEmail({
    to: tenant.email,
    subject: verifyUrl ? '¡Bienvenido a Gestiva! Confirmá tu correo' : '¡Bienvenido a Gestiva!',
    html
  });
}

// Reenvío del link de verificación (desde el panel)
async function sendVerifyEmail(tenant, verifyUrl) {
  const html = wrap('Confirmá tu correo', `
    <p style="${P}">Confirmá que este correo es tuyo para asegurar tu cuenta de Gestiva.</p>
    <p style="margin:22px 0;">${button('Verificar mi correo', verifyUrl)}</p>
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0;">Si el botón no funciona, copiá este link:<br>
      <span style="color:#64748b;word-break:break-all;">${verifyUrl}</span><br>El link vence en 7 días.</p>
  `, { preheader: 'Tu link para verificar el correo.' });
  return sendEmail({ to: tenant.email, subject: 'Confirmá tu correo · Gestiva', html });
}

// 2) Comprobante de pago del servicio
async function sendPaymentReceipt(tenant, pay = {}) {
  const rows = [
    ['Restaurante', tenant.restaurant_name],
    ['Plan', pay.planName || '—'],
    ['Importe', money(pay.amount)],
    ['Fecha', fecha(pay.date)],
    ['Medio de pago', 'MercadoPago'],
    ['N° de operación', pay.paymentId || '—'],
    ['Próximo cobro', pay.nextDate ? fecha(pay.nextDate) : '—'],
  ].map(([k, v]) => `<tr>
      <td style="padding:9px 0;color:#475569;font-size:13px;">${k}</td>
      <td style="padding:9px 0;font-size:14px;font-weight:600;text-align:right;">${esc(v)}</td>
    </tr>`).join('');
  const html = wrap('Comprobante de pago', `
    <p style="${P}">Recibimos tu pago. ¡Gracias por seguir usando Gestiva!</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px 16px;margin:0 0 18px;">
      <span style="color:#047857;font-size:14px;font-weight:700;">✓ Pago acreditado — ${money(pay.amount)}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">${rows}</table>
    <p style="margin:0 0 16px;">${button('Ver mi suscripción', APP_URL + '/checkout.html')}</p>
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0;">Este comprobante es del servicio Gestiva. No reemplaza la factura fiscal de tus ventas.</p>
  `, { preheader: `Pago acreditado por ${money(pay.amount)}.` });
  return sendEmail({ to: tenant.email, subject: `Comprobante de pago · Gestiva ${money(pay.amount)}`, html });
}

// 3) Aviso de inicio de sesión desde un dispositivo nuevo (no bloquea el ingreso)
async function sendNewDeviceAlert(tenant, info = {}) {
  const rows = [
    ['Dispositivo', info.label || 'Desconocido'],
    ['Fecha', new Date(info.date || Date.now()).toLocaleString('es-AR')],
    ['IP aproximada', info.ip || '—'],
  ].map(([k, v]) => `<tr>
      <td style="padding:8px 0;color:#475569;font-size:13px;">${k}</td>
      <td style="padding:8px 0;font-size:14px;font-weight:600;text-align:right;">${esc(v)}</td>
    </tr>`).join('');
  const html = wrap('Nuevo inicio de sesión en tu cuenta', `
    <p style="${P}">Detectamos un ingreso a tu cuenta de Gestiva desde un dispositivo que no habíamos visto antes.</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 18px;">${rows}</table>
    <div style="background:#fff7ed;border:1px solid #ffedd5;border-radius:12px;padding:14px 16px;margin:0 0 18px;">
      <p style="color:#9a3412;font-size:13px;line-height:1.6;margin:0;"><strong>¿Fuiste vos?</strong> Entonces no tenés que hacer nada.<br>
      <strong>¿No fuiste vos?</strong> Cambiá tu contraseña ahora y avisanos respondiendo este correo.</p>
    </div>
    <p style="margin:0;">${button('Revisar mi cuenta', APP_URL + '/app.html')}</p>
  `, { preheader: 'Ingreso desde un dispositivo nuevo.' });
  return sendEmail({ to: tenant.email, subject: '🔐 Nuevo inicio de sesión en tu cuenta de Gestiva', html });
}

// 4) Informativo: arrancó el mes gratis (dejó la tarjeta)
async function sendTrialStarted(tenant, info = {}) {
  const html = wrap('¡Arrancó tu mes gratis! 🎉', `
    <p style="${P}">Listo${tenant.owner_name ? ' ' + esc(tenant.owner_name) : ''}, tu cuenta de <strong>${esc(tenant.restaurant_name)}</strong> ya tiene acceso completo a Gestiva.</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;margin:0 0 18px;">
      <p style="color:#047857;font-size:14px;line-height:1.6;margin:0;">
        <strong>Gratis hasta el ${fecha(info.endsAt)}</strong><br>
        Después: plan ${esc(info.planName || '')} ${info.amount ? money(info.amount) + '/mes' : ''} · se cobra automático<br>
        Cancelás cuando quieras, sin permanencia.
      </p>
    </div>
    <p style="margin:0;">${button('Entrar a mi panel', APP_URL + '/app.html')}</p>
  `, { preheader: 'Tu mes gratis ya está activo.' });
  return sendEmail({ to: tenant.email, subject: '¡Tu mes gratis en Gestiva ya está activo!', html });
}

// 5) Informativo: la suscripción se va a vencer / está en gracia
async function sendPaymentFailed(tenant, info = {}) {
  const html = wrap('No pudimos cobrar tu suscripción', `
    <p style="${P}">Hola${tenant.owner_name ? ' ' + esc(tenant.owner_name) : ''}, intentamos cobrar la suscripción de <strong>${esc(tenant.restaurant_name)}</strong> y la tarjeta la rechazó.</p>
    <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;padding:14px 16px;margin:0 0 18px;">
      <p style="color:#b45309;font-size:13px;line-height:1.6;margin:0;">Tenés acceso hasta el <strong>${fecha(info.graceEndsAt)}</strong>. Actualizá tu medio de pago para no perder el servicio.</p>
    </div>
    <p style="margin:0;">${button('Actualizar mi pago', APP_URL + '/checkout.html')}</p>
  `, { preheader: 'Actualizá tu medio de pago para no perder el acceso.' });
  return sendEmail({ to: tenant.email, subject: 'Problema con el cobro de tu suscripción · Gestiva', html });
}

// ============================================================
//                    EMAILS DE VENDEDORES
// ============================================================

// Notifica al dueño que llegó una solicitud de vendedor
async function notifyNewVendorApplication(vendor) {
  const app = vendor.application || {};
  const rows = [
    ['Nombre', vendor.name],
    ['Email', vendor.email],
    ['Teléfono', vendor.phone || '—'],
    ['Zona / Ciudad', app.zona || '—'],
    ['Experiencia en ventas', app.experiencia || '—'],
    ['¿Cómo piensa vender?', app.comoVende || '—'],
    ['Comentarios', app.comentarios || '—'],
  ].map(([k, v]) => `<tr><td style="padding:8px 0;color:#475569;font-size:13px;width:160px;vertical-align:top;">${k}</td><td style="padding:8px 0;font-size:14px;font-weight:600;">${esc(v)}</td></tr>`).join('');
  const html = wrap('Nueva solicitud de vendedor', `
    <p style="${P}">Una persona quiere sumarse como vendedor de Gestiva. Revisá la solicitud y aprobala o rechazala desde tu panel.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}</table>
    ${button('Ir a mi panel de dueño →', APP_URL + '/admin')}
  `);
  return sendEmail({ to: ADMIN_EMAIL, subject: `Nueva solicitud de vendedor: ${vendor.name}`, html });
}

// Avisa al vendedor que fue aprobado
async function notifyVendorApproved(vendor) {
  const link = `${APP_URL}/signup.html?ref=${encodeURIComponent(vendor.ref_code)}`;
  const html = wrap('¡Tu solicitud fue aprobada! 🎉', `
    <p style="${P}">Hola ${esc(vendor.name)}, ya sos vendedor oficial de Gestiva. Tu link para captar restaurantes es:</p>
    <div style="background:#fff7ed;border:1px solid #ffedd5;border-radius:10px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;margin:14px 0;">${link}</div>
    ${button('Entrar a mi panel →', APP_URL + '/vendedor')}
  `);
  return sendEmail({ to: vendor.email, subject: '¡Bienvenido al equipo de vendedores de Gestiva!', html });
}

// Avisa al vendedor que fue rechazado
async function notifyVendorRejected(vendor) {
  const html = wrap('Sobre tu solicitud', `
    <p style="${P}">Hola ${esc(vendor.name)}, gracias por tu interés en ser vendedor de Gestiva. Por ahora no pudimos aprobar tu solicitud. Si creés que es un error, respondé este correo.</p>
  `);
  return sendEmail({ to: vendor.email, subject: 'Tu solicitud de vendedor en Gestiva', html });
}

module.exports = {
  sendEmail,
  sendWelcomeVerify, sendVerifyEmail,
  sendPaymentReceipt, sendNewDeviceAlert,
  sendTrialStarted, sendPaymentFailed,
  notifyNewVendorApplication, notifyVendorApproved, notifyVendorRejected,
  ADMIN_EMAIL
};
