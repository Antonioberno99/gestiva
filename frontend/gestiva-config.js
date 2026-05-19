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
})();
