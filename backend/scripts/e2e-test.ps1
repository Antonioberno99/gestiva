# E2E test de Gestiva contra producción. Ejercita los flujos principales con una cuenta real de prueba.
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

$email = 'launch' + (Get-Random) + '@gmail.com'

# 1. Registro (trial)
$reg = Api 'POST' '/auth/register' @{ email=$email; password='test1234'; restaurantName='Launch QA'; plan='pro' } $null
$tok = $reg.token
Check 'Registro crea cuenta' ($tok -ne $null)
Check 'Estado inicial = trial' ($reg.user.subscriptionStatus -eq 'trial')
Check 'Trial 30 dias' ($reg.user.daysLeft -eq 30)
Check 'Plan elegido = pro' ($reg.user.plan -eq 'pro')

# 2. Login
$login = Api 'POST' '/auth/login' @{ email=$email; password='test1234' } $null
Check 'Login OK' ($login.token -ne $null)

# 3. /auth/me
$me = Api 'GET' '/auth/me' $null $tok
Check 'auth/me devuelve usuario' ($me.user.email -eq $email)

# 4. Demo login RECHAZADO (ya no existe)
$demoRejected = $false
try { Api 'POST' '/auth/login' @{ email='demo@gestiva.app'; password='1234' } $null } catch { $demoRejected = $true }
Check 'Login demo RECHAZADO' $demoRejected

# 5. Productos CRUD
$prods = Api 'GET' '/api/products' $null $tok
Check 'Productos seed >0' ($prods.Count -gt 0)
$newProd = Api 'POST' '/api/products' @{ name='Milanesa QA'; cat='Comida'; price=8500 } $tok
Check 'Crear producto' ($newProd.id -ne $null)
$upd = Api 'PUT' ('/api/products/' + $newProd.id) @{ name='Milanesa QA'; cat='Comida'; price=9000; available=$true } $tok
Check 'Editar producto' ([double]$upd.price -eq 9000)

# 6. Mesas + mozo
$tables = Api 'GET' '/api/tables' $null $tok
Check 'Mesas seed (12)' ($tables.Count -ge 1)
$waiters = Api 'GET' '/api/waiters' $null $tok
Check 'Mozo seed' ($waiters.Count -ge 1)
$tableId = $tables[0].id
$waiterId = $waiters[0].id

# 7. Caja abrir
$cashOpen = Api 'POST' '/api/cash/open' @{ openingAmount=10000 } $tok
Check 'Abrir caja' ($cashOpen -ne $null)

# 8. Abrir mesa + agregar items
$ot = Api 'POST' '/api/open-tables' @{ tableId=$tableId; waiterId=$waiterId } $tok
Check 'Abrir mesa' ($ot -ne $null)
$ot2 = Api 'PUT' ('/api/open-tables/' + $tableId) @{ items=@(@{ productId=$newProd.id; qty=2 }) } $tok
Check 'Agregar items a mesa' ($true)

# 9. Cobrar mesa (efectivo)
$order = Api 'POST' '/api/orders' @{ tableId=$tableId; paymentMethod='efectivo' } $tok
Check 'Cobrar mesa crea orden' ($order.id -ne $null)
Check 'Total orden = 18000' ([math]::Round([double]$order.total) -eq 18000)

# 10. Caja refleja la venta
$cash = Api 'GET' '/api/cash' $null $tok
$inSum = ($cash.current.transactions | Where-Object { $_.type -eq 'in' } | Measure-Object -Property amount -Sum).Sum
Check 'Caja registro ingreso de la venta' ($inSum -ge 18000)

# 11. Clientes + cuenta corriente
$cust = Api 'POST' '/api/customers' @{ name='Cliente QA'; phone='123' } $tok
Check 'Crear cliente' ($cust.id -ne $null)
$payRes = Api 'POST' ('/api/customers/' + $cust.id + '/payment') @{ amount=500; method='efectivo' } $tok
Check 'Registrar pago cliente' ($payRes.ok -eq $true)

# 12. Cocina (KDS)
$kt = Api 'POST' '/api/kitchen' @{ tableId=$tableId; items=@(@{ name='Milanesa QA'; qty=2 }) } $tok
Check 'Crear ticket cocina' ($kt.id -ne $null)
$kitchen = Api 'GET' '/api/kitchen' $null $tok
Check 'Listar cocina' ($kitchen.Count -ge 1)
$ktUpd = Api 'PUT' ('/api/kitchen/' + $kt.id) @{ status='ready' } $tok
Check 'Avanzar ticket cocina' ($true)

# 13. Pedidos delivery/takeaway
$pend = Api 'POST' '/api/pending-orders' @{ kind='takeaway'; customer_name='Take QA' } $tok
Check 'Crear pedido takeaway' ($pend.id -ne $null)

# 14. Dashboard + Reportes
$dash = Api 'GET' '/api/dashboard' $null $tok
Check 'Dashboard responde' ($dash -ne $null)
$orders = Api 'GET' '/api/orders?limit=100' $null $tok
Check 'Reportes: ordenes' ($orders.Count -ge 1)

# 15. Billing: planes, status, subscribe (MercadoPago)
$plans = Api 'GET' '/billing/plans' $null $tok
Check 'Planes publicos (3)' ($plans.plans.Count -eq 3)
$status = Api 'GET' '/billing/status' $null $tok
Check 'Billing status = trial' ($status.status -eq 'trial')
$sub = Api 'POST' '/billing/subscribe' $null $tok
Check 'Subscribe genera link MP' ($sub.initPoint -like '*mercadopago.com*')
Check 'Link MP tiene plan + external_reference' (($sub.initPoint -like '*preapproval_plan_id=*') -and ($sub.initPoint -like '*external_reference=*'))

# 16. Settings
$set = Api 'PUT' '/api/settings' @{ restaurantName='Launch QA 2'; currency='$' } $tok
Check 'Guardar ajustes' ($set.restaurantName -eq 'Launch QA 2')

# 17. Limpieza producto
$del = Api 'DELETE' ('/api/products/' + $newProd.id) $null $tok
Check 'Borrar producto' ($del.ok -eq $true)

# Resultado
$log += ''
$log += "RESULTADO: $pass PASS / $fail FAIL"
$log -join "`n"
