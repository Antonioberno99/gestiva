@echo off
setlocal
title Gestiva - Instalador de Comandera

set "APPDIR=%LOCALAPPDATA%\GestivaComandera"
set "AGENT=%APPDIR%\gestiva-print-agent.ps1"
set "STARTER=%APPDIR%\iniciar-gestiva-comandera.bat"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Gestiva Comandera.bat"
set "BASE=https://www.gestiva.site/assets/comandera-bridge"

echo ============================================
echo   Gestiva - Instalador de Comandera
echo ============================================
echo.
echo Este instalador configura la impresion de red en esta PC.
echo No requiere Node.js ni programas externos.
echo.

if not exist "%APPDIR%" mkdir "%APPDIR%"

echo Cerrando puente anterior si estaba activo...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:7777/health' -TimeoutSec 1; if($r.bridge -like 'gestiva-*'){ $p=(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if($p){ Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 } } } catch {}"

echo Descargando Gestiva Print Agent...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%BASE%/gestiva-print-agent.ps1' -OutFile '%AGENT%'"
if errorlevel 1 (
  echo.
  echo No se pudo descargar el agente de impresion.
  echo Revisa la conexion a internet y volve a intentar.
  pause
  exit /b 1
)

(
  echo @echo off
  echo start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%%LOCALAPPDATA%%\GestivaComandera\gestiva-print-agent.ps1"
) > "%STARTER%"

copy /Y "%STARTER%" "%STARTUP%" >nul

echo Iniciando Gestiva Print Agent...
start "" "%STARTER%"

echo Verificando conexion local...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 12;$i++){ try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:7777/health' -TimeoutSec 1; if($r.ok -and $r.bridge -eq 'gestiva-print-agent'){$ok=$true; break} } catch {}; Start-Sleep -Milliseconds 700 }; if($ok){ exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo.
  echo El agente se instalo, pero Gestiva todavia no pudo detectarlo.
  echo Reinicia la PC o ejecuta:
  echo %STARTER%
  echo.
  pause
  exit /b 1
)

echo.
echo Listo: Gestiva Print Agent esta activo.
echo.
echo Volve a Gestiva y toca "Conectar automaticamente".
echo.
pause
