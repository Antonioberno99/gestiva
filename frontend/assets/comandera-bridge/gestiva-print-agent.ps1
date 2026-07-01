param(
  [int]$Port = 7777
)

$ErrorActionPreference = 'Continue'
$AppDir = Join-Path $env:LOCALAPPDATA 'GestivaComandera'
$ConfigFile = Join-Path $AppDir 'config.json'
$StateFile = Join-Path $AppDir 'state.json'
$LogFile = Join-Path $AppDir 'agent.log'
$PollSeconds = 4
$AgentVersion = '3.2.0'
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

# Nombre de la WiFi a la que esta conectada esta PC (para avisar si esta en la red equivocada)
function Get-CurrentWifi {
  try {
    $out = netsh wlan show interfaces 2>$null
    foreach ($line in $out) {
      if ($line -match '^\s*SSID\s*:\s*(.+?)\s*$') { return $Matches[1].Trim() }
    }
  } catch {}
  return ''
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
  $candidates = New-Object System.Collections.Generic.List[object]
  $scanPorts = @($Port, 9100, 9101, 9102, 515, 631, 8008, 8043, 8080, 9080, 80, 443) | Select-Object -Unique
  foreach ($prefix in $subnets) {
    $items = New-Object System.Collections.Generic.List[object]
    for ($h = 1; $h -le 254; $h++) {
      $ip = "$prefix.$h"
      foreach ($sp in $scanPorts) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
          $async = $client.BeginConnect($ip, $sp, $null, $null)
          $items.Add([pscustomobject]@{ Ip = $ip; Port = $sp; Client = $client; Async = $async })
        } catch {
          try { $client.Close() } catch {}
        }
      }
    }
    Start-Sleep -Milliseconds 2600
    $openByIp = @{}
    foreach ($item in $items) {
      try {
        if ($item.Async.AsyncWaitHandle.WaitOne(0, $false) -and $item.Client.Connected) {
          try { $item.Client.EndConnect($item.Async) } catch {}
          if (-not $openByIp.ContainsKey($item.Ip)) {
            $openByIp[$item.Ip] = @()
          }
          $openByIp[$item.Ip] = @($openByIp[$item.Ip]) + [int]$item.Port
        }
      } catch {}
      try { $item.Client.Close() } catch {}
    }
    foreach ($ip in $openByIp.Keys) {
      $ports = @(@($openByIp[$ip]) | Sort-Object -Unique)
      $hasRaw = @($ports | Where-Object { $_ -eq $Port -or $_ -eq 9100 -or $_ -eq 9101 -or $_ -eq 9102 }).Count -gt 0
      $hasPrinterLike = $hasRaw -or @($ports | Where-Object { $_ -eq 515 -or $_ -eq 631 -or $_ -eq 8008 -or $_ -eq 8043 }).Count -gt 0
      if ($hasRaw -and -not $printers.Contains($ip)) { $printers.Add($ip) }
      $candidates.Add([pscustomobject]@{
        ip = $ip
        ports = $ports
        likelyPrinter = [bool]$hasPrinterLike
      })
    }
  }
  return @{ subnets = $subnets; printers = @($printers.ToArray()); candidates = @($candidates.ToArray()); scannedPorts = @($scanPorts) }
}

function Get-WindowsPrinters {
  $out = New-Object System.Collections.Generic.List[object]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $addPrinter = {
    param($Name, $Driver, $Port, $Default, $Network, $Local, $Status, $WorkOffline)
    if ([string]::IsNullOrWhiteSpace($Name)) { return }
    if (-not $seen.Add([string]$Name)) { return }
    $virtual = ($Name -match 'PDF|XPS|OneNote|Fax') -or ($Driver -match 'PDF|XPS|OneNote|Fax') -or ($Port -match 'PORTPROMPT|NUL')
    $usb = ($Port -match 'USB|DOT4') -or ([bool]$Local -and -not [bool]$Network -and -not $virtual)
    $likely = -not $virtual -and (($Name -match 'EPSON|TM-|TMT|POS|Receipt|Thermal|Comanda|Ticket') -or ($Driver -match 'EPSON|TM-|TMT|POS|Receipt|Thermal|Generic / Text') -or $usb)
    $out.Add([pscustomobject]@{
      name = [string]$Name
      driver = [string]$Driver
      port = [string]$Port
      isDefault = [bool]$Default
      isNetwork = [bool]$Network
      isUsb = [bool]$usb
      isVirtual = [bool]$virtual
      likelyComandera = [bool]$likely
      status = [string]$Status
      workOffline = [bool]$WorkOffline
    })
  }
  try {
    Get-CimInstance Win32_Printer | ForEach-Object {
      & $addPrinter $_.Name $_.DriverName $_.PortName $_.Default $_.Network $_.Local $_.PrinterStatus $_.WorkOffline
    }
  } catch {
    Write-AgentLog "windows printers cim error: $($_.Exception.Message)"
  }
  try {
    Get-Printer | ForEach-Object {
      & $addPrinter $_.Name $_.DriverName $_.PortName $false $false $true $_.PrinterStatus $false
    }
  } catch {
    Write-AgentLog "windows printers get-printer error: $($_.Exception.Message)"
  }
  try {
    try { Add-Type -AssemblyName System.Drawing.Common -ErrorAction SilentlyContinue } catch {}
    try { Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue } catch {}
    [System.Drawing.Printing.PrinterSettings]::InstalledPrinters | ForEach-Object {
      & $addPrinter ([string]$_) '' '' $false $false $true '' $false
    }
  } catch {
    Write-AgentLog "windows printers dotnet error: $($_.Exception.Message)"
  }
  return @($out.ToArray())
}

