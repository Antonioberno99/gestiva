# Login con Google — Setup paso a paso

Gestiva soporta "Iniciar sesión con Google" usando Google Identity Services.
Para activarlo necesitás crear un **Client ID** gratis en Google Cloud Console.

Tiempo total: ~5 minutos.

---

## Paso 1 — Crear el proyecto en Google Cloud

1. Andá a https://console.cloud.google.com
2. Arriba a la izquierda, dropdown de proyectos → **New Project**
3. Nombre: `Gestiva` → Create
4. Esperá unos segundos y seleccioná el proyecto

## Paso 2 — Configurar la OAuth Consent Screen

Antes de crear el Client ID hay que decirle a Google qué van a ver los usuarios.

1. En el menú lateral: **APIs & Services** → **OAuth consent screen**
2. User Type: **External** → Create
3. Completá:
   - **App name**: `Gestiva`
   - **User support email**: tu email
   - **App logo** (opcional): subí el logo (`frontend/assets/logo-gestiva-icon.png`)
   - **Application home page**: `https://gestiva.vercel.app` (o tu dominio)
   - **Authorized domains**: agregá `vercel.app` (o tu dominio)
   - **Developer contact**: tu email
4. Save and Continue
5. En **Scopes**: dejá los default (`email`, `profile`, `openid`) → Save and Continue
6. En **Test users**: agregá tu propio email para probar antes de publicar → Save
7. Cuando esté listo, en la pantalla de Consent Screen click **PUBLISH APP** para que cualquier usuario pueda usarlo

## Paso 3 — Crear el Client ID

1. **APIs & Services** → **Credentials**
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `Gestiva Web`
5. **Authorized JavaScript origins**: agregá las URLs desde donde se va a usar el botón:
   - `http://localhost:3000`
   - `https://gestiva.vercel.app`
   - (cuando tengas dominio propio, agregalo)
6. **Authorized redirect URIs**: dejalo VACÍO (Google Identity Services con One Tap no usa redirect)
7. Create
8. Te muestra el **Client ID** — copialo. Se ve así:
   `1234567890-abc123def456.apps.googleusercontent.com`

## Paso 4 — Configurar el Client ID en Gestiva

### Frontend

Editá `frontend/gestiva-config.js`, pegá el Client ID:

```js
window.GOOGLE_CLIENT_ID = '1234567890-abc123def456.apps.googleusercontent.com';
```

Commiteá y pusheá. Vercel auto-deploya.

### Backend (Render)

En el dashboard de Render → `gestiva-backend` → **Environment** → agregá la variable:

| Variable | Valor |
|----------|-------|
| `GOOGLE_CLIENT_ID` | el mismo Client ID que pegaste en el frontend |

Click **Save Changes** → Render redeploya solo en ~5 min.

## Paso 5 — Probar

1. Abrí `https://gestiva.vercel.app/login.html`
2. Tiene que aparecer el botón **"Sign in with Google"** arriba del form de email
3. Clickealo → popup de Google → elegí tu cuenta
4. Te redirige al panel
5. Si sos nuevo, vas a Ajustes para ponerle el nombre real al restaurante

---

## Troubleshooting

### "Error 400: redirect_uri_mismatch"
Pasaste el origin incorrecto. Verificá que en Authorized JavaScript origins esté EXACTO con `http://` o `https://` y SIN slash final.

### El botón no aparece
- Verificá que `GOOGLE_CLIENT_ID` esté seteado en `gestiva-config.js`
- Abrí la consola del navegador y mirá si hay errores con el script `https://accounts.google.com/gsi/client`

### "Google login no está configurado en el backend"
El backend (Render) no tiene la variable `GOOGLE_CLIENT_ID` seteada. Andá a Environment en Render y agregala.

### "invalid_audience"
El Client ID del frontend NO coincide con el del backend. Tienen que ser exactamente el mismo.

### "email_not_verified"
La cuenta de Google que usaste no tiene el email verificado. Esto pasa raramente, por seguridad lo rechazamos.

---

## Seguridad

- El Client ID **NO** es secreto, es público (va en el HTML).
- Lo que valida la identidad es el **ID token** firmado por Google que se manda al backend.
- El backend verifica el token con Google's tokeninfo y chequea que el `audience` coincida con el Client ID configurado.
- No hace falta Client Secret porque Google Identity Services usa One Tap / Sign In with Google que no requiere flow de redirección.

## ¿Qué pasa con las cuentas existentes?

Si un usuario ya creó cuenta con email/password y después loguea con Google **del mismo email**, las cuentas se **linkean automáticamente** — su `google_id` queda guardado y puede entrar de cualquiera de las dos formas.

## ¿Y los datos?

Los usuarios nuevos creados via Google empiezan con:
- `restaurant_name = 'Mi restaurante'` (lo cambian desde Ajustes)
- 12 mesas vacías
- 1 mozo
- 8 productos default
- Caja cerrada
- Suscripción activa por 1 año (con SKIP_BILLING)
