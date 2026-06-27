param(
  [int]$Port = 7777
)

$ErrorActionPreference = 'Continue'
$AppDir = Join-Path $env:LOCALAPPDATA 'GestivaComandera'
$ConfigFile = Join-Path $AppDir 'config.json'
$StateFile = Join-Path $AppDir 'state.json'
$LogFile = Join-Path $AppDir 'agent.log'
$PollSeconds = 4
$AgentVersion = '3.0.1'
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

function Write-AgentLog($Message) {
  try {
    Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  } catch {}
}

function Convert-ToAscii($Value) {
  $s = if ($null -eq $Value) { '' } else { [string]$Value }
  try {
    $normalized = $s.Normalize([Text.NormalizationForm]::FormD)
    $sb = New-Object Text.StringBuilder
    foreach ($ch in $normalized.ToCharArray()) {
      $cat = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
      if ($cat -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($ch) }
    }
    $s = $sb.ToString()
  } catch {}
  $s = $s -replace '[^\x20-\x7E]', ''
  return $s
}

function Read-JsonFile($Path, $Default) {
  try {
    if (-not (Test-Path $Path)) { return $Default }
    $raw = Get-Content -Raw -Path $Path
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    return $raw | ConvertFrom-Json
  } catch {
    Write-AgentLog "json read error ${Path}: $($_.Exception.Message)"
    return $Default
  }
}

function Save-JsonFile($Path, $Object) {
  try {
    $Object | ConvertTo-Json -Depth 10 | Set-Content -Path $Path -Encoding UTF8
    return $true
  } catch {
    Write-AgentLog "json save error ${Path}: $($_.Exception.Message)"
    return $false
  }
}

function Get-AgentConfig {
  return Read-JsonFile $ConfigFile ([pscustomobject]@{})
}

function Save-AgentConfig($Config) {
  Save-JsonFile $ConfigFile $Config | Out-Null
}

function Get-AgentState {
  $state = Read-JsonFile $StateFile ([pscustomobject]@{ seededAt = $null; printed = @() })
  if ($null -eq $state.printed) { $state | Add-Member -Force -NotePropertyName printed -NotePropertyValue @() }
  return $state
}

function Save-AgentState($State) {
  $ids = @($State.printed) | Select-Object -Last 500
  $State.printed = @($ids)
  Save-JsonFile $StateFile $State | Out-Null
}

function Reset-AgentState {
  Save-AgentState ([pscustomobject]@{ seededAt = $null; printed = @() })
}

