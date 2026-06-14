// Gestiva — configuración de cliente
// En producción cambiar API_URL al backend de Render real.
(function() {
  const host = window.location.hostname;
  // Detección automática del backend:
  // - localhost → backend local en :3100
  // - dominio real → backend de Render
  if (host === 'localhost' || host === '127.0.0.1') {
    window.API_URL = 'http://localhost:3100';
  } else {
    // Cambiá esto cuando despliegues en Render:
    window.API_URL = 'https://gestiva-backend.onrender.com';
  }

  // ----------------------------------------------------------
  // Login con Google (Google Identity Services)
  // Si está vacío, el botón "Iniciar sesión con Google" no se muestra.
  // Para activarlo, pegá acá el Client ID web de Google Cloud Console:
  // https://console.cloud.google.com/apis/credentials
  // (ver instrucciones en docs/GOOGLE_OAUTH_SETUP.md)
  // ----------------------------------------------------------
  window.GOOGLE_CLIENT_ID = '677561332180-cjtc8rv31p8dfggnemb1b9r00onl530n.apps.googleusercontent.com';

  // ----------------------------------------------------------
  // Soporte: botón flotante de ayuda en todas las páginas del negocio.
  // Se EXCLUYE el menú QR público (lo ven los comensales, no el dueño).
  // El correo de soporte está en support.js: somosgestiva@gmail.com
  // ----------------------------------------------------------
  if (!/(^|\/)menu(\.html)?($|\/)/i.test(window.location.pathname)) {
    var gvSup = document.createElement('script');
    gvSup.src = 'support.js';
    gvSup.defer = true;
    (document.head || document.documentElement).appendChild(gvSup);
  }
})();
