// Mailer de Gestiva — envía emails vía Resend (https://resend.com).
// Si RESEND_API_KEY no está configurado, NO falla: solo loguea (degradación elegante).
// Variables de entorno:
//   RESEND_API_KEY  → API key de Resend (empieza con 're_...')
//   MAIL_FROM       → remitente. Default: 'Gestiva <onboarding@resend.dev>'
//   ADMIN_EMAIL     → destinatario de notificaciones al dueño
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Gestiva <onboarding@resend.dev>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[mail] RESEND_API_KEY no configurado — email NO enviado:', subject, '->', to);
    return { sent: false, reason: 'no_api_key' };
  }
  if (!to) {
    console.warn('[mail] sin destinatario para:', subject);
    return { sent: false, reason: 'no_recipient' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html })
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

// Envoltorio de marca para los emails
function wrap(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f8fafc;font-family:Inter,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:560px;margin:0 auto;padding:24px;">
      <div style="background:#fff;border-radius:18px;padding:32px;border:1px solid #e2e8f0;">
        <div style="font-size:20px;font-weight:800;color:#ea580c;margin-bottom:20px;">Gestiva</div>
        <h1 style="font-size:20px;margin:0 0 16px;">${title}</h1>
        ${bodyHtml}
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px;">Gestiva · Sistema de administración para gastronomía</p>
    </div>
  </body></html>`;
}

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
  ].map(([k, v]) => `<tr><td style="padding:8px 0;color:#475569;font-size:13px;width:160px;vertical-align:top;">${k}</td><td style="padding:8px 0;font-size:14px;font-weight:600;">${String(v).replace(/</g,'&lt;')}</td></tr>`).join('');
  const html = wrap('Nueva solicitud de vendedor', `
    <p style="color:#475569;font-size:14px;line-height:1.55;">Una persona quiere sumarse como vendedor de Gestiva. Revisá la solicitud y aprobala o rechazala desde tu panel.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}</table>
    <a href="${(process.env.APP_URL||'https://gestiva.site')}/admin" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;font-size:14px;">Ir a mi panel de dueño →</a>
  `);
  return sendEmail({ to: ADMIN_EMAIL, subject: `Nueva solicitud de vendedor: ${vendor.name}`, html });
}

// Avisa al vendedor que fue aprobado
async function notifyVendorApproved(vendor) {
  const link = `${(process.env.APP_URL||'https://gestiva.site')}/signup.html?ref=${encodeURIComponent(vendor.ref_code)}`;
  const html = wrap('¡Tu solicitud fue aprobada! 🎉', `
    <p style="color:#475569;font-size:14px;line-height:1.55;">Hola ${vendor.name}, ya sos vendedor oficial de Gestiva. Tu link para captar restaurantes es:</p>
    <div style="background:#fff7ed;border:1px solid #ffedd5;border-radius:10px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;margin:14px 0;">${link}</div>
    <a href="${(process.env.APP_URL||'https://gestiva.site')}/vendedor" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;font-size:14px;">Entrar a mi panel →</a>
  `);
  return sendEmail({ to: vendor.email, subject: '¡Bienvenido al equipo de vendedores de Gestiva!', html });
}

// Avisa al vendedor que fue rechazado
async function notifyVendorRejected(vendor) {
  const html = wrap('Sobre tu solicitud', `
    <p style="color:#475569;font-size:14px;line-height:1.55;">Hola ${vendor.name}, gracias por tu interés en ser vendedor de Gestiva. Por ahora no pudimos aprobar tu solicitud. Si creés que es un error, respondé este correo.</p>
  `);
  return sendEmail({ to: vendor.email, subject: 'Tu solicitud de vendedor en Gestiva', html });
}

module.exports = { sendEmail, notifyNewVendorApplication, notifyVendorApproved, notifyVendorRejected, ADMIN_EMAIL };
