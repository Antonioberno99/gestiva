# Prueba la funcion Invoke-CloudPoll REAL del agente contra el backend,
# simulando los tres escenarios que le importan a un local que ya tiene la
# comandera andando.
# Uso:
#   pwsh -File comandera-bridge/test-agente.ps1
#   pwsh -File comandera-bridge/test-agente.ps1 -Api http://127.0.0.1:3100
#   pwsh -File comandera-bridge/test-agente.ps1 -AgentFile <otra-version.ps1>
#
# Necesita el backend corriendo. Prueba la funcion Invoke-CloudPoll REAL del
# agente: no imprime de verdad, reemplaza la impresora por un espia.
param(
  [string]$Api = $(if ($env:GESTIVA_API) { $env:GESTIVA_API } else { 'http://127.0.0.1:3100' }),
  [string]$AgentFile = "$PSScriptRoot/gestiva-print-agent.ps1"
)
$ErrorActionPreference = 'Stop'
$API = $Api

$script:pass = 0; $script:fail = 0
function Check($n, $ok, $d) {
  if ($ok) { $script:pass++; Write-Host "  [OK] $n" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  [FALLA] $n $(if($d){"-> $d"})" -ForegroundColor Red }
}
function Seccion($t) { Write-Host "`n$t" -ForegroundColor White }

# ---- Extraemos las funciones reales del agente (sin arrancar su servidor HTTP)
$src = Get-Content $AgentFile -Raw
function Get-Fn($nombre) {
  $i = $src.IndexOf("function $nombre")
  if ($i -lt 0) { throw "no se encontro $nombre" }
  $d = 0; $j = $i; $started = $false
  while ($j -lt $src.Length) {
    if ($src[$j] -eq '{') { $d++; $started = $true }
    elseif ($src[$j] -eq '}') { $d--; if ($started -and $d -eq 0) { break } }
    $j++
  }
  return $src.Substring($i, $j - $i + 1)
}

# ---- Dependencias minimas (las de verdad tocan disco/impresora)
$script:StateFile = '/tmp/agent-state.json'
$script:LOG = @()
$script:IMPRESAS = @()
$script:FALLAR_IMPRESION = $false
$script:CFG = $null

function Write-AgentLog($m) { $script:LOG += $m }
function Get-AgentConfig { return $script:CFG }
function Get-PrinterMode($c) { if ($c.printerMode) { return $c.printerMode } return 'network' }
function Send-RoutedTicket($t, $c) {
  if ($script:FALLAR_IMPRESION) { throw 'La impresora no responde' }
  $script:IMPRESAS += [string]$t.id
}
function Read-JsonFile($p, $def) {
  if (-not (Test-Path $p)) { return $def }
  return (Get-Content $p -Raw | ConvertFrom-Json)
}
function Save-JsonFile($p, $o) { $o | ConvertTo-Json -Depth 8 | Set-Content $p }
function Save-AgentState($State) {
  $ids = @($State.printed) | Select-Object -Last 500
  $State.printed = @($ids)
  Save-JsonFile $script:StateFile $State | Out-Null
}

# ---- Las funciones que estamos probando, tal cual estan en el agente
Invoke-Expression (Get-Fn 'Get-AgentState')
Invoke-Expression (Get-Fn 'Invoke-CloudPoll')

# ---- Datos: restaurante + mozo + una comanda
function Req($path, $method, $body, $token) {
  $h = @{ 'Content-Type' = 'application/json' }
  if ($token) { $h['Authorization'] = "Bearer $token" }
  $args = @{ Uri = "$API$path"; Method = $method; Headers = $h; TimeoutSec = 15 }
  if ($body) { $args['Body'] = ($body | ConvertTo-Json -Depth 8 -Compress) }
  return Invoke-RestMethod @args
}

$email = "psagent-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())@t.local"
$reg = Req '/auth/register' 'POST' @{ email = $email; password = 'Secreta123'; restaurantName = 'Agente PS' }
$owner = $reg.token
Req '/api/waiters' 'POST' @{ name = 'Nico'; pin = '3333' } $owner | Out-Null
$mesas = Req '/api/tables' 'GET' $null $owner
$mesa = $mesas[0]
$tok = Req '/api/print-station/token' 'POST' $null $owner
$script:CFG = [pscustomobject]@{ token = $tok.token; apiUrl = $API; printerMode = 'network'; printerIp = '10.0.0.9'; printerPort = 9100; restaurant = 'Agente PS' }
$mozo = (Req '/waiter/login' 'POST' @{ email = $email; pin = '3333' }).token
Req '/waiter/open-tables' 'POST' @{ tableId = $mesa.id } $mozo | Out-Null

function NuevaComanda($cid, $nombre) {
  Req '/waiter/kitchen' 'POST' @{ tableId = $mesa.id; clientTicketId = $cid; items = @(@{ name = $nombre; qty = 1; cat = 'Comida' }) } $mozo | Out-Null
}

# ============================================================
Seccion 'ESCENARIO A - INSTALACION NUEVA con comandas ya en el sistema'
NuevaComanda 'a1' 'Comanda vieja 1'
NuevaComanda 'a2' 'Comanda vieja 2'
Remove-Item $script:StateFile -ErrorAction SilentlyContinue   # sin estado = instalacion nueva
$script:IMPRESAS = @(); $script:LOG = @()
Invoke-CloudPoll
Check 'no escupe el historial al instalarse' ($script:IMPRESAS.Count -eq 0) "imprimio $($script:IMPRESAS.Count)"
$st = Get-Content $script:StateFile -Raw | ConvertFrom-Json
Check 'queda marcada como sembrada' ($null -ne $st.seededAt)
Check 'queda marcada con el modo cola' ($st.queueMode -eq 'print-queue') "queueMode=$($st.queueMode)"

Seccion 'ESCENARIO B - OPERACION NORMAL'
NuevaComanda 'b1' 'Milanesa'
$script:IMPRESAS = @()
Invoke-CloudPoll
Check 'imprime la comanda nueva' ($script:IMPRESAS.Count -eq 1) "imprimio $($script:IMPRESAS.Count)"
$script:IMPRESAS = @()
Invoke-CloudPoll
Check 'NO la reimprime en la vuelta siguiente' ($script:IMPRESAS.Count -eq 0) "imprimio $($script:IMPRESAS.Count)"

Seccion 'ESCENARIO C - SE TRABA EL PAPEL (la comanda no se pierde)'
NuevaComanda 'c1' 'Asado'
$script:FALLAR_IMPRESION = $true
$script:IMPRESAS = @()
Invoke-CloudPoll
Check 'la impresora falla y no se confirma nada' ($script:IMPRESAS.Count -eq 0)
$script:FALLAR_IMPRESION = $false
Invoke-CloudPoll
Check 'al arreglar la impresora, sale igual' ($script:IMPRESAS.Count -eq 1) "imprimio $($script:IMPRESAS.Count)"

Seccion 'ESCENARIO D - ACTUALIZAR DESDE EL AGENTE VIEJO (el caso riesgoso)'
# Un local que ya tenia la comandera andando: el agente 3.3.0 dejaba seededAt
# y su propia lista local, pero NUNCA confirmaba al servidor.
NuevaComanda 'd1' 'Ya impresa por el agente viejo 1'
NuevaComanda 'd2' 'Ya impresa por el agente viejo 2'
NuevaComanda 'd3' 'Ya impresa por el agente viejo 3'
@{ seededAt = '2026-01-01T00:00:00Z'; printed = @('viejo-1','viejo-2') } |
  ConvertTo-Json | Set-Content $script:StateFile      # estado tal cual lo deja 3.3.0
$script:IMPRESAS = @(); $script:LOG = @()
Invoke-CloudPoll
Check 'al actualizar NO reimprime lo que ya salio' ($script:IMPRESAS.Count -eq 0) "reimprimio $($script:IMPRESAS.Count) comandas"
$st2 = Get-Content $script:StateFile -Raw | ConvertFrom-Json
Check 'marca el modo cola para no repetirlo' ($st2.queueMode -eq 'print-queue')

Seccion 'ESCENARIO E - despues de actualizar, sigue trabajando normal'
NuevaComanda 'e1' 'Pedido despues de actualizar'
$script:IMPRESAS = @()
Invoke-CloudPoll
Check 'imprime los pedidos nuevos' ($script:IMPRESAS.Count -eq 1) "imprimio $($script:IMPRESAS.Count)"

Write-Host ("`n" + ('-' * 50))
if ($script:fail -eq 0) { Write-Host "OK $($script:pass)/$($script:pass + $script:fail) - el agente aguanta instalacion, uso y actualizacion" -ForegroundColor Green }
else { Write-Host "$script:fail FALLARON ($script:pass ok)" -ForegroundColor Red; exit 1 }