function Get-SuggestedWindowsPrinter($Printers) {
  $items = @($Printers)
  $pick = @($items | Where-Object { $_.likelyComandera -and $_.isDefault } | Select-Object -First 1)
  if ($pick.Count -gt 0) { return $pick[0] }
  $pick = @($items | Where-Object { $_.likelyComandera -and $_.isUsb } | Select-Object -First 1)
  if ($pick.Count -gt 0) { return $pick[0] }
  $pick = @($items | Where-Object { $_.likelyComandera } | Select-Object -First 1)
  if ($pick.Count -gt 0) { return $pick[0] }
  $pick = @($items | Where-Object { -not $_.isVirtual } | Select-Object -First 1)
  if ($pick.Count -gt 0) { return $pick[0] }
  return $null
}

# Impresoras USB fisicamente conectadas pero SIN instalar como cola de Windows.
# Truco: cada puerto USBnnn trae en su Description el modelo del equipo conectado.
# Si ese puerto no lo usa ninguna impresora instalada, hay una USB lista para instalar.
function Get-UsbPrinterInfo {
  $installed = @(); try { $installed = @(Get-Printer -ErrorAction SilentlyContinue) } catch {}
  $usedPorts = @($installed | ForEach-Object { $_.PortName })
  $usbPorts = @(); try { $usbPorts = @(Get-PrinterPort -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^USB\d+' }) } catch {}
  $pending = New-Object System.Collections.Generic.List[object]
  foreach ($p in $usbPorts) {
    if ($usedPorts -notcontains $p.Name) {
      $desc = [string]$p.Description
      if ([string]::IsNullOrWhiteSpace($desc)) { $desc = 'Impresora USB' }
      $pending.Add([pscustomobject]@{ port = $p.Name; device = $desc })
    }
  }
  return @($pending.ToArray())
}

# Crea la cola de impresion para una USB conectada, con driver "Generic / Text Only"
# (deja pasar el ESC/POS crudo tal cual). Devuelve el nombre de la impresora instalada.
function Install-UsbPrinter($PortName) {
  $usbPorts = @(Get-PrinterPort -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^USB\d+' })
  $usedPorts = @(Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { $_.PortName })
  $target = $null
  if ($PortName) { $target = @($usbPorts | Where-Object { $_.Name -eq $PortName })[0] }
  if (-not $target) { $target = @($usbPorts | Where-Object { $usedPorts -notcontains $_.Name })[0] }
  if (-not $target) { throw 'No hay ninguna impresora USB conectada sin instalar.' }
  if (-not (Get-PrinterDriver -Name 'Generic / Text Only' -ErrorAction SilentlyContinue)) {
    Add-PrinterDriver -Name 'Generic / Text Only'
  }
  $base = [string]$target.Description
  if ([string]::IsNullOrWhiteSpace($base)) { $base = 'Comandera USB' }
  $base = ($base -replace '^EPSON(?=TM)', 'EPSON ').Trim()
  $name = $base; $n = 1
  while (@(Get-Printer -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { $n++; $name = "$base ($n)" }
  Add-Printer -Name $name -DriverName 'Generic / Text Only' -PortName $target.Name
  return $name
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

function Ensure-RawPrinterApi {
  if ('GestivaRawPrinter' -as [type]) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class GestivaRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

  public static void SendBytes(string printerName, byte[] bytes) {
    IntPtr hPrinter = IntPtr.Zero;
    IntPtr pBytes = IntPtr.Zero;
    bool docStarted = false;
    bool pageStarted = false;
    try {
      if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
        throw new Exception("OpenPrinter failed: " + Marshal.GetLastWin32Error());
      }
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "Gestiva Comanda";
      di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, di)) {
        throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
      }
      docStarted = true;
      if (!StartPagePrinter(hPrinter)) {
        throw new Exception("StartPagePrinter failed: " + Marshal.GetLastWin32Error());
      }
      pageStarted = true;
      pBytes = Marshal.AllocCoTaskMem(bytes.Length);
      Marshal.Copy(bytes, 0, pBytes, bytes.Length);
      int written = 0;
      if (!WritePrinter(hPrinter, pBytes, bytes.Length, out written) || written != bytes.Length) {
        throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
      }
    } finally {
      if (pageStarted) { EndPagePrinter(hPrinter); }
      if (docStarted) { EndDocPrinter(hPrinter); }
      if (pBytes != IntPtr.Zero) { Marshal.FreeCoTaskMem(pBytes); }
      if (hPrinter != IntPtr.Zero) { ClosePrinter(hPrinter); }
    }
  }
}
"@
}

function Send-WindowsPrinterBytes($PrinterName, [byte[]]$Bytes) {
  if ([string]::IsNullOrWhiteSpace($PrinterName)) { throw 'Falta elegir la impresora USB de Windows.' }
  $printers = @(Get-WindowsPrinters)
  $exists = @($printers | Where-Object { $_.name -eq $PrinterName }).Count -gt 0
  if (-not $exists) { throw "No encontre la impresora '$PrinterName' instalada en Windows." }
  Ensure-RawPrinterApi
  [GestivaRawPrinter]::SendBytes([string]$PrinterName, $Bytes)
}

function Get-PrinterMode($Config) {
  if ($Config.printerMode) { return [string]$Config.printerMode }
  if ($Config.printerName) { return 'windows' }
  return 'network'
}

function Send-ConfiguredPrinterBytes($Config, [byte[]]$Bytes) {
  $mode = Get-PrinterMode $Config
  if ($mode -eq 'windows') {
    Send-WindowsPrinterBytes ([string]$Config.printerName) $Bytes
    return
  }
  if (-not $Config.printerIp) { throw 'Falta la IP de la comandera.' }
  $port = if ($Config.printerPort) { [int]$Config.printerPort } else { 9100 }
  Send-PrinterBytes ([string]$Config.printerIp) $port $Bytes
}

function Invoke-CloudPoll {
  $cfg = Get-AgentConfig
  $mode = Get-PrinterMode $cfg
  $hasPrinter = (($mode -eq 'windows' -and $cfg.printerName) -or ($mode -ne 'windows' -and $cfg.printerIp))
  if (-not $cfg.token -or -not $cfg.apiUrl -or -not $hasPrinter) { return }
  $api = ([string]$cfg.apiUrl).TrimEnd('/')
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
      Send-ConfiguredPrinterBytes $cfg $bytes
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
    Send-Json $Stream 200 @{ ok = $true; bridge = 'gestiva-print-agent'; mode = 'station'; version = $AgentVersion; host = '127.0.0.1'; port = $Port; configured = [bool]($cfg.token -and $cfg.apiUrl); printerMode = (Get-PrinterMode $cfg); printerName = $cfg.printerName; printerIp = $cfg.printerIp; printerPort = $(if ($cfg.printerPort) { $cfg.printerPort } else { 9100 }); subnets = @(Get-LocalSubnets) }
    return
  }
  if ($Req.Method -eq 'GET' -and $path -eq '/config') {
    $cfg = Get-AgentConfig
    Send-Json $Stream 200 @{ ok = $true; configured = [bool]($cfg.token -and $cfg.apiUrl); restaurant = $cfg.restaurant; apiUrl = $cfg.apiUrl; printerMode = (Get-PrinterMode $cfg); printerName = $cfg.printerName; printerIp = $cfg.printerIp; printerPort = $(if ($cfg.printerPort) { $cfg.printerPort } else { 9100 }); pairedAt = $cfg.pairedAt }
    return
  }
  if ($Req.Method -eq 'GET' -and $path -eq '/printers') {
    $printers = @(Get-WindowsPrinters)
    $suggested = Get-SuggestedWindowsPrinter $printers
    Send-Json $Stream 200 @{ ok = $true; printers = $printers; suggested = $suggested }
    return
  }
  if ($Req.Method -eq 'GET' -and $path -eq '/usb-detect') {
    # Impresoras USB: las conectadas-sin-instalar (para ofrecer instalarlas de una)
    $pending = @(Get-UsbPrinterInfo)
    $installedUsb = @(Get-WindowsPrinters | Where-Object { $_.isUsb -and -not $_.isVirtual })
    Send-Json $Stream 200 @{ ok = $true; pending = $pending; installed = $installedUsb }
    return
  }
  if ($Req.Method -eq 'POST' -and $path -eq '/usb-install') {
    try {
      $body = if ($Req.Body) { $Req.Body | ConvertFrom-Json } else { $null }
      $port = if ($body -and $body.port) { [string]$body.port } else { $null }
      $name = Install-UsbPrinter $port
      Send-Json $Stream 200 @{ ok = $true; printerName = $name }
    } catch {
      Send-Json $Stream 400 @{ ok = $false; error = $_.Exception.Message }
    }
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
      printerMode = if ($current.printerMode) { [string]$current.printerMode } elseif ($current.printerName) { 'windows' } else { 'network' }
      printerName = $current.printerName
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
    $cfg = Get-AgentConfig
    $printerMode = if ($body.printerMode) { [string]$body.printerMode } elseif ($body.printerName) { 'windows' } else { 'network' }
    if ($printerMode -eq 'windows') {
      if (-not $body.printerName) { Send-Json $Stream 400 @{ ok = $false; error = 'Falta elegir la impresora USB de Windows.' }; return }
      $name = [string]$body.printerName
      $exists = @((Get-WindowsPrinters) | Where-Object { $_.name -eq $name }).Count -gt 0
      if (-not $exists) { Send-Json $Stream 400 @{ ok = $false; error = "No encontre la impresora '$name' instalada en Windows." }; return }
      $cfg | Add-Member -Force -NotePropertyName printerMode -NotePropertyValue 'windows'
      $cfg | Add-Member -Force -NotePropertyName printerName -NotePropertyValue $name
      $cfg | Add-Member -Force -NotePropertyName printerIp -NotePropertyValue ''
      $cfg | Add-Member -Force -NotePropertyName printerPort -NotePropertyValue 9100
    } else {
      if (-not $body.printerIp) { Send-Json $Stream 400 @{ ok = $false; error = 'Falta la IP de la comandera.' }; return }
      $cfg | Add-Member -Force -NotePropertyName printerMode -NotePropertyValue 'network'
      $cfg | Add-Member -Force -NotePropertyName printerName -NotePropertyValue ''
      $cfg | Add-Member -Force -NotePropertyName printerIp -NotePropertyValue ([string]$body.printerIp)
      $cfg | Add-Member -Force -NotePropertyName printerPort -NotePropertyValue ($(if ($body.printerPort) { [int]$body.printerPort } else { 9100 }))
    }
    Save-AgentConfig $cfg
    Send-Json $Stream 200 @{ ok = $true; printerMode = (Get-PrinterMode $cfg); printerName = $cfg.printerName; printerIp = $cfg.printerIp; printerPort = $cfg.printerPort }
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
    Send-Json $Stream 200 @{ ok = $true; port = $p; wifi = (Get-CurrentWifi); subnets = $scan.subnets; printers = $scan.printers; candidates = $scan.candidates; scannedPorts = $scan.scannedPorts }
    return
  }
  if ($Req.Method -eq 'POST' -and $path -eq '/test') {
    $cfg = Get-AgentConfig
    $mode = Get-PrinterMode $cfg
    if ($mode -eq 'windows' -and -not $cfg.printerName) { Send-Json $Stream 400 @{ ok = $false; error = 'Primero elegi la impresora USB.' }; return }
    if ($mode -ne 'windows' -and -not $cfg.printerIp) { Send-Json $Stream 400 @{ ok = $false; error = 'Primero elegi la IP de la comandera.' }; return }
    $ticket = [pscustomobject]@{ id = 'TEST01'; table_num = '5'; waiter_name = 'Prueba'; created_at = (Get-Date).ToString('o'); items = @([pscustomobject]@{ qty = 2; name = 'Milanesa napolitana'; modifiers = @('sin papas'); notes = 'bien cocida' }, [pscustomobject]@{ qty = 1; name = 'Coca-Cola 500ml'; modifiers = @(); notes = '' }) }
    $bytes = Convert-TicketToEscPos $ticket $cfg.restaurant
    Send-ConfiguredPrinterBytes $cfg $bytes
    Send-Json $Stream 200 @{ ok = $true; mode = $mode; printerName = $cfg.printerName; printerIp = $cfg.printerIp; bytes = $bytes.Length }
    return
  }
  if ($Req.Method -eq 'POST' -and $path -eq '/print') {
    $body = $Req.Body | ConvertFrom-Json
    if (-not $body.data) { Send-Json $Stream 400 @{ ok = $false; error = 'missing_data' }; return }
    $bytes = [Convert]::FromBase64String([string]$body.data)
    if ($body.printerName) {
      Send-WindowsPrinterBytes ([string]$body.printerName) $bytes
      Send-Json $Stream 200 @{ ok = $true; printerName = [string]$body.printerName; bytes = $bytes.Length }
    } else {
      if (-not $body.ip) { Send-Json $Stream 400 @{ ok = $false; error = 'missing_ip_or_printerName' }; return }
      $p = if ($body.port) { [int]$body.port } else { 9100 }
      Send-PrinterBytes ([string]$body.ip) $p $bytes
      Send-Json $Stream 200 @{ ok = $true; ip = [string]$body.ip; port = $p; bytes = $bytes.Length }
    }
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
