/* ============================================================
   Gestiva — instalación de la app (PWA)
   Uso desde cualquier página (cargarlo en el <head>, SIN defer, para no
   perderse el evento de instalación de Android):
     <script src="install-app.js"></script>
     GestivaInstall.onChange(state => { ... })
     GestivaInstall.prompt()     // Android/PC: instala; iPhone: muestra la guía

   Android (Chrome, Edge, Samsung): diálogo nativo "Instalar app" con un toque.
   Si el navegador todavía no lo ofreció, se espera un momento y, si no llega,
   se muestran los pasos del menú ⋮.

   iPhone: Apple NO permite que una web instale una app (no existe un
   beforeinstallprompt en iOS). El camino es "Agregar a inicio", y cambia
   según el navegador:
     - Safari de iOS 26 en adelante: ⋯ → Compartir → Agregar a inicio.
     - Safari anterior: Compartir → Agregar a inicio.
     - Chrome, Edge o Firefox (iOS 16.4+): Compartir en la barra de
       direcciones → Agregar a inicio. Antes los mandábamos a Safari sin
       necesidad: desde iOS 16.4 los otros navegadores también pueden.
     - Dentro de Instagram/Facebook/TikTok: hay que salir a Safari.
   Safari 26 congela la versión de iOS en el user agent: para saber si es
   iOS 26 se mira la versión de Safari ("Version/26").
   ============================================================ */
