/* ============================================================
   Gestiva — instalación de la app (PWA)
   Uso desde cualquier página:
     <script src="install-app.js" defer></script>
     GestivaInstall.onChange(state => { ... })   // state: {available, installed, ios}
     GestivaInstall.prompt()                     // dispara la instalación
   Chrome/Edge/Android usan el diálogo nativo. iPhone/iPad no lo permiten:
   ahí mostramos las instrucciones (Compartir → Agregar a inicio).
   ============================================================ */
(function () {
  var deferred = null;
  var listeners = [];

  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) ||
    // iPadOS 13+ se declara como Mac con pantalla táctil
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  function isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  function state() {
    return { available: !!deferred, installed: isInstalled(), ios: isIOS };
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
    notify();
  });

  var GestivaInstall = {
    get available() { return !!deferred; },
    get installed() { return isInstalled(); },
    get ios() { return isIOS; },
    state: state,
    // Se puede mostrar el botón si hay prompt nativo, o si es iOS (instrucciones),
    // siempre que la app no esté ya instalada.
    canOffer: function () { return !isInstalled() && (!!deferred || isIOS); },
    onChange: function (fn) { listeners.push(fn); fn(state()); },
    // Devuelve 'accepted' | 'dismissed' | 'ios' | 'unavailable'
    prompt: function () {
      if (isInstalled()) return Promise.resolve('installed');
      if (!deferred) return Promise.resolve(isIOS ? 'ios' : 'unavailable');
      deferred.prompt();
      return deferred.userChoice.then(function (choice) {
        deferred = null;
        notify();
        return choice && choice.outcome ? choice.outcome : 'dismissed';
      }).catch(function () { return 'dismissed'; });
    },
    // Texto de ayuda según el dispositivo
    help: function () {
      if (isIOS) return 'En iPhone/iPad: tocá el botón Compartir y elegí "Agregar a inicio".';
      return 'Tocá "Instalar" y Gestiva queda como aplicación en tu dispositivo.';
    }
  };

  window.GestivaInstall = GestivaInstall;
})();
