/* ============================================================
   Gestiva — instalación de la app (PWA)
   Uso desde cualquier página:
     <script src="install-app.js" defer></script>
     GestivaInstall.onChange(state => { ... })
     GestivaInstall.prompt()            // instala (Android/PC) o guía (iPhone)

   Android/Chrome/Edge: diálogo nativo de instalación, un toque y listo.

   iPhone/iPad: Apple NO permite que una web dispare la instalación. No existe
   equivalente a beforeinstallprompt en Safari. El único camino real es
   Compartir → "Agregar a inicio". Por eso acá mostramos una guía visual con el
   ícono real de Compartir en vez de un alert del sistema.

   El caso que más falla en la práctica: el dueño manda el link por WhatsApp o
   Instagram, el mozo lo toca y se abre en el navegador interno de esa app,
   donde "Agregar a inicio" directamente no existe. Ahí lo primero es sacarlo
   a Safari, así que lo detectamos y lo explicamos aparte.
   ============================================================ */
(function () {
  var deferred = null;
  var listeners = [];

  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) ||
    // iPadOS 13+ se declara como Mac con pantalla táctil
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  // Navegadores dentro de otra app (Instagram, Facebook, WhatsApp, TikTok...).
  // En iOS no ofrecen "Agregar a inicio": hay que salir a Safari sí o sí.
  var isInApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|LinkedInApp|Snapchat|Pinterest|TikTok|BytedanceWebview|musical_ly|WhatsApp/i.test(ua);
  // En iOS, Chrome/Firefox/Edge son Safari por dentro pero con otra interfaz:
  // el menú Compartir no es el mismo y confunde al mozo.
  var iosOtherBrowser = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/i.test(ua);

  function isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  function state() {
    return {
      available: !!deferred,
      installed: isInstalled(),
      ios: isIOS,
      inApp: isInApp,
      needsSafari: isIOS && (isInApp || iosOtherBrowser)
    };
  }

  function notify() {
    var s = state();
    listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          // evitamos el mini-infobar y lo disparamos nosotros
    deferred = e;
    notify();
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
    closeSheet();
    notify();
  });

  // ---------------------------------------------------------
  //   Guía visual (reemplaza al alert del sistema)
  // ---------------------------------------------------------
  var sheetEl = null;

  function injectStyles() {
    if (document.getElementById('gv-install-css')) return;
    var css = document.createElement('style');
    css.id = 'gv-install-css';
    css.textContent = [
      '.gv-ins-back{position:fixed;inset:0;background:rgba(15,23,42,.62);z-index:99998;opacity:0;transition:opacity .22s ease;backdrop-filter:blur(2px)}',
      '.gv-ins-back.on{opacity:1}',
      '.gv-ins{position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#fff;border-radius:22px 22px 0 0;padding:8px 20px calc(24px + env(safe-area-inset-bottom));',
      'box-shadow:0 -12px 44px rgba(15,23,42,.28);transform:translateY(102%);transition:transform .3s cubic-bezier(.22,1,.36,1);max-height:88vh;overflow-y:auto;',
      'font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;max-width:520px;margin:0 auto}',
      '.gv-ins.on{transform:translateY(0)}',
      '.gv-ins-grip{width:40px;height:4px;border-radius:99px;background:#cbd5e1;margin:8px auto 16px}',
      '.gv-ins h3{margin:0 0 6px;font-size:20px;font-weight:800;letter-spacing:-.01em}',
      '.gv-ins .gv-sub{margin:0 0 20px;font-size:14.5px;line-height:1.5;color:#64748b}',
      '.gv-step{display:flex;gap:13px;align-items:flex-start;margin-bottom:16px}',
      '.gv-num{flex:none;width:27px;height:27px;border-radius:50%;background:#f97316;color:#fff;font-weight:800;font-size:13.5px;display:flex;align-items:center;justify-content:center;margin-top:1px}',
      '.gv-step-tx{font-size:15px;line-height:1.5;padding-top:2px}',
      '.gv-step-tx b{font-weight:700}',
      '.gv-share{display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;border-radius:7px;background:#eff6ff;vertical-align:-8px;margin:0 2px}',
      '.gv-share svg{width:15px;height:15px;display:block}',
      '.gv-plus{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;border:1.5px solid #94a3b8;color:#475569;font-weight:700;font-size:15px;vertical-align:-5px;margin:0 2px;line-height:1}',
      '.gv-ins-btn{width:100%;padding:15px;border:0;border-radius:14px;background:#f97316;color:#fff;font-size:16px;font-weight:800;margin-top:6px;font-family:inherit}',
      '.gv-ins-btn.sec{background:#f1f5f9;color:#334155;margin-top:10px}',
      '.gv-warn{background:#fff7ed;border:1px solid #fed7aa;border-radius:13px;padding:14px 15px;margin-bottom:18px;font-size:14px;line-height:1.5;color:#9a3412}',
      '.gv-warn b{color:#7c2d12}',
      '.gv-url{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:11px 13px;font-size:13px;color:#475569;word-break:break-all;margin:14px 0 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '@media (prefers-reduced-motion:reduce){.gv-ins,.gv-ins-back{transition:none}}'
    ].join('');
    document.head.appendChild(css);
  }

  // Ícono real de Compartir de iOS (cuadrado con la flecha hacia arriba)
  var SHARE_SVG =
    '<span class="gv-share"><svg viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/>' +
    '<path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/></svg></span>';

  function closeSheet() {
    if (!sheetEl) return;
    var el = sheetEl, back = el._back;
    el.classList.remove('on');
    if (back) back.classList.remove('on');
    sheetEl = null;
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (back && back.parentNode) back.parentNode.removeChild(back);
    }, 300);
  }

  function buildSheet(html) {
    injectStyles();
    closeSheet();
    var back = document.createElement('div');
    back.className = 'gv-ins-back';
    back.onclick = closeSheet;
    var el = document.createElement('div');
    el.className = 'gv-ins';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = '<div class="gv-ins-grip"></div>' + html;
    el._back = back;
    document.body.appendChild(back);
    document.body.appendChild(el);
    sheetEl = el;
    // dos frames para que la animación arranque desde abajo
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { back.classList.add('on'); el.classList.add('on'); });
    });
    return el;
  }

  // Paso previo obligatorio: si está en el navegador de Instagram/WhatsApp,
  // "Agregar a inicio" no existe. Primero hay que llegar a Safari.
  function sheetAbrirEnSafari() {
    var url = location.href;
    var el = buildSheet(
      '<h3>Abrilo en Safari</h3>' +
      '<p class="gv-sub">Estás viendo Gestiva dentro de otra aplicación. Para poder instalarla en el iPhone hay que abrirla en Safari.</p>' +
      '<div class="gv-warn">Es un paso de Apple, no de Gestiva: solo Safari puede agregar apps a la pantalla de inicio.</div>' +
      '<div class="gv-step"><span class="gv-num">1</span><span class="gv-step-tx">Tocá el botón <b>···</b> o <b>' +
        (isInApp ? 'el ícono del navegador' : 'Compartir') + '</b> arriba a la derecha.</span></div>' +
      '<div class="gv-step"><span class="gv-num">2</span><span class="gv-step-tx">Elegí <b>Abrir en Safari</b>.</span></div>' +
      '<div class="gv-step"><span class="gv-num">3</span><span class="gv-step-tx">Ya en Safari, volvé a tocar <b>Instalar la app</b>.</span></div>' +
      '<div class="gv-url">' + url.replace(/[<>&]/g, '') + '</div>' +
      '<button class="gv-ins-btn" data-gv="copy">Copiar el link</button>' +
      '<button class="gv-ins-btn sec" data-gv="close">Cerrar</button>'
    );
    el.querySelector('[data-gv="close"]').onclick = closeSheet;
    var copyBtn = el.querySelector('[data-gv="copy"]');
    copyBtn.onclick = function () {
      var ok = function () { copyBtn.textContent = '¡Link copiado! Pegalo en Safari'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(ok, function () { fallbackCopy(url, ok); });
      } else { fallbackCopy(url, ok); }
    };
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {}
  }

  // La guía de verdad: Compartir → Agregar a inicio.
  function sheetAgregarAInicio() {
    var el = buildSheet(
      '<h3>Instalar Gestiva en tu iPhone</h3>' +
      '<p class="gv-sub">Son dos toques y queda el ícono en tu pantalla, como cualquier app.</p>' +
      '<div class="gv-step"><span class="gv-num">1</span><span class="gv-step-tx">Tocá ' + SHARE_SVG +
        ' <b>Compartir</b>, abajo en el centro de la pantalla.</span></div>' +
      '<div class="gv-step"><span class="gv-num">2</span><span class="gv-step-tx">Deslizá y elegí ' +
        '<span class="gv-plus">+</span> <b>Agregar a inicio</b>.</span></div>' +
      '<div class="gv-step"><span class="gv-num">3</span><span class="gv-step-tx">Confirmá con <b>Agregar</b> arriba a la derecha.</span></div>' +
      '<button class="gv-ins-btn" data-gv="close">Entendido</button>'
    );
    el.querySelector('[data-gv="close"]').onclick = closeSheet;
  }

  function showGuide() {
    if (isIOS && (isInApp || iosOtherBrowser)) { sheetAbrirEnSafari(); return 'safari'; }
    sheetAgregarAInicio();
    return 'ios';
  }

  var GestivaInstall = {
    get available() { return !!deferred; },
    get installed() { return isInstalled(); },
    get ios() { return isIOS; },
    get needsSafari() { return isIOS && (isInApp || iosOtherBrowser); },
    state: state,
    // Se puede ofrecer si hay prompt nativo, o si es iOS (guía),
    // siempre que la app no esté ya instalada.
    canOffer: function () { return !isInstalled() && (!!deferred || isIOS); },
    onChange: function (fn) { listeners.push(fn); fn(state()); },
    showGuide: showGuide,
    close: closeSheet,
    // Devuelve 'installed' | 'accepted' | 'dismissed' | 'ios' | 'safari' | 'unavailable'
    prompt: function () {
      if (isInstalled()) return Promise.resolve('installed');
      // iPhone: no hay instalación programática, mostramos la guía nosotros.
      if (isIOS) return Promise.resolve(showGuide());
      if (!deferred) return Promise.resolve('unavailable');
      deferred.prompt();
      return deferred.userChoice.then(function (choice) {
        deferred = null;
        notify();
        return choice && choice.outcome ? choice.outcome : 'dismissed';
      }).catch(function () { return 'dismissed'; });
    },
    help: function () {
      if (isIOS && (isInApp || iosOtherBrowser)) return 'Abrí Gestiva en Safari para poder instalarla.';
      if (isIOS) return 'En iPhone/iPad: tocá Compartir y elegí "Agregar a inicio".';
      return 'Tocá "Instalar" y Gestiva queda como aplicación en tu dispositivo.';
    }
  };

  window.GestivaInstall = GestivaInstall;
})();
