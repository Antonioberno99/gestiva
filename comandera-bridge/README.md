# Gestiva Print Station

> ⚠️ **Los archivos que descargan los clientes son los de `frontend/assets/comandera-bridge/`.**
> Esta carpeta es solo una copia de referencia. Si tocás el agente, editá el de
> `frontend/assets/comandera-bridge/` (es el que se publica en
> `https://www.gestiva.site/assets/comandera-bridge/`) y despues copiá el cambio acá.
> Las dos copias estuvieron desincronizadas hasta el 23/07/2026.

Gestiva usa una estacion local para imprimir comandas de red/WiFi.

Flujo profesional:

`Mozo -> Gestiva backend -> Gestiva Print Station en la PC fija -> comandera IP:9100`

La web publica no debe depender de imprimir directo desde el celular ni de hablar todo el tiempo con `localhost`.
El agente local queda instalado en la PC del negocio, busca la comandera, guarda la IP y consulta los tickets nuevos de cocina.

## Instalacion para clientes

1. En Gestiva abrir **Comandera**.
2. Elegir **Red / WiFi**.
3. Tocar **Instalar / actualizar estacion de impresion**.
4. Abrir el archivo descargado.
5. Volver a Gestiva y tocar **Vincular esta PC y buscar comandera**.
6. En el asistente local tocar **Buscar comandera en la red**.
7. Elegir la IP encontrada.
8. Tocar **Imprimir prueba**.

Despues de eso, los mozos solo envian pedidos a cocina. La PC fija imprime automaticamente.

## Que instala

- `gestiva-print-agent.ps1` en `%LOCALAPPDATA%\GestivaComandera`
- una tarea de inicio simple en la carpeta Startup de Windows
- configuracion local en `%LOCALAPPDATA%\GestivaComandera\config.json`

No requiere Node.js.

## Puertos

- Agente local: `127.0.0.1:7777`
- Comandera de red: normalmente `9100`

## Instalacion manual

En esta carpeta, doble clic en:

`iniciar-comandera.bat`

Luego abrir:

`http://127.0.0.1:7777/setup`
