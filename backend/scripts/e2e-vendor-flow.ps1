# E2E del flujo nuevo de vendedores con 40% + código en signup.
$ErrorActionPreference = 'Stop'
$BASE = 'https://gestiva-backend.onrender.com'
$pass = 0; $fail = 0; $log = @()
function Check($name, $cond) { if ($cond) { $script:pass++; $script:log += "PASS  $name" } else { $script:fail++; $script:log += "FAIL  $name" } }
function Api($method, $path, $body, $tok) {
  $headers = @{}; if ($tok) { $headers['Authorization'] = 'Bearer ' + $tok }
  $args = @{ Uri = $BASE + $path; Method = $method; UseBasicParsing = $true; Headers = $headers }
  if ($body -ne $null) { $args['Body'] = ($body | ConvertTo-Json -Depth 6); $args['ContentType'] = 'application/json' }
  return (Invoke-WebRequest @args).Content | ConvertFrom-Json
}

# 1. Backend OK y admin configurado
$cfg = Api 'GET' '/admin/configured' $null $null
Check 'Admin configurado' ($cfg.configured -eq $true)

# 2. Vendedor se registra con solicitud completa
$vEmail = 'vqa' + (Get-Random) + '@gmail.com'
$application = @{
  zona = 'San Salvador de Jujuy'
  telefono = '388-555-0001'
  experiencia = 'Algo de experiencia'
  comoVende = 'Visitando restaurantes de mi barrio'
  comentarios = 'Tengo contactos en gastronomía'
}
$vReg = Api 'POST' '/vendor/register' @{ email=$vEmail; password='vendor1234'; name='Juan QA Vendor'; phone='388-555-0001'; application=$application } $null
Check 'Vendor register OK' ($vReg.token -ne $null)
Check 'Vendor status = pending' ($vReg.vendor.status -eq 'pending')
Check 'Vendor commissionPercent = 40' ([double]$vReg.vendor.commissionPercent -eq 40)
Check 'Vendor ref code generado' ($vReg.vendor.refCode -ne $null -and $vReg.vendor.refCode.Length -ge 6)
Check 'Vendor hasApplication = true' ($vReg.vendor.hasApplication -eq $true)

# 3. Vendor login con su pass
$vLogin = Api 'POST' '/vendor/login' @{ email=$vEmail; password='vendor1234' } $null
Check 'Vendor login OK' ($vLogin.token -ne $null)
$vTok = $vLogin.token

# 4. Vendor /me devuelve status pending
$vMe = Api 'GET' '/vendor/me' $null $vTok
Check 'Vendor me OK (pending)' ($vMe.vendor.status -eq 'pending')

# 5. Restaurante se registra TIPEANDO el codigo (no por link)
$ref = $vReg.vendor.refCode
$tEmail = 'rqa' + (Get-Random) + '@gmail.com'
$tReg = Api 'POST' '/auth/register' @{ email=$tEmail; password='test1234'; restaurantName='QA Resto Codigo'; plan='pro'; ref=$ref } $null
Check 'Tenant register con codigo OK' ($tReg.token -ne $null)
Check 'Tenant estado = trial' ($tReg.user.subscriptionStatus -eq 'trial')

# 6. El restaurante quedo asociado al vendor (aunque vendor este pending)
# Nota: vendor pending NO captura comisiones aun, pero el tenant igualmente se asocia?
# Diseno actual: solo se asocia si vendor.status='active'. Verifico el comportamiento:
$tMe = Api 'GET' '/auth/me' $null $tReg.token
Check 'Tenant alta funciono' ($tMe.user.email -eq $tEmail)

# 7. ENDPOINT vendor/clients (sin importar status del vendor) — vendor pending solo ve su solicitud
# Lo que importa: si la asociacion vendor->tenant se hizo cuando vendor estaba pending, no debe haberse hecho.
# Verifico que el design es: ref solo cuenta si vendor activo. Si vendor pending, el ref se ignora -> NO asocia.
$clientsPending = Api 'GET' '/vendor/clients' $null $vTok
Check 'Vendor pending NO captura tenant (ok)' ($clientsPending.clients.Count -eq 0)

# 8. Restaurante SIN codigo (campana de marketing) = directo, sin vendor
$tEmail2 = 'rdir' + (Get-Random) + '@gmail.com'
$tDirect = Api 'POST' '/auth/register' @{ email=$tEmail2; password='test1234'; restaurantName='QA Directo'; plan='pro' } $null
Check 'Tenant directo (sin codigo) OK' ($tDirect.token -ne $null)

# 9. Codigo invalido NO rompe registro
$tEmail3 = 'rbad' + (Get-Random) + '@gmail.com'
$tBad = Api 'POST' '/auth/register' @{ email=$tEmail3; password='test1234'; restaurantName='QA Bad Ref'; plan='pro'; ref='INVALIDO-XXX' } $null
Check 'Tenant con codigo invalido = registro OK' ($tBad.token -ne $null)

# 10. Vendor pending NO puede acceder a sus stats (o si puede ver vacio? El gating actual lo permite)
$stats = Api 'GET' '/vendor/stats' $null $vTok
Check 'Vendor pending puede ver stats vacias' ($stats.clients.total -eq 0)

# 11. Admin login con password incorrecto = rechazado
$wrongPass = $false
try { Api 'POST' '/admin/login' @{ email='antonioberno99@gmail.com'; password='passWrong123' } $null } catch { $wrongPass = $true }
Check 'Admin login con pass incorrecto = rechazado' $wrongPass

# 12. Pagina del panel del dueno carga
$adminPage = (Invoke-WebRequest -Uri 'https://gestiva.site/admin' -UseBasicParsing).StatusCode
Check 'Pagina /admin carga 200' ($adminPage -eq 200)

# Resultado
$log += ''
$log += "VENDOR REF CODE creado para que apruebes desde tu /admin: $ref"
$log += "EMAIL del vendor pendiente: $vEmail"
$log += "RESULTADO: $pass PASS / $fail FAIL"
$log -join "`n"
