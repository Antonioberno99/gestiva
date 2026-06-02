# E2E del programa de vendedores
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

# 1. Registrar vendedor
$vEmail = 'vend' + (Get-Random) + '@gmail.com'
$vReg = Api 'POST' '/vendor/register' @{ name='Vendedor QA'; email=$vEmail; password='vendor1234'; phone='1234' } $null
Check 'Vendor register OK' ($vReg.token -ne $null)
Check 'Ref code generado' ($vReg.vendor.refCode -ne $null)
Check 'Comision por defecto 20%' ($vReg.vendor.commissionPercent -eq 20)
$vTok = $vReg.token
$refCode = $vReg.vendor.refCode

# 2. Login vendedor
$vLogin = Api 'POST' '/vendor/login' @{ email=$vEmail; password='vendor1234' } $null
Check 'Vendor login OK' ($vLogin.token -ne $null)
Check 'Vendor login devuelve ref code' ($vLogin.vendor.refCode -eq $refCode)

# 3. /vendor/me
$me = Api 'GET' '/vendor/me' $null $vTok
Check 'vendor/me OK' ($me.vendor.email -eq $vEmail)

# 4. Registrar tenant CON ref code
$tEmail = 'rest' + (Get-Random) + '@gmail.com'
$tReg = Api 'POST' '/auth/register' @{ email=$tEmail; password='test1234'; restaurantName='Rest Vendor QA'; plan='pro'; ref=$refCode } $null
Check 'Tenant con ref registrado' ($tReg.token -ne $null)

# 5. /vendor/clients debe listar al tenant
$clients = Api 'GET' '/vendor/clients' $null $vTok
Check 'Cliente aparece en cartera del vendor' (($clients.clients | Where-Object { $_.email -eq $tEmail }).Count -ge 1)

# 6. /vendor/stats refleja el cliente nuevo en trial
$stats = Api 'GET' '/vendor/stats' $null $vTok
Check 'Stats total clientes >=1' ($stats.clients.total -ge 1)
Check 'Stats in_trial >=1' ($stats.clients.in_trial -ge 1)

# 7. Registrar tenant SIN ref (no debe asociarse)
$t2Email = 'sinref' + (Get-Random) + '@gmail.com'
$t2 = Api 'POST' '/auth/register' @{ email=$t2Email; password='test1234'; restaurantName='Sin Ref'; plan='start' } $null
Check 'Tenant sin ref registrado' ($t2.token -ne $null)
$clients2 = Api 'GET' '/vendor/clients' $null $vTok
Check 'Tenant sin ref NO aparece en cartera' (($clients2.clients | Where-Object { $_.email -eq $t2Email }).Count -eq 0)

# 8. Ref code invalido se ignora gracefully
$t3Email = 'badref' + (Get-Random) + '@gmail.com'
$t3 = Api 'POST' '/auth/register' @{ email=$t3Email; password='test1234'; restaurantName='Bad Ref'; plan='start'; ref='NO-EXISTE' } $null
Check 'Ref code invalido no rompe registro' ($t3.token -ne $null)
$clients3 = Api 'GET' '/vendor/clients' $null $vTok
Check 'Tenant con ref invalido NO se asocia' (($clients3.clients | Where-Object { $_.email -eq $t3Email }).Count -eq 0)

# 9. Comisiones inicialmente vacia (no hubo cobros)
$comm = Api 'GET' '/vendor/commissions' $null $vTok
Check 'Lista comisiones vacia (sin cobros aun)' ($comm.commissions.Count -eq 0)
Check 'Stats earned_total = 0' ([double]$stats.commissions.earned_total -eq 0)

# 10. Vendor no puede acceder a endpoints de tenant
$blocked = $false
try { Api 'GET' '/auth/me' $null $vTok } catch { $blocked = $true }
Check 'Token vendor RECHAZADO en endpoint tenant' $blocked

# 11. Tenant no puede acceder a endpoints de vendor
$blocked2 = $false
try { Api 'GET' '/vendor/me' $null $tReg.token } catch { $blocked2 = $true }
Check 'Token tenant RECHAZADO en endpoint vendor' $blocked2

$log += ''
$log += "RESULTADO: $pass PASS / $fail FAIL"
$log -join "`n"
