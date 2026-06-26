@echo off
setlocal
title Gestiva - Instalador de Comandera

set "APPDIR=%LOCALAPPDATA%\GestivaComandera"
set "BRIDGE=%APPDIR%\comandera-bridge.js"
set "STARTER=%APPDIR%\iniciar-comandera.bat"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Gestiva Comandera.bat"
set "BASE=https://gestiva.site/assets/comandera-bridge"

echo ============================================
echo   Gestiva - Instalador de Comandera
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado.
  echo Intentando instalar Node.js LTS con winget...
  echo.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo No se encontro winget en esta PC.
    echo Instala Node.js LTS manualmente desde:
    echo https://nodejs.org
    echo.
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Node.js se instalo, pero Windows todavia no actualizo el PATH.
    echo Cerra esta ventana y volve a abrir el instalador una vez mas.
    pause
    exit /b 1
  )
  echo.
)

if not exist "%APPDIR%" mkdir "%APPDIR%"

echo Descargando puente de comandera...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%BASE%/comandera-bridge.js' -OutFile '%BRIDGE%'"
if errorlevel 1 (
  echo No se pudo descargar el puente.
  echo Revisa la conexion a internet y volve a intentar.
  pause
  exit /b 1
)

(
  echo @echo off
  echo title Gestiva - Puente de Comandera
  echo node "%%LOCALAPPDATA%%\GestivaComandera\comandera-bridge.js"
) > "%STARTER%"

copy /Y "%STARTER%" "%STARTUP%" >nul

echo.
echo Instalacion lista.
echo El puente se va a iniciar automaticamente con Windows.
echo Ahora lo abrimos para que Gestiva pueda detectar la comandera.
echo.
start "" "%STARTER%"
timeout /t 2 >nul

echo Volve a Gestiva y toca "Buscar comandera" o "Detectar conexion".
echo.
pause
