# Puente de Comandera — Gestiva (impresoras de red / IP)

¿Tenés una **impresora de comandas conectada por red (WiFi o cable, con su propia IP)**?
Los navegadores no pueden mandarle datos directo. Este puente lo resuelve: corre en la
PC del local y reenvía el pedido a la impresora.

> Si usás comandera **Bluetooth, USB, o "Por navegador"**, NO necesitás esto. Se imprime directo desde Gestiva.

## Requisitos
- Una PC con **Windows** (o Mac/Linux) en la **misma red** que la impresora.
- **Node.js** instalado → https://nodejs.org (botón verde "LTS").

## Cómo usarlo (Windows)
### Desde Gestiva (recomendado)
1. En Gestiva → **Comandera** → **Red / WiFi**.
2. Si es la primera vez en esa PC, tocá **Instalar puente de comandera**.
3. Abrí el archivo descargado y esperá a que termine.
4. Volvé a Gestiva y tocá **Buscar comanderas en la red**.

El instalador deja el puente configurado para abrirse solo con Windows.

### Instalación manual
1. Copiá esta carpeta `comandera-bridge` a la PC del local (ej: al Escritorio).
2. Doble clic en **`iniciar-comandera.bat`**.
   - Se abre una ventana negra que dice **"Puente de Comandera ACTIVO"**. **Dejala abierta.**
3. En Gestiva (app de mozo o panel principal) → botón **Comandera** → elegí **"Red / WiFi"**:
   - **IP de la impresora**: la que tiene tu impresora (ej. `192.168.0.50`).
   - **Puerto**: `9100` (el estándar; dejalo así salvo que tu impresora use otro).
4. Tocá **"Detectar conexión"**.
   - Si dice que el puente no está activo: abrí `iniciar-comandera.bat` y dejá la ventana abierta.
   - Si dice que la comandera no responde: revisá IP, WiFi/red y puerto.
5. También podés tocar **"Buscar comanderas en la red"** para que Gestiva encuentre IPs con puerto 9100 abierto.
6. Tocá **"Imprimir prueba"**. Si sale el ticket, listo.

## Cómo saber la IP de tu impresora
- En muchas impresoras térmicas: apagá, mantené apretado el botón de avance (feed) y prendé →
  imprime una hoja de prueba con la IP.
- O miralo en la lista de dispositivos de tu router.

## Importante
- La PC que corre el puente y la que usa Gestiva tienen que ser **la misma** (el puente escucha
  sólo en esta computadora por seguridad).
- Si cerrás la ventana negra, deja de imprimir por red. Volvé a abrir el `.bat`.
- Para que arranque solo con Windows: poné un acceso directo del `.bat` en la carpeta
  *Inicio* (`Win+R` → `shell:startup`).

## Mac / Linux
Abrí una terminal en esta carpeta y corré:
```
node comandera-bridge.js
```
