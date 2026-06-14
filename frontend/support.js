/* ============================================================
   Gestiva — Botón de soporte flotante
   Aparece en todas las páginas del negocio (lo inyecta gestiva-config.js,
   que lo excluye del menú QR público que ven los comensales).
   Centraliza el contacto: cualquiera con dudas escribe a este correo.
   ============================================================ */
(function () {
  'use strict';
  if (window.__gvSupportLoaded) return;
  window.__gvSupportLoaded = true;

  var EMAIL = 'somosgestiva@gmail.com';
  var SUBJECT = 'Soporte Gestiva';

  var css = ''
    + '.gv-sup-btn{position:fixed;bottom:20px;right:20px;z-index:150;display:flex;align-items:center;gap:8px;'
    + 'background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;border:none;border-radius:999px;padding:11px 16px;'
    + 'font-family:Inter,system-ui,-apple-system,sans-serif;font-weight:700;font-size:14px;cursor:pointer;'
    + 'box-shadow:0 8px 22px rgba(234,88,12,.4);transition:transform .15s,box-shadow .15s}'
    + '.gv-sup-btn:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(234,88,12,.5)}'
    + '.gv-sup-btn svg{width:18px;height:18px;flex:none}'
    + '.gv-sup-pop{position:fixed;bottom:74px;right:20px;z-index:151;width:300px;max-width:calc(100vw - 40px);'
    + 'background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 20px 50px rgba(15,23,42,.22);'
    + 'padding:18px;font-family:Inter,system-ui,-apple-system,sans-serif;color:#0f172a;display:none}'
    + '.gv-sup-pop.open{display:block}'
    + '.gv-sup-pop h4{margin:0 0 6px;font-size:16px;font-weight:800}'
    + '.gv-sup-pop p{margin:0 0 12px;font-size:13px;color:#475569;line-height:1.5}'
    + '.gv-sup-mail{display:block;background:#fff7ed;border:1px dashed #f97316;border-radius:10px;padding:9px 12px;'
    + 'font-size:13.5px;font-weight:700;color:#0f172a;text-align:center;word-break:break-all;margin-bottom:12px}'
    + '.gv-sup-actions{display:flex;gap:8px}'
    + '.gv-sup-actions a,.gv-sup-actions button{flex:1;text-align:center;border-radius:10px;padding:10px;font-size:13px;'
    + 'font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;border:none}'
    + '.gv-sup-write{background:linear-gradient(135deg,#f97316,#ea580c);color:#fff}'
    + '.gv-sup-copy{background:#fff;border:1px solid #e2e8f0;color:#0f172a}'
    + '.gv-sup-alt{display:block;text-align:center;margin-top:10px;font-size:12px;color:#64748b;text-decoration:none}'
    + '.gv-sup-alt:hover{color:#ea580c;text-decoration:underline}';

  function build() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.className = 'gv-sup-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Soporte');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 '
      + '8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 '
      + '8.48 0 0 1 8 8v.5z"/></svg><span>Soporte</span>';

    var GMAIL = 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(EMAIL) + '&su=' + encodeURIComponent(SUBJECT);
    var MAILTO = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent(SUBJECT);

    var pop = document.createElement('div');
    pop.className = 'gv-sup-pop';
    pop.innerHTML = '<h4>¿Necesitás ayuda?</h4>'
      + '<p>Cualquier duda, consulta o problema, escribinos y te respondemos a la brevedad.</p>'
      + '<span class="gv-sup-mail">' + EMAIL + '</span>'
      + '<div class="gv-sup-actions">'
      + '<a class="gv-sup-write" href="' + GMAIL + '" target="_blank" rel="noopener">Escribir por Gmail</a>'
      + '<button class="gv-sup-copy" type="button">Copiar email</button>'
      + '</div>'
      + '<a class="gv-sup-alt" href="' + MAILTO + '">¿Usás otra app de correo? Abrila acá</a>';

    document.body.appendChild(pop);
    document.body.appendChild(btn);

    btn.addEventListener('click', function (e) { e.stopPropagation(); pop.classList.toggle('open'); });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { pop.classList.remove('open'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') pop.classList.remove('open'); });

    pop.querySelector('.gv-sup-copy').addEventListener('click', function () {
      var b = this;
      var done = function () { b.textContent = '¡Copiado!'; setTimeout(function () { b.textContent = 'Copiar email'; }, 1300); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(EMAIL).then(done).catch(function () { window.prompt('Copiá el email:', EMAIL); });
      } else {
        window.prompt('Copiá el email:', EMAIL);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
