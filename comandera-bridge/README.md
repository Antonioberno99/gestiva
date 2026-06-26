# Gestiva Print Agent - Comandera de red

Las impresoras de comandas por red/WiFi usan normalmente ESC/POS por IP, casi siempre en el puerto `9100`.
Por seguridad, el navegador no puede hablar directo con una impresora de la red local. Por eso Gestiva usa un
agente local en la PC del negocio:

`Gestiva web -> Gestiva Print Agent en esta PC -> comandera IP:9100`

## Instalacion recomendada para clientes

1. En Gestiva abrir **Comandera**.
2. Elegir **Red / WiFi**.
3. Tocar **Instalar / actualizar puente de comandera**.
4. Abrir el archivo descargado.
5. Cuando diga que esta listo, volver a Gestiva.
6. Tocar **Buscar comanderas en la red**.
7. Elegir la IP encontrada.
8. Tocar **Imprimir prueba**.

El instalador:

- no requiere Node.js;
- guarda el agente en `%LOCALAPPDATA%\GestivaComandera`;
- lo inicia automaticamente;
- lo deja configurado para abrir con Windows.

## Instalacion manual

En esta carpeta, doble clic en:

`iniciar-comandera.bat`

Si existe `gestiva-print-agent.ps1`, se usa ese agente sin dependencias. `comandera-bridge.js` queda como fallback tecnico para desarrollo.

## Como saber la IP de una comandera

- Muchas impresoras imprimen una hoja de configuracion si se prende manteniendo apretado el boton de avance.
- Tambien se puede ver la IP desde el router.
- Gestiva puede buscar automaticamente IPs que tengan el puerto `9100` abierto.

## Importante

- La PC donde corre el agente debe estar en la misma red que la impresora.
- Para que imprima automaticamente las comandas de los mozos, usar una PC fija como estacion de impresion.
- Los celulares de los mozos mandan el pedido a Gestiva; la PC fija lo imprime.
