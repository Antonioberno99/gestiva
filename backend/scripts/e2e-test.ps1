# E2E de Gestiva contra producción — modelo "tarjeta primero → mes gratis → cobro automático".
# Verifica el nuevo flujo de suscripción sin necesitar interacción con tarjeta real.
$ErrorActionPreference = 'Stop'
$BASE = 'https://gestiva-backend.onrender.com'
$pass = 0; $fail = 0; $log = @()
function Check($name, $cond) {
  if ($cond) { $script:pass++; $script:log += "PASS  $name" }
  else { $script:fail++; $script:log += "FAIL  $name" }
}
function Api($method, $path, $body, $tok) {
  $headers = @{}
  if ($tok) { $headers['Authorization'] = 'Bearer ' + $tok }
  $args = @{ Uri = $BASE + $path; Method = $method; UseBasicParsing = $true; Headers = $headers }
  if ($body -ne $null) { $args['Body'] = ($body | ConvertTo-Json -Depth 6); $args['ContentType'] = 'application/json' }
  return (Invoke-WebRequest @args).Content | ConvertFrom-Json
}
# Devuelve el código HTTP de una llamada que se espera que falle (p.ej. 402)
function ApiStatus($method, $path, $tok) {
  try {
    $headers = @{}; if ($tok) { $headers['Authorization'] = 'Bearer ' + $tok }
    (Invoke-WebRequest -Uri ($BASE+$path) -Method $method -Headers $headers -UseBasicParsing) | Out-Null
    return 200
  } catch { return [int]$_.Exception.Response.StatusCode.value__ }
}

$email = 'launch' + (Get-Random) + '@gmail.com'

# 1. Registro → queda 'pending' (debe dejar la tarjeta para arrancar el mes gratis)
$reg = Api 'POST' '/auth/register' @{ email=$email; password='test1234'; restaurantName='Launch QA'; plan='pro' } $null
$tok = $reg.token
Check 'Registro crea cuenta' ($tok -ne $null)
Check 'Estado inicial = pending' ($reg.user.subscriptionStatus -eq 'pending')
Check 'Sin dias de prueba todavia' ($reg.user.daysLeft -eq $null)
Check 'Plan elegido = pro' ($reg.user.plan -eq 'pro')

# 2. Login
$login = Api 'POST' '/auth/login' @{ email=$email; password='test1234' } $null
Check 'Login OK' ($login.token -ne $null)

# 3. /auth/me devuelve el usuario en pending
$me = Api 'GET' '/auth/me' $null $tok
Check 'auth/me devuelve usuario' ($me.user.email -eq $email)
Check 'auth/me estado pending' ($me.user.subscriptionStatus -eq 'pending')

# 4. Login demo RECHAZADO (ya no existe)
$demoRejected = $false
try { Api 'POST' '/auth/login' @{ email='demo@gestiva.app'; password='1234' } $null } catch { $demoRejected = $true }
Check 'Login demo RECHAZADO' $demoRejected

# 5. Sin tarjeta NO hay acceso: rutas protegidas devuelven 402
$prodStatus = ApiStatus 'GET' '/api/products' $tok
Check 'Sin tarjeta /api/products = 402' ($prodStatus -eq 402)

# 6. CLAVE: /billing/subscribe genera el plan con mes gratis en MercadoPago
$sub = $null; $subErr = ''
try { $sub = Api 'POST' '/billing/subscribe' $null $tok } catch { $subErr = $_.Exception.Message }
Check 'Subscribe devuelve initPoint de MP' ($sub -ne $null -and $sub.initPoint -like '*mercadopago*')
if ($subErr) { $log += "   (detalle subscribe: $subErr)" }

# 7. Cancelar en 'pending' no aplica (nada que cancelar)
$cancelStatus = ApiStatus 'POST' '/billing/cancel' $tok
Check 'Cancelar en pending = 400' ($cancelStatus -eq 400)

# 8. Panel del dueño configurado
$cfg = Api 'GET' '/admin/configured' $null $null
Check 'Admin configurado' ($cfg.configured -eq $true)

# 9. Páginas públicas cargan (URLs limpias de Vercel; .html redirige 308 y PS 5.1 no lo sigue)
foreach ($p in @('/checkout','/signup','/vendedores','/admin')) {
  $code = 0
  try { $code = (Invoke-WebRequest -Uri ('https://gestiva.site'+$p) -UseBasicParsing).StatusCode } catch { $code = [int]$_.Exception.Response.StatusCode.value__ }
  Check ("Pagina $p carga 200") ($code -eq 200)
}

$log += ''
$log += "RESULTADO: $pass PASS / $fail FAIL"
$log -join "`n"
