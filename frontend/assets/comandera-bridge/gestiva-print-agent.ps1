param(
  [int]$Port = 7777
)

$ErrorActionPreference = 'Continue'
$AppDir = Join-Path $env:LOCALAPPDATA 'GestivaComandera'
$LogFile = Join-Path $AppDir 'agent.log'
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

function Write-AgentLog($Message) {
  try {
    Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  } catch {}
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
    Start-Sleep -Milliseconds 900
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
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Body)
  if ($StatusCode -eq 204) { $bodyBytes = [byte[]]@() }
  $headers = @(
    "HTTP/1.1 $StatusCode $reason",
    "Content-Type: $ContentType",
    "Content-Length: $($bodyBytes.Length)",
    "Cache-Control: no-store",
    "Access-Control-Allow-Origin: *",
    "Access-Control-Allow-Methods: POST, GET, OPTIONS",
    "Access-Control-Allow-Headers: Content-Type",
    "Access-Control-Allow-Private-Network: true",
    "Connection: close",
    "",
    ""
  ) -join "`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($bodyBytes.Length -gt 0) { $Stream.Write($bodyBytes, 0, $bodyBytes.Length) }
  $Stream.Flush()
}

function Send-Json($Stream, $StatusCode, $Object) {
  Send-Response $Stream $StatusCode 'application/json; charset=utf-8' ($Object | ConvertTo-Json -Depth 8 -Compress)
}

function Read-HttpRequest($Stream) {
  $buffer = New-Object byte[] 8192
  $ms = New-Object System.IO.MemoryStream
  $headerEnd = -1
  while ($true) {
    $read = $Stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { break }
    $ms.Write($buffer, 0, $read)
    $text = [System.Text.Encoding]::ASCII.GetString($ms.ToArray())
    $headerEnd = $text.IndexOf("`r`n`r`n")
    if ($headerEnd -ge 0) { break }
    if ($ms.Length -gt 1048576) { break }
  }

  $all = $ms.ToArray()
  $raw = [System.Text.Encoding]::UTF8.GetString($all)
  $headerText = if ($headerEnd -ge 0) { $raw.Substring(0, $headerEnd) } else { $raw }
  $lines = $headerText -split "`r`n"
  if ($lines.Length -lt 1) { return $null }
  $requestLine = $lines[0].Split(' ')
  if ($requestLine.Length -lt 2) { return $null }
  $headers = @{}
  for ($i = 1; $i -lt $lines.Length; $i++) {
    $idx = $lines[$i].IndexOf(':')
    if ($idx -gt 0) {
      $headers[$lines[$i].Substring(0, $idx).Trim().ToLowerInvariant()] = $lines[$i].Substring($idx + 1).Trim()
    }
  }

  $body = ''
  $contentLength = 0
  if ($headers.ContainsKey('content-length')) { [void][int]::TryParse($headers['content-length'], [ref]$contentLength) }
  $bodyStart = if ($headerEnd -ge 0) { $headerEnd + 4 } else { $all.Length }
  $haveBody = [Math]::Max(0, $all.Length - $bodyStart)
  $bodyBytes = New-Object System.Collections.Generic.List[byte]
  if ($haveBody -gt 0) {
    for ($i = $bodyStart; $i -lt $all.Length; $i++) { $bodyBytes.Add($all[$i]) }
  }
  while ($bodyBytes.Count -lt $contentLength) {
    $read = $Stream.Read($buffer, 0, [Math]::Min($buffer.Length, $contentLength - $bodyBytes.Count))
    if ($read -le 0) { break }
    for ($i = 0; $i -lt $read; $i++) { $bodyBytes.Add($buffer[$i]) }
  }
  if ($bodyBytes.Count -gt 0) { $body = [System.Text.Encoding]::UTF8.GetString($bodyBytes.ToArray()) }

  return [pscustomobject]@{
    Method = $requestLine[0].ToUpperInvariant()
    Target = $requestLine[1]
    Headers = $headers
    Body = $body
  }
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), $Port)
try {
  $listener.Start()
} catch {
  Write-AgentLog "agent already running or port busy: $($_.Exception.Message)"
  exit 0
}

Write-AgentLog "Gestiva Print Agent started on 127.0.0.1:$Port"

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $req = Read-HttpRequest $stream
    if ($req -eq $null) {
      Send-Json $stream 400 @{ ok = $false; error = 'bad_request' }
      continue
    }

    $parts = $req.Target.Split('?', 2)
    $path = $parts[0].TrimEnd('/')
    if ($path -eq '') { $path = '/' }
    $query = if ($parts.Length -gt 1) { Parse-Query $parts[1] } else { @{} }

    if ($req.Method -eq 'OPTIONS') {
      Send-Response $stream 204 'text/plain; charset=utf-8' ''
    } elseif ($req.Method -eq 'GET' -and $path -eq '/') {
      Send-Response $stream 200 'text/plain; charset=utf-8' "Gestiva Print Agent ACTIVO`n"
    } elseif ($req.Method -eq 'GET' -and ($path -eq '/health' -or $path -eq '/status')) {
      Send-Json $stream 200 @{ ok = $true; bridge = 'gestiva-print-agent'; version = '2.0.0'; host = '127.0.0.1'; port = $Port; subnets = @(Get-LocalSubnets) }
    } elseif ($req.Method -eq 'GET' -and $path -eq '/probe') {
      $ip = [string]$query['ip']
      $p = if ($query.ContainsKey('port')) { [int]$query['port'] } else { 9100 }
      if (-not $ip) { Send-Json $stream 400 @{ ok = $false; reachable = $false; error = 'missing_ip' } }
      else { Send-Json $stream 200 @{ ok = $true; reachable = (Test-Printer $ip $p 1800); ip = $ip; port = $p } }
    } elseif ($req.Method -eq 'GET' -and $path -eq '/scan') {
      $p = if ($query.ContainsKey('port')) { [int]$query['port'] } else { 9100 }
      $scan = Scan-Printers $p
      Send-Json $stream 200 @{ ok = $true; port = $p; subnets = $scan.subnets; printers = $scan.printers }
    } elseif ($req.Method -eq 'POST' -and $path -eq '/print') {
      $body = $req.Body | ConvertFrom-Json
      if (-not $body.ip -or -not $body.data) {
        Send-Json $stream 400 @{ ok = $false; error = 'missing_ip_or_data' }
        continue
      }
      $p = if ($body.port) { [int]$body.port } else { 9100 }
      $bytes = [Convert]::FromBase64String([string]$body.data)
      $printer = Connect-Tcp ([string]$body.ip) $p 6000
      if ($printer -eq $null) {
        Send-Json $stream 500 @{ ok = $false; error = "No se pudo conectar a $($body.ip):$p" }
        continue
      }
      try {
        $ns = $printer.GetStream()
        $ns.Write($bytes, 0, $bytes.Length)
        $ns.Flush()
        Start-Sleep -Milliseconds 250
        Send-Json $stream 200 @{ ok = $true; ip = [string]$body.ip; port = $p; bytes = $bytes.Length }
      } finally {
        try { $printer.Close() } catch {}
      }
    } else {
      Send-Json $stream 404 @{ ok = $false; error = 'not_found' }
    }
  } catch {
    try {
      if ($client -ne $null) { Send-Json $client.GetStream() 500 @{ ok = $false; error = $_.Exception.Message } }
    } catch {}
    Write-AgentLog "request error: $($_.Exception.Message)"
  } finally {
    try { if ($client -ne $null) { $client.Close() } } catch {}
  }
}
