@echo off
title Gestiva - Puente de Comandera
echo Iniciando el puente de comandera de Gestiva...
echo.
if exist "%~dp0gestiva-print-agent.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gestiva-print-agent.ps1"
  echo.
  echo El puente se cerro. Cerra esta ventana o volve a abrir el archivo para reiniciar.
  pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: No se encontro el agente de impresion ni Node.js.
  echo.
  echo Usa el instalador desde Gestiva:
  echo Comandera ^> Red/WiFi ^> Instalar / actualizar puente de comandera
  echo.
  pause
  exit /b 1
)

node "%~dp0comandera-bridge.js"
echo.
echo El puente se cerro. Cerra esta ventana o volve a abrir el archivo para reiniciar.
pause