(function () {
  var deferred = null;
  var listeners = [];
  var esperandoPrompt = [];

  var ua = navigator.userAgent || '';
  // iPadOS 13+ se declara como Mac con pantalla táctil
  var isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isIOS = /iPhone|iPod/.test(ua) || isIPad;
  var isAndroid = /Android/i.test(ua);
  // Navegadores dentro de otra app: ahí no se puede instalar nada.
  // "; wv)" es el WebView de Android que usan Facebook, Instagram, etc.
  var isInApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|LinkedInApp|Snapchat|Pinterest|TikTok|BytedanceWebview|musical_ly/i.test(ua) ||
    (isAndroid && /; wv\)/.test(ua));

  function iosVersion() {
    var m = ua.match(/OS (\d+)_(\d+)/);
    return m ? parseFloat(m[1] + '.' + m[2]) : null;
  }
  function safariVersion() {
    var m = ua.match(/Version\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  // 'safari' | 'chrome' | 'edge' | 'firefox' | 'otro' (solo iOS)
  var iosBrowser = !isIOS ? null
    : /CriOS/.test(ua) ? 'chrome'
    : /EdgiOS/.test(ua) ? 'edge'
    : /FxiOS/.test(ua) ? 'firefox'
    : /OPiOS|YaBrowser|DuckDuckGo|GSA\//.test(ua) ? 'otro'
    : 'safari';
  // En iOS, fuera de Safari solo se puede agregar a inicio desde iOS 16.4.
  var iosTerceroViejo = isIOS && iosBrowser !== 'safari' && iosVersion() !== null && iosVersion() < 16.4;
  var needsSafari = isIOS && (isInApp || iosTerceroViejo || iosBrowser === 'otro');
  var needsChrome = isAndroid && isInApp;

  function isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.matchMedia('(display-mode: fullscreen)').matches ||
           window.navigator.standalone === true;
  }

  function state() {
    return {
      available: !!deferred,
      installed: isInstalled(),
      ios: isIOS,
      ipad: isIPad,
      android: isAndroid,
      inApp: isInApp,
      iosBrowser: iosBrowser,
      needsSafari: needsSafari,
      needsChrome: needsChrome
    };
  }

  function notify() {
    var s = state();
    listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          // evitamos el mini-infobar y lo disparamos nosotros
    deferred = e;
    var w = esperandoPrompt; esperandoPrompt = [];
    w.forEach(function (fn) { try { fn(e); } catch (x) {} });
    notify();
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
    closeSheet();
    notify();
    listeners.forEach(function (fn) { try { fn(Object.assign(state(), { justInstalled: true })); } catch (e) {} });
  });

  // ---------------------------------------------------------
  //   Guía visual
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
      'font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;max-width:520px;margin:0 auto;-webkit-overflow-scrolling:touch}',
      '.gv-ins.on{transform:translateY(0)}',
      '.gv-ins-grip{width:40px;height:4px;border-radius:99px;background:#cbd5e1;margin:8px auto 16px}',
      '.gv-ins h3{margin:0 0 6px;font-size:20px;font-weight:800;letter-spacing:-.01em}',
      '.gv-ins .gv-sub{margin:0 0 20px;font-size:14.5px;line-height:1.5;color:#64748b}',
      '.gv-step{display:flex;gap:13px;align-items:flex-start;margin-bottom:16px}',
      '.gv-num{flex:none;width:27px;height:27px;border-radius:50%;background:#f97316;color:#fff;font-weight:800;font-size:13.5px;display:flex;align-items:center;justify-content:center;margin-top:1px}',
      '.gv-step-tx{font-size:15px;line-height:1.55;padding-top:2px}',
      '.gv-step-tx b{font-weight:700}',
      '.gv-ico{display:inline-flex;align-items:center;justify-content:center;min-width:27px;height:27px;padding:0 4px;border-radius:7px;background:#eff6ff;vertical-align:-8px;margin:0 2px;color:#0a84ff;font-weight:900;font-size:16px;line-height:1}',
      '.gv-ico svg{width:15px;height:15px;display:block}',
      '.gv-plus{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;border:1.5px solid #94a3b8;color:#475569;font-weight:700;font-size:15px;vertical-align:-5px;margin:0 2px;line-height:1}',
      '.gv-ins-btn{width:100%;padding:15px;border:0;border-radius:14px;background:#f97316;color:#fff;font-size:16px;font-weight:800;margin-top:6px;font-family:inherit;cursor:pointer}',
      '.gv-ins-btn.sec{background:#f1f5f9;color:#334155;margin-top:10px}',
      '.gv-warn{background:#fff7ed;border:1px solid #fed7aa;border-radius:13px;padding:14px 15px;margin-bottom:18px;font-size:14px;line-height:1.5;color:#9a3412}',
      '.gv-hint{font-size:13px;line-height:1.5;color:#64748b;background:#f8fafc;border-radius:11px;padding:11px 13px;margin:4px 0 14px}',
      '.gv-url{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:11px 13px;font-size:13px;color:#475569;word-break:break-all;margin:14px 0 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '@media (prefers-reduced-motion:reduce){.gv-ins,.gv-ins-back{transition:none}}'
    ].join('');
    document.head.appendChild(css);
  }

  // Íconos reales de los navegadores
  var ICO_SHARE = '<span class="gv-ico gv-share"><svg viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/></svg></span>';
  var ICO_MORE_H = '<span class="gv-ico">&middot;&middot;&middot;</span>';       // ⋯ de Safari
  var ICO_MORE_V = '<span class="gv-ico" style="font-size:18px">&#8942;</span>'; // ⋮ de Chrome Android
  var ICO_PLUS = '<span class="gv-plus">+</span>';

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
    var el = document.createElement('div');
    el.className = 'gv-ins';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = '<div class="gv-ins-grip"></div>' + html;
    el._back = back;
    document.body.appendChild(back);
    document.body.appendChild(el);
    sheetEl = el;
    // El fondo recién cierra después de un instante: en algunos celulares el
    // mismo toque que abre la guía la cerraba enseguida ("aparece y desaparece").
    setTimeout(function () { back.onclick = closeSheet; }, 450);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { back.classList.add('on'); el.classList.add('on'); });
    });
    var c = el.querySelector('[data-gv="close"]');
    if (c) c.onclick = closeSheet;
    return el;
  }

  function pasos(lista) {
    return lista.map(function (tx, i) {
      return '<div class="gv-step"><span class="gv-num">' + (i + 1) + '</span><span class="gv-step-tx">' + tx + '</span></div>';
    }).join('');
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
  function wireCopy(el, url, okText) {
    var b = el.querySelector('[data-gv="copy"]');
    if (!b) return;
    b.onclick = function () {
      var ok = function () { b.textContent = okText; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(ok, function () { fallbackCopy(url, ok); });
      } else { fallbackCopy(url, ok); }
    };
  }

  // Dentro de Instagram/Facebook/etc: primero hay que salir al navegador.
  function sheetSalirAlNavegador() {
    var url = location.href;
    var destino = isIOS ? 'Safari' : 'Chrome';
    var el = buildSheet(
      '<h3>Abrilo en ' + destino + '</h3>' +
      '<p class="gv-sub">Estás viendo Gestiva dentro de otra aplicación, y desde acá el teléfono no deja instalar.</p>' +
      pasos(isIOS
        ? ['Tocá <b>···</b> o el ícono del navegador, arriba a la derecha.', 'Elegí <b>Abrir en Safari</b> (o «Abrir en el navegador»).', 'Ya en Safari, tocá <b>Descargar app</b> de nuevo.']
        : ['Tocá ' + ICO_MORE_V + ' arriba a la derecha.', 'Elegí <b>Abrir en Chrome</b> (o «Abrir en el navegador»).', 'Ya en Chrome, tocá <b>Descargar app</b> de nuevo.']) +
      '<div class="gv-url">' + url.replace(/[<>&"]/g, '') + '</div>' +
      '<button class="gv-ins-btn" data-gv="copy">Copiar el link</button>' +
      '<button class="gv-ins-btn sec" data-gv="close">Cerrar</button>'
    );
    wireCopy(el, url, '¡Link copiado! Pegalo en ' + destino);
  }

  // iPhone / iPad: "Agregar a inicio", con los pasos de SU navegador.
  function sheetIOS(nombreApp) {
    var titulo = 'Instalar ' + (nombreApp || 'Gestiva') + ' en tu ' + (isIPad ? 'iPad' : 'iPhone');
    var lista, hint;
    var sv = safariVersion();
    if (iosBrowser === 'safari' && isIPad) {
      // En el iPad Compartir está arriba, no en una barra de abajo.
      lista = [
        'Tocá ' + ICO_SHARE + ' <b>Compartir</b>, arriba a la derecha. Si no lo ves, tocá ' + ICO_MORE_H + ' y elegí <b>Compartir</b>.',
        'Tocá ' + ICO_PLUS + ' <b>Agregar a inicio</b>.',
        sv && sv >= 26 ? 'Dejá activado <b>«Abrir como app web»</b> y tocá <b>Agregar</b>.' : 'Tocá <b>Agregar</b>.'
      ];
      hint = '¿No aparece «Agregar a inicio»? Abrí este link directamente en Safari.';
    } else if (iosBrowser === 'safari') {
      if (sv && sv >= 26) {
        lista = [
          'Tocá ' + ICO_MORE_H + ' al lado de la dirección de la página.',
          'Tocá ' + ICO_SHARE + ' <b>Compartir</b>.',
          'Bajá y tocá ' + ICO_PLUS + ' <b>Agregar a inicio</b>.',
          'Dejá activado <b>«Abrir como app web»</b> y tocá <b>Agregar</b>.'
        ];
        hint = '¿No ves ' + ICO_MORE_H + '? Tocá la barra de abajo para que aparezca. Si ya ves ' + ICO_SHARE + ' en la barra, tocalo directo.';
      } else {
        lista = [
          'Tocá ' + ICO_SHARE + ' <b>Compartir</b> en la barra de abajo.',
          'Bajá y tocá ' + ICO_PLUS + ' <b>Agregar a inicio</b>.',
          'Tocá <b>Agregar</b>, arriba a la derecha.'
        ];
        hint = '¿No ves Compartir? Tocá la parte de abajo de la pantalla para que aparezca la barra. ¿No aparece «Agregar a inicio»? Abrí este link directamente en Safari.';
      }
    } else {
      // Chrome, Edge y Firefox en iPhone (iOS 16.4 o más nuevo)
      var nav = iosBrowser === 'edge' ? 'Edge' : iosBrowser === 'firefox' ? 'Firefox' : 'Chrome';
      lista = [
        'Tocá ' + ICO_SHARE + ' <b>Compartir</b>, a la derecha de la barra de direcciones.',
        'Bajá y tocá ' + ICO_PLUS + ' <b>Agregar a inicio</b> (o «Agregar a pantalla de inicio»).',
        'Tocá <b>Agregar</b>.'
      ];
      hint = (nav === 'Chrome' ? 'Si no ves Compartir, tocá ' + ICO_MORE_H + ' en la barra de abajo y elegí <b>Compartir</b>.' : 'Si no ves Compartir, buscalo en el menú de ' + nav + '.') +
        ' ¿No aparece «Agregar a inicio»? Abrí este link en Safari.';
    }
    buildSheet(
      '<h3>' + titulo + '</h3>' +
      '<p class="gv-sub">Queda el ícono en tu pantalla y abre como cualquier app.</p>' +
      pasos(lista) +
      '<div class="gv-hint">' + hint + '</div>' +
      '<button class="gv-ins-btn" data-gv="close">Entendido</button>'
    );
  }

  // Android cuando el navegador todavía no ofreció instalar: menú ⋮.
  function sheetAndroid(nombreApp) {
    buildSheet(
      '<h3>Instalar ' + (nombreApp || 'Gestiva') + '</h3>' +
      '<p class="gv-sub">Desde el menú del navegador, en tres toques.</p>' +
      pasos([
        'Tocá ' + ICO_MORE_V + ' arriba a la derecha.',
        'Tocá <b>Instalar app</b> (o «Agregar a la pantalla principal»).',
        'Tocá <b>Instalar</b>.'
      ]) +
      '<div class="gv-hint">Si abriste el link desde WhatsApp, primero tocá ' + ICO_MORE_V + ' → <b>Abrir en Chrome</b>. Si ya la instalaste, buscá el ícono en tu pantalla.</div>' +
      '<button class="gv-ins-btn" data-gv="close">Entendido</button>'
    );
  }

  // Computadora sin diálogo de instalación disponible.
  function sheetDesktop(nombreApp) {
    buildSheet(
      '<h3>Instalar ' + (nombreApp || 'Gestiva') + '</h3>' +
      '<p class="gv-sub">Queda como un programa más en tu computadora.</p>' +
      pasos([
        '<b>Chrome o Edge:</b> tocá el ícono de instalar (⊕) a la derecha de la barra de direcciones.',
        '<b>Safari en Mac:</b> menú Archivo → <b>Agregar al Dock</b>.',
        '<b>Firefox:</b> no permite instalar apps; abrila desde Chrome o Edge.'
      ]) +
      '<button class="gv-ins-btn" data-gv="close">Entendido</button>'
    );
  }

  function showGuide(nombreApp) {
    if (needsSafari || needsChrome) { sheetSalirAlNavegador(); return needsSafari ? 'safari' : 'chrome'; }
    if (isIOS) { sheetIOS(nombreApp); return 'ios'; }
    if (isAndroid) { sheetAndroid(nombreApp); return 'android'; }
    sheetDesktop(nombreApp); return 'desktop';
  }

  // Espera el evento de instalación un ratito: a veces Android lo dispara un
  // segundo después de cargar. No más de 2 s: el toque del usuario "vence" y
  // después el navegador ya no deja abrir el diálogo.
  function esperarPrompt(ms) {
    if (deferred) return Promise.resolve(deferred);
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(null); }, ms);
      esperandoPrompt.push(function (e) { clearTimeout(t); resolve(e); });
    });
  }

  // Si el navegador no deja abrir el diálogo (por ejemplo porque el toque ya
  // "venció"), se muestran los pasos en vez de no hacer nada.
  function lanzarPrompt(ev, nombreApp) {
    deferred = null;
    var abierto;
    try { abierto = ev.prompt(); } catch (e) { notify(); return Promise.resolve(showGuide(nombreApp)); }
    return Promise.resolve(abierto).then(function () {
      return ev.userChoice.then(function (choice) {
        notify();
        return choice && choice.outcome ? choice.outcome : 'dismissed';
      }, function () { notify(); return 'dismissed'; });
    }, function () { notify(); return showGuide(nombreApp); });
  }

  var GestivaInstall = {
    get available() { return !!deferred; },
    get installed() { return isInstalled(); },
    get ios() { return isIOS; },
    get ipad() { return isIPad; },
    get android() { return isAndroid; },
    get needsSafari() { return needsSafari; },
    state: state,
    // Se puede ofrecer siempre que no esté instalada: si no hay diálogo
    // nativo, se muestran los pasos para ese navegador.
    canOffer: function () { return !isInstalled(); },
    onChange: function (fn) { listeners.push(fn); fn(state()); },
    showGuide: showGuide,
    close: closeSheet,
    // Devuelve 'installed' | 'accepted' | 'dismissed' | 'ios' | 'android' |
    //          'desktop' | 'safari' | 'chrome'
    prompt: function (opts) {
      opts = opts || {};
      if (isInstalled()) return Promise.resolve('installed');
      if (needsSafari || needsChrome) return Promise.resolve(showGuide(opts.nombre));
      if (isIOS) return Promise.resolve(showGuide(opts.nombre));
      if (deferred) return lanzarPrompt(deferred, opts.nombre);
      return esperarPrompt(opts.espera != null ? opts.espera : (isAndroid ? 2000 : 0)).then(function (ev) {
        if (ev) return lanzarPrompt(ev, opts.nombre);
        return showGuide(opts.nombre);
      });
    },
    help: function () {
      if (needsSafari) return 'Abrí este link en Safari para poder instalarla.';
      if (needsChrome) return 'Abrí este link en Chrome para poder instalarla.';
      if (isIOS) return 'En ' + (isIPad ? 'iPad' : 'iPhone') + ' se instala con «Agregar a inicio».';
      return 'Tocá «Descargar» y queda instalada como una app.';
    }
  };

  window.GestivaInstall = GestivaInstall;
})();
