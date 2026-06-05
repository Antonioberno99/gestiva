@echo off
title Gestiva - Puente de Comandera
echo Iniciando el puente de comandera de Gestiva...
echo.
node "%~dp0comandera-bridge.js"
echo.
echo El puente se cerro. Cerra esta ventana o volve a abrir el archivo para reiniciar.
pause