function Is-PrivateIPv4($Ip) {
  return ($Ip -match '^192\.168\.') -or ($Ip -match '^10\.') -or ($Ip -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.')
}

function Get-LocalSubnets {
  $out = New-Object System.Collections.Generic.List[string]
  try {
    [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object {
      if ($_.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { return }
      $_.GetIPProperties().UnicastAddresses | ForEach-Object {
        if ($_.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return }
        $ip = $_.Address.ToString()
        if (-not (Is-PrivateIPv4 $ip)) { return }
        $parts = $ip.Split('.')
        if ($parts.Length -ne 4) { return }
        $prefix = "$($parts[0]).$($parts[1]).$($parts[2])"
        if (-not $out.Contains($prefix)) { $out.Add($prefix) }
      }
    }
  } catch {
    Write-AgentLog "subnet error: $($_.Exception.Message)"
  }
  return @($out)
}

function Connect-Tcp($Ip, $Port, $TimeoutMs) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($Ip, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      $client.Close()
      return $null
    }
    $client.EndConnect($async)
    if (-not $client.Connected) {
      $client.Close()
      return $null
    }
    return $client
  } catch {
    try { $client.Close() } catch {}
    return $null
  }
}

function Test-Printer($Ip, $Port, $TimeoutMs) {
  $client = Connect-Tcp $Ip $Port $TimeoutMs
  if ($client -eq $null) { return $false }
  try { $client.Close() } catch {}
  return $true
}

function Scan-Printers($Port) {
  $subnets = @(Get-LocalSubnets)
  $printers = New-Object System.Collections.Generic.List[string]
  foreach ($prefix in $subnets) {
    $items = New-Object System.Collections.Generic.List[object]
    for ($h = 1; $h -le 254; $h++) {
      $ip = "$prefix.$h"
      $client = New-Object System.Net.Sockets.TcpClient
      try {
        $async = $client.BeginConnect($ip, $Port, $null, $null)
        $items.Add([pscustomobject]@{ Ip = $ip; Client = $client; Async = $async })
      } catch {
        try { $client.Close() } catch {}
      }
    }
    Start-Sleep -Milliseconds 2200
    foreach ($item in $items) {
      try {
        if ($item.Async.AsyncWaitHandle.WaitOne(0, $false) -and $item.Client.Connected) {
          try { $item.Client.EndConnect($item.Async) } catch {}
          $printers.Add($item.Ip)
        }
      } catch {}
      try { $item.Client.Close() } catch {}
    }
  }
  return @{ subnets = $subnets; printers = @($printers) }
}

function Add-Bytes($List, [byte[]]$Bytes) {
  foreach ($b in $Bytes) { $List.Add([byte]$b) }
}

function Add-TextLine($List, $Text) {
  $bytes = [Text.Encoding]::ASCII.GetBytes((Convert-ToAscii $Text))
  Add-Bytes $List $bytes
  $List.Add([byte]10)
}

function Add-Center($List, [bool]$On) { Add-Bytes $List ([byte[]](0x1B,0x61, $(if ($On) { 1 } else { 0 }))) }
function Add-Bold($List, [bool]$On) { Add-Bytes $List ([byte[]](0x1B,0x45, $(if ($On) { 1 } else { 0 }))) }
function Add-Big($List, [bool]$On) { Add-Bytes $List ([byte[]](0x1D,0x21, $(if ($On) { 0x11 } else { 0x00 }))) }

function Wrap-Text($Text, [int]$Width) {
  $words = (Convert-ToAscii $Text) -split '\s+'
  $lines = New-Object System.Collections.Generic.List[string]
  $cur = ''
  foreach ($w in $words) {
    if (-not $w) { continue }
    $next = if ($cur) { "$cur $w" } else { $w }
    if ($next.Length -gt $Width -and $cur) {
      $lines.Add($cur)
      $cur = $w
    } else {
      $cur = $next
    }
  }
  if ($cur) { $lines.Add($cur) }
  if ($lines.Count -eq 0) { $lines.Add('') }
  return @($lines)
}

function Convert-TicketToEscPos($Ticket, $Restaurant) {
  $list = New-Object System.Collections.Generic.List[byte]
  $width = 32
  Add-Bytes $list ([byte[]](0x1B,0x40))
  Add-Center $list $true
  Add-Bold $list $true
  Add-Big $list $true
  Add-TextLine $list ($(if ($Restaurant) { $Restaurant } elseif ($Ticket.restaurant) { $Ticket.restaurant } else { 'Gestiva' }))
  Add-Big $list $false
  Add-Bold $list $false
  Add-TextLine $list ('-' * $width)
  Add-Big $list $true
  Add-Bold $list $true
  Add-TextLine $list ($(if ($Ticket.table_num) { 'MESA ' + $Ticket.table_num } elseif ($Ticket.table) { 'MESA ' + $Ticket.table } else { 'PARA LLEVAR' }))
  Add-Big $list $false
  Add-Bold $list $false
  if ($Ticket.waiter_name -or $Ticket.waiter) { Add-TextLine $list ('Mozo: ' + ($(if ($Ticket.waiter_name) { $Ticket.waiter_name } else { $Ticket.waiter }))) }
  $dt = Get-Date
  try { if ($Ticket.created_at) { $dt = [DateTime]$Ticket.created_at } } catch {}
  Add-TextLine $list ($dt.ToString('dd/MM/yyyy HH:mm') + '  #' + ([string]$Ticket.id).Replace('-', '').Substring([Math]::Max(0, ([string]$Ticket.id).Replace('-', '').Length - 6)))
  Add-Center $list $false
  Add-TextLine $list ('-' * $width)
  Add-Bold $list $true
  foreach ($it in @($Ticket.items)) {
    $qty = if ($it.qty) { [string]$it.qty } else { '1' }
    $name = if ($it.name) { [string]$it.name } else { 'Producto' }
    $prefix = "$qty" + 'x '
    $lines = @(Wrap-Text $name ($width - $prefix.Length))
    Add-TextLine $list ($prefix + $lines[0])
    for ($i = 1; $i -lt $lines.Length; $i++) { Add-TextLine $list ((' ' * $prefix.Length) + $lines[$i]) }
    Add-Bold $list $false
    foreach ($m in @($it.modifiers)) {
      foreach ($line in @(Wrap-Text ('+ ' + $m) ($width - 2))) { Add-TextLine $list ('  ' + $line) }
    }
    if ($it.notes) {
      foreach ($line in @(Wrap-Text ('! ' + ([string]$it.notes).ToUpperInvariant()) ($width - 2))) { Add-TextLine $list ('  ' + $line) }
    }
    Add-Bold $list $true
  }
  Add-Bold $list $false
  Add-TextLine $list ('-' * $width)
  Add-Center $list $true
  Add-TextLine $list '-- COCINA --'
  Add-Center $list $false
  Add-Bytes $list ([byte[]](0x0A,0x0A,0x0A,0x1D,0x56,0x42,0x00))
  return $list.ToArray()
}

function Send-PrinterBytes($Ip, $Port, [byte[]]$Bytes) {
  $printer = Connect-Tcp $Ip $Port 6000
  if ($printer -eq $null) { throw "No se pudo conectar a $Ip`:$Port" }
  try {
    $ns = $printer.GetStream()
    $ns.Write($Bytes, 0, $Bytes.Length)
    $ns.Flush()
    Start-Sleep -Milliseconds 250
  } finally {
    try { $printer.Close() } catch {}
  }
}

function Invoke-CloudPoll {
  $cfg = Get-AgentConfig
  if (-not $cfg.token -or -not $cfg.apiUrl -or -not $cfg.printerIp) { return }
  $api = ([string]$cfg.apiUrl).TrimEnd('/')
  $port = if ($cfg.printerPort) { [int]$cfg.printerPort } else { 9100 }
  try {
    $headers = @{ Authorization = 'Bearer ' + [string]$cfg.token }
    $tickets = Invoke-RestMethod -Uri ($api + '/api/kitchen') -Headers $headers -TimeoutSec 12
    $state = Get-AgentState
    $printed = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($id in @($state.printed)) { if ($id) { [void]$printed.Add([string]$id) } }
    if (-not $state.seededAt) {
      foreach ($t in @($tickets)) { if ($t.id) { [void]$printed.Add([string]$t.id) } }
      $state.seededAt = (Get-Date).ToString('o')
      $state.printed = @($printed)
      Save-AgentState $state
      Write-AgentLog 'cloud station seeded existing kitchen tickets'
      return
    }
    foreach ($t in @($tickets)) {
      if (-not $t.id) { continue }
      $id = [string]$t.id
      if ($printed.Contains($id)) { continue }
      $bytes = Convert-TicketToEscPos $t $cfg.restaurant
      Send-PrinterBytes ([string]$cfg.printerIp) $port $bytes
      [void]$printed.Add($id)
      $state.printed = @($printed)
      Save-AgentState $state
      Write-AgentLog "printed kitchen ticket $id"
    }
  } catch {
    Write-AgentLog "cloud poll error: $($_.Exception.Message)"
  }
}

function Parse-Query($Query) {
  $out = @{}
  if ([string]::IsNullOrWhiteSpace($Query)) { return $out }
  $Query.TrimStart('?').Split('&') | ForEach-Object {
    if (-not $_) { return }
    $kv = $_.Split('=', 2)
    $k = [uri]::UnescapeDataString($kv[0])
    $v = if ($kv.Length -gt 1) { [uri]::UnescapeDataString($kv[1]) } else { '' }
    $out[$k] = $v
  }
  return $out
}

function Send-Response($Stream, $StatusCode, $ContentType, $Body) {
  $reason = switch ($StatusCode) {
    200 { 'OK' }
    204 { 'No Content' }
    400 { 'Bad Request' }
    404 { 'Not Found' }
    500 { 'Server Error' }
    default { 'OK' }
  }
  $bodyBytes = [Text.Encoding]::UTF8.GetBytes([string]$Body)
  if ($StatusCode -eq 204) { $bodyBytes = [byte[]]@() }
  $headers = @(
    "HTTP/1.1 $StatusCode $reason",
    "Content-Type: $ContentType",
    "Content-Length: $($bodyBytes.Length)",
    "Cache-Control: no-store",
    "Access-Control-Allow-Origin: *",
    "Access-Control-Allow-Methods: POST, GET, OPTIONS",
    "Access-Control-Allow-Headers: Content-Type, Authorization",
    "Access-Control-Allow-Private-Network: true",
    "Connection: close",
    "",
    ""
  ) -join "`r`n"
  $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($bodyBytes.Length -gt 0) { $Stream.Write($bodyBytes, 0, $bodyBytes.Length) }
  $Stream.Flush()
}

function Send-Json($Stream, $StatusCode, $Object) {
  Send-Response $Stream $StatusCode 'application/json; charset=utf-8' ($Object | ConvertTo-Json -Depth 10 -Compress)
}

function Read-HttpRequest($Stream) {
  $buffer = New-Object byte[] 8192
  $ms = New-Object IO.MemoryStream
  $headerEnd = -1
  while ($true) {
    $read = $Stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { break }
    $ms.Write($buffer, 0, $read)
    $text = [Text.Encoding]::ASCII.GetString($ms.ToArray())
    $headerEnd = $text.IndexOf("`r`n`r`n")
    if ($headerEnd -ge 0) { break }
    if ($ms.Length -gt 1048576) { break }
  }
  $all = $ms.ToArray()
  $raw = [Text.Encoding]::UTF8.GetString($all)
  $headerText = if ($headerEnd -ge 0) { $raw.Substring(0, $headerEnd) } else { $raw }
  $lines = $headerText -split "`r`n"
  if ($lines.Length -lt 1) { return $null }
  $requestLine = $lines[0].Split(' ')
  if ($requestLine.Length -lt 2) { return $null }
  $headers = @{}
  for ($i = 1; $i -lt $lines.Length; $i++) {
    $idx = $lines[$i].IndexOf(':')
    if ($idx -gt 0) { $headers[$lines[$i].Substring(0, $idx).Trim().ToLowerInvariant()] = $lines[$i].Substring($idx + 1).Trim() }
  }
  $contentLength = 0
  if ($headers.ContainsKey('content-length')) { [void][int]::TryParse($headers['content-length'], [ref]$contentLength) }
  $bodyStart = if ($headerEnd -ge 0) { $headerEnd + 4 } else { $all.Length }
  $bodyBytes = New-Object System.Collections.Generic.List[byte]
  for ($i = $bodyStart; $i -lt $all.Length; $i++) { $bodyBytes.Add($all[$i]) }
  while ($bodyBytes.Count -lt $contentLength) {
    $read = $Stream.Read($buffer, 0, [Math]::Min($buffer.Length, $contentLength - $bodyBytes.Count))
    if ($read -le 0) { break }
    for ($i = 0; $i -lt $read; $i++) { $bodyBytes.Add($buffer[$i]) }
  }
  $body = if ($bodyBytes.Count -gt 0) { [Text.Encoding]::UTF8.GetString($bodyBytes.ToArray()) } else { '' }
  return [pscustomobject]@{ Method = $requestLine[0].ToUpperInvariant(); Target = $requestLine[1]; Headers = $headers; Body = $body }
}

function Get-SetupHtml {
  return @'
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Gestiva Print Station</title>
  <style>
    body{margin:0;background:#fff7ed;color:#0f172a;font-family:Inter,system-ui,Segoe UI,Arial,sans-serif}
    .wrap{max-width:760px;margin:0 auto;padding:28px 16px}
    .card{background:#fff;border:1px solid #fed7aa;border-radius:22px;box-shadow:0 18px 45px #9a34121f;padding:22px;margin:0 0 14px}
    h1{font-size:26px;margin:0 0 6px}.sub{color:#64748b;margin:0 0 18px;line-height:1.45}
    .status{display:flex;gap:10px;align-items:center;padding:12px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;margin:12px 0}
    .dot{width:12px;height:12px;border-radius:50%;background:#ef4444}.ok .dot{background:#22c55e}
    button{appearance:none;border:0;border-radius:13px;background:#f97316;color:#fff;font-weight:800;padding:13px 16px;cursor:pointer;width:100%;font-size:15px}
    button.secondary{background:#0f172a}button.ghost{background:#fff;color:#0f172a;border:1px solid #e2e8f0}
    input{width:100%;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:12px;padding:12px;font-size:15px}
    label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.05em;font-weight:800;color:#64748b;margin:16px 0 7px}
    .grid{display:grid;grid-template-columns:1fr 110px;gap:10px}.list{display:grid;gap:8px;margin-top:12px}
    .pick{background:#fff;color:#0f172a;border:1px solid #fed7aa;text-align:left}.muted{font-size:13px;color:#64748b;line-height:1.45}
    .msg{margin-top:12px;padding:12px;border-radius:12px;background:#f8fafc;color:#475569}.msg.err{background:#fef2f2;color:#b91c1c}.msg.ok{background:#ecfdf5;color:#047857}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Gestiva Print Station</h1>
      <p class="sub">Esta PC imprime las comandas automaticamente. El mozo solo envia el pedido; esta estacion busca la comandera y manda el ticket.</p>
      <div id="status" class="status"><span class="dot"></span><span>Revisando configuracion...</span></div>
      <p class="muted">Si llegaste desde Gestiva, la vinculacion se guarda sola. Despues toca buscar comandera.</p>
    </div>
    <div class="card">
      <h2>1. Buscar comandera</h2>
      <p class="muted">La comandera debe estar prendida y conectada al mismo WiFi o red que esta PC.</p>
      <button id="scan">Buscar comandera en la red</button>
      <div id="results" class="list"></div>
      <label>O escribir IP manual</label>
      <div class="grid"><input id="ip" placeholder="192.168.0.50"><input id="port" value="9100"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
        <button class="ghost" id="save">Guardar IP</button>
        <button class="secondary" id="test">Imprimir prueba</button>
      </div>
      <div id="msg" class="msg">Esperando accion.</div>
    </div>
  </div>
<script>
const $ = s => document.querySelector(s);
const msg = (t, ok) => { $('#msg').textContent=t; $('#msg').className='msg '+(ok?'ok':'err'); };
async function local(path, opts){
  const r = await fetch(path, Object.assign({headers:{'Content-Type':'application/json'}}, opts||{}));
  const text = await r.text(); const data = text ? JSON.parse(text) : {};
  if(!r.ok) throw new Error(data.error || 'error');
  return data;
}
async function refresh(){
  const c = await local('/config');
  $('#status').className = 'status ' + (c.configured ? 'ok' : '');
  $('#status span:last-child').textContent = c.configured
    ? 'Vinculada a ' + (c.restaurant || 'Gestiva') + (c.printerIp ? ' - comandera ' + c.printerIp + ':' + c.printerPort : ' - falta elegir comandera')
    : 'Todavia no esta vinculada. Volve a Gestiva y toca "Vincular esta PC".';
  if(c.printerIp) $('#ip').value = c.printerIp;
  if(c.printerPort) $('#port').value = c.printerPort;
}
async function pairFromHash(){
  const h = new URLSearchParams(location.hash.slice(1));
  if(!h.get('token')) return;
  await local('/pair',{method:'POST',body:JSON.stringify({
    token:h.get('token'), apiUrl:h.get('apiUrl'), restaurant:h.get('restaurant')
  })});
  history.replaceState(null,'','/setup');
  msg('PC vinculada. Ahora busca la comandera.', true);
}
$('#scan').onclick = async () => {
  $('#results').innerHTML = '<div class="muted">Buscando... puede tardar unos segundos.</div>';
  try {
    const data = await local('/scan?port=' + encodeURIComponent($('#port').value || '9100'));
    const printers = data.printers || [];
    if(!printers.length){ $('#results').innerHTML = '<div class="muted">No encontre comanderas. Podes escribir la IP manual de la impresora.</div>'; return; }
    $('#results').innerHTML = printers.map(ip => '<button class="pick" data-ip="'+ip+'">'+ip+'</button>').join('');
    document.querySelectorAll('.pick').forEach(b => b.onclick = async () => {
      $('#ip').value = b.dataset.ip;
      await saveIp();
      msg('Comandera guardada: ' + b.dataset.ip + '. Proba imprimir.', true);
      refresh();
    });
  } catch(e){ msg('No pude buscar comanderas: ' + e.message, false); }
};
async function saveIp(){
  await local('/config',{method:'POST',body:JSON.stringify({printerIp:$('#ip').value.trim(), printerPort:parseInt($('#port').value||'9100',10)})});
}
$('#save').onclick = async () => { try { await saveIp(); msg('IP guardada.', true); refresh(); } catch(e){ msg(e.message,false); } };
$('#test').onclick = async () => { try { await saveIp(); await local('/test',{method:'POST'}); msg('Prueba enviada. Revisa la comandera.', true); refresh(); } catch(e){ msg('No imprimio: '+e.message,false); } };
(async()=>{ try{ await pairFromHash(); await refresh(); } catch(e){ msg(e.message,false); try{ await refresh(); }catch(_){} } })();
</script>
</body>
</html>
'@
}

function Handle-Request($Stream, $Req) {
  $parts = $Req.Target.Split('?', 2)
  $path = $parts[0].TrimEnd('/')
  if ($path -eq '') { $path = '/' }
  $query = if ($parts.Length -gt 1) { Parse-Query $parts[1] } else { @{} }

  if ($Req.Method -eq 'OPTIONS') { Send-Response $Stream 204 'text/plain; charset=utf-8' ''; return }
  if ($Req.Method -eq 'GET' -and ($path -eq '/' -or $path -eq '/setup')) { Send-Response $Stream 200 'text/html; charset=utf-8' (Get-SetupHtml); return }
  if ($Req.Method -eq 'GET' -and ($path -eq '/health' -or $path -eq '/status')) {
    $cfg = Get-AgentConfig
    Send-Json $Stream 200 @{ ok = $true; bridge = 'gestiva-print-agent'; mode = 'station'; version = $AgentVersion; host = '127.0.0.1'; port = $Port; configured = [bool]($cfg.token -and $cfg.apiUrl); printerIp = $cfg.printerIp; printerPort = $(if ($cfg.printerPort) { $cfg.printerPort } else { 9100 }); subnets = @(Get-LocalSubnets) }
    return
  }
  if ($Req.Method -eq 'GET' -and $path -eq '/config') {
    $cfg = Get-AgentConfig
    Send-Json $Stream 200 @{ ok = $true; configured = [bool]($cfg.token -and $cfg.apiUrl); restaurant = $cfg.restaurant; apiUrl = $cfg.apiUrl; printerIp = $cfg.printerIp; printerPort = $(if ($cfg.printerPort) { $cfg.printerPort } else { 9100 }); pairedAt = $cfg.pairedAt }
    return
  }
  if ($Req.Method -eq 'POST' -and $path -eq '/pair') {
    $body = $Req.Body | ConvertFrom-Json
    if (-not $body.token -or -not $body.apiUrl) { Send-Json $Stream 400 @{ ok = $false; error = 'Falta la vinculacion desde Gestiva.' }; return }
    $current = Get-AgentConfig
    $cfg = [pscustomobject]@{
      token = [string]$body.token
      apiUrl = ([string]$body.apiUrl).TrimEnd('/')
      restaurant = if ($body.restaurant) { [string]$body.restaurant } else { $current.restaurant }
      printerIp = $current.printerIp
      printerPort = if ($current.printerPort) { [int]$current.printerPort } else { 9100 }
      pairedAt = (Get-Date).ToString('o')
    }
    Save-AgentConfig $cfg
    Reset-AgentState
    Send-Json $Stream 200 @{ ok = $true }
    return
  }
  if ($Req.Method -eq 'POST' -and $path -eq '/config') {
    $body = $Req.Body | ConvertFrom-Json
    if (-not $body.printerIp) { Send-Json $Stream 400 @{ ok = $false; error = 'Falta la IP de la comandera.' }; return }
    $cfg = Get-AgentConfig
    $cfg | Add-Member -Force -NotePropertyName printerIp -NotePropertyValue ([string]$body.printerIp)
    $cfg | Add-Member -Force -NotePropertyName printerPort -NotePropertyValue ($(if ($body.printerPort) { [int]$body.printerPort } else { 9100 }))
    Save-AgentConfig $cfg
    Send-Json $Stream 200 @{ ok = $true; printerIp = $cfg.printerIp; printerPort = $cfg.printerPort }
    return
  }
  if ($Req.Method -eq 'GET' -and $path -eq '/probe') {
    $ip = [string]$query['ip']
    $p = if ($query.ContainsKey('port')) { [int]$query['port'] } else { 9100 }
    if (-not $ip) { Send-Json $Stream 400 @{ ok = $false; reachable = $false; error = 'missing_ip' } }
    else { Send-Json $Stream 200 @{ ok = $true; reachable = (Test-Printer $ip $p 1800); ip = $ip; port = $p } }
    return
  }
  if ($Req.Method -eq 'GET' -and $path -eq '/scan') {
    $p = if ($query.ContainsKey('port')) { [int]$query['port'] } else { 9100 }
    $scan = Scan-Printers $p
    Send-Json $Stream 200 @{ ok = $true; port = $p; subnets = $scan.subnets; printers = $scan.printers }
    return
  }
  if ($Req.Method -eq 'POST' -and $path -eq '/test') {
    $cfg = Get-AgentConfig
    if (-not $cfg.printerIp) { Send-Json $Stream 400 @{ ok = $false; error = 'Primero elegi la IP de la comandera.' }; return }
    $ticket = [pscustomobject]@{ id = 'TEST01'; table_num = '5'; waiter_name = 'Prueba'; created_at = (Get-Date).ToString('o'); items = @([pscustomobject]@{ qty = 2; name = 'Milanesa napolitana'; modifiers = @('sin papas'); notes = 'bien cocida' }, [pscustomobject]@{ qty = 1; name = 'Coca-Cola 500ml'; modifiers = @(); notes = '' }) }
    $bytes = Convert-TicketToEscPos $ticket $cfg.restaurant
    Send-PrinterBytes ([string]$cfg.printerIp) ($(if ($cfg.printerPort) { [int]$cfg.printerPort } else { 9100 })) $bytes
    Send-Json $Stream 200 @{ ok = $true; bytes = $bytes.Length }
    return
  }
  if ($Req.Method -eq 'POST' -and $path -eq '/print') {
    $body = $Req.Body | ConvertFrom-Json
    if (-not $body.ip -or -not $body.data) { Send-Json $Stream 400 @{ ok = $false; error = 'missing_ip_or_data' }; return }
    $p = if ($body.port) { [int]$body.port } else { 9100 }
    $bytes = [Convert]::FromBase64String([string]$body.data)
    Send-PrinterBytes ([string]$body.ip) $p $bytes
    Send-Json $Stream 200 @{ ok = $true; ip = [string]$body.ip; port = $p; bytes = $bytes.Length }
    return
  }
  Send-Json $Stream 404 @{ ok = $false; error = 'not_found' }
}

$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Parse('127.0.0.1'), $Port)
try {
  $listener.Start()
} catch {
  Write-AgentLog "agent already running or port busy: $($_.Exception.Message)"
  exit 0
}

Write-AgentLog "Gestiva Print Station started on 127.0.0.1:$Port"
$nextPoll = (Get-Date).AddSeconds(2)

while ($true) {
  $client = $null
  try {
    if ($listener.Pending()) {
      $client = $listener.AcceptTcpClient()
      $client.ReceiveTimeout = 2500
      $client.SendTimeout = 5000
      $stream = $client.GetStream()
      $stream.ReadTimeout = 2500
      $stream.WriteTimeout = 5000
      $req = Read-HttpRequest $stream
      if ($req -eq $null) { Send-Json $stream 400 @{ ok = $false; error = 'bad_request' } }
      else { Handle-Request $stream $req }
    }
    if ((Get-Date) -ge $nextPoll) {
      Invoke-CloudPoll
      $nextPoll = (Get-Date).AddSeconds($PollSeconds)
    }
    Start-Sleep -Milliseconds 120
  } catch {
    try { if ($client -ne $null) { Send-Json $client.GetStream() 500 @{ ok = $false; error = $_.Exception.Message } } } catch {}
    Write-AgentLog "loop error: $($_.Exception.Message)"
  } finally {
    try { if ($client -ne $null) { $client.Close() } } catch {}
  }
}
