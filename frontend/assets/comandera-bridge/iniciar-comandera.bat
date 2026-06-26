@echo off
title Gestiva - Puente de Comandera
echo Iniciando el puente de comandera de Gestiva...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js no esta instalado o no esta en el PATH.
  echo.
  echo Para usar la comandera de red:
  echo 1. Instala Node.js LTS desde https://nodejs.org
  echo 2. Cierra esta ventana
  echo 3. Volve a abrir iniciar-comandera.bat
  echo.
  pause
  exit /b 1
)

node "%~dp0comandera-bridge.js"
echo.
echo El puente se cerro. Cerra esta ventana o volve a abrir el archivo para reiniciar.
pause
