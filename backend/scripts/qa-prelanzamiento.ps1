# QA integral de pre-lanzamiento de Gestiva (producción).
# Cubre: backend, modelo "mes gratis con tarjeta", vendedores 40%, todas las páginas,
# archivos nuevos (comandera) y textos clave. NO requiere tarjeta real.
$ErrorActionPreference = 'Stop'
$API  = 'https://gestiva-backend.onrender.com'
$WEB  = 'https://gestiva.site'
$pass = 0; $fail = 0; $log = @()
function Check($name, $cond, $extra) {
  if ($cond) { $script:pass++; $script:log += ("PASS  " + $name) }
  else { $script:fail++; $script:log += ("FAIL  " + $name + $(if($extra){"  -> $extra"}else{''})) }
}
function Api($method, $path, $body, $tok) {
  $h = @{}; if ($tok) { $h['Authorization'] = 'Bearer ' + $tok }
  $a = @{ Uri = $API + $path; Method = $method; UseBasicParsing = $true; Headers = $h }
  if ($body -ne $null) { $a['Body'] = ($body | ConvertTo-Json -Depth 6); $a['ContentType'] = 'application/json' }
  return (Invoke-WebRequest @a).Content | ConvertFrom-Json
}
function Status($method, $path, $tok) {
  try { $h=@{}; if($tok){$h['Authorization']='Bearer '+$tok}; (Invoke-WebRequest -Uri ($API+$path) -Method $method -Headers $h -UseBasicParsing) | Out-Null; return 200 }
  catch { return [int]$_.Exception.Response.StatusCode.value__ }
}
function Page($path) {
  try { return (Invoke-WebRequest -Uri ($WEB+$path) -UseBasicParsing) } catch { return $null }
}

$log += "===== A. BACKEND ====="
$health = Api 'GET' '/health' $null $null
Check 'Backend vivo + DB up' ($health.ok -eq $true -and $health.db -eq 'up')
$cfg = Api 'GET' '/admin/configured' $null $null
Check 'Panel del dueno configurado' ($cfg.configured -eq $true)

$log += "===== B. ALTA RESTAURANTE (mes gratis con tarjeta) ====="
$email = 'qa' + (Get-Random) + '@gmail.com'
$reg = Api 'POST' '/auth/register' @{ email=$email; password='test1234'; restaurantName='QA Pre-Lanzamiento'; plan='pro' } $null
$tok = $reg.token
Check 'Registro crea cuenta' ($tok -ne $null)
Check 'Estado inicial = pending (sin tarjeta no entra)' ($reg.user.subscriptionStatus -eq 'pending') $reg.user.subscriptionStatus
Check 'Sin dias de prueba hasta dejar tarjeta' ($reg.user.daysLeft -eq $null)
Check 'Plan elegido = pro' ($reg.user.plan -eq 'pro')
$login = Api 'POST' '/auth/login' @{ email=$email; password='test1234' } $null
Check 'Login restaurante OK' ($login.token -ne $null)
$me = Api 'GET' '/auth/me' $null $tok
Check 'auth/me coincide y pending' ($me.user.email -eq $email -and $me.user.subscriptionStatus -eq 'pending')
Check 'Sin tarjeta: /api/products bloqueado (402)' ((Status 'GET' '/api/products' $tok) -eq 402)
Check 'Sin tarjeta: /api/tables bloqueado (402)' ((Status 'GET' '/api/tables' $tok) -eq 402)
$sub = $null; $subErr=''
try { $sub = Api 'POST' '/billing/subscribe' $null $tok } catch { $subErr = $_.Exception.Message }
Check 'MercadoPago genera link con mes gratis' ($sub -ne $null -and $sub.initPoint -like '*mercadopago*') $subErr
Check 'Cancelar en pending = 400 (nada que cancelar)' ((Status 'POST' '/billing/cancel' $tok) -eq 400)

$log += "===== C. VENDEDORES (40%) ====="
$vmail = 'qaven' + (Get-Random) + '@gmail.com'
$vreg = Api 'POST' '/vendor/register' @{ email=$vmail; password='vendor1234'; name='QA Vendedor'; phone='388-555-0000'; application=@{ zona='Jujuy'; experiencia='Si'; comoVende='Visitas'; comentarios='-' } } $null
Check 'Vendedor registra (token)' ($vreg.token -ne $null)
Check 'Vendedor queda pending' ($vreg.vendor.status -eq 'pending')
Check 'Comision = 40%' ([double]$vreg.vendor.commissionPercent -eq 40)
Check 'Codigo de vendedor generado' ($vreg.vendor.refCode -ne $null -and $vreg.vendor.refCode.Length -ge 6)
$vlogin = Api 'POST' '/vendor/login' @{ email=$vmail; password='vendor1234' } $null
Check 'Vendedor login OK' ($vlogin.token -ne $null)
$vme = Api 'GET' '/vendor/me' $null $vlogin.token
Check 'vendor/me pending' ($vme.vendor.status -eq 'pending')
$adminWrong = $false
try { Api 'POST' '/admin/login' @{ email='antonioberno99@gmail.com'; password='claveMala123' } $null } catch { $adminWrong = $true }
Check 'Admin rechaza clave incorrecta' $adminWrong

$log += "===== D. PAGINAS (cargan 200) ====="
$pages = @('/landing','/signup','/login','/checkout','/billing-return','/mozo','/cocina','/menu','/vendedores','/vendedor','/admin')
foreach ($p in $pages) {
  $r = Page $p
  Check ("Pagina $p") ($r -ne $null -and $r.StatusCode -eq 200) $(if($r){$r.StatusCode}else{'sin respuesta'})
}

$log += "===== E. ARCHIVOS / FEATURES ====="
$cmdr = Page '/comandera.js'
Check 'comandera.js publicado' ($cmdr -ne $null -and $cmdr.Content -match 'window.Comandera')

$log += "===== F. TEXTOS CLAVE ====="
$land = (Page '/landing').Content
Check "Landing: boton 'Probar sistema gratis'" ($land -match 'Probar sistema gratis')
Check "Landing: menu 'Accesos rapidos'" ($land -match 'Accesos r')
Check "Landing: menu 'Ser Vendedor'" ($land -match 'Ser Vendedor')
Check "Landing: menu 'App del Mozo'" ($land -match 'App del Mozo')
Check "Landing: menu sin emojis (sin class ic)" (-not ($land -match 'class="ic"'))
Check "Landing: 30 dias gratis" ($land -match '30 d')
$sign = (Page '/signup').Content
Check "Signup: 'mes gratis'" ($sign -match 'mes gratis')
$mozo = (Page '/mozo').Content
Check "Mozo: boton Comandera" ($mozo -match 'Comandera')
Check "Mozo: incluye comandera.js" ($mozo -match 'comandera.js')
$ven = (Page '/vendedores').Content
Check "Vendedores: comision 40%" ($ven -match '40%')

$log += ""
$log += ("RESULTADO: " + $pass + " PASS / " + $fail + " FAIL")
$log -join "`n"
