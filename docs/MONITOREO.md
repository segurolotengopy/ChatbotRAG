# Monitoreo externo de staging

Política del 2026-10-11: ningún proceso operativo depende de la laptop del propietario, de la app de escritorio ni de una sesión de Claude; el silencio total también es una alerta; la alerta llega por un canal distinto del sistema vigilado. Costo: USD 0.

## Qué hay

| Pieza | Dónde vive | Qué hace |
|---|---|---|
| Sonda (red A) | GitHub Actions, `monitoreo-staging.yml`, cada 15 min (minutos 7, 22, 37 y 52) | `scripts/sondear-staging.sh`: `/salud` y `/health` en 200 con `"ok":true`, HSTS y CSP presentes, `GET /v1/agente` sin clave en 401, latencia |
| Latido | Healthchecks.io, chequeo `sonda-15min` (período 15 min, gracia 30 min) | Alerta por correo si la sonda falla (`/fail`) o **deja de llegar** |
| Sonda (red B) | Better Stack Uptime, cada 3 min a `/salud` | Segunda red, otro proveedor; alerta por correo |
| Reporte diario | GitHub Actions, `monitoreo-staging-reporte.yml`, 11:41 UTC | Comenta en el issue «Monitoreo staging» cuántas veces corrió la sonda; ping al chequeo `reporte-diario` (período 1 día, gracia 4 h) |

**Incidente** = fallan la red A y la red B dentro de unos 10 minutos. Si falla una sola, es **sospecha**: puede ser la sonda.

La sonda no usa la clave del cliente (no hace falta: un 401 sin clave prueba que el control de acceso sigue puesto) y no depende de Cloud Run, GCP ni n8n.

## Arranque en frío

El servicio escala a 0: la primera llamada tras inactividad tardó 10,7 s en la medición del 2026-10-12 y las siguientes 0,3 s. Por eso la sonda descarta como arranque en frío una primera respuesta de más de 8 s y mide la segunda (aviso sobre 3 s, fallo sobre 10 s), con tiempo de espera de 30 s y hasta 3 intentos separados 30 s antes de dar la falla.

## Lo que no cubre

- Producción: no existe; su URL está SIN CONFIRMAR en `.devsecops.yml`. Al crearla, repetir esta configuración con su propia URL.
- Vertex AI / Gemini: `/salud` no llama al modelo; una caída del modelo no se ve acá.
- La calidad de las respuestas.
- WhatsApp: no hay ruta gratuita verificada. Las alertas llegan por correo.

## Puesta en marcha (cada paso lo autoriza Andres)

Las claves nunca pasan por el chat ni por la línea de comandos: `scripts/configurar-monitoreo.sh` las lee de archivos de modo 600 y carga los UUID en GitHub por entrada estándar, sin imprimirlos.

1. Cuentas en Healthchecks.io y Better Stack (las crea Andres).
2. Andres crea en la web una clave de API de Healthchecks **con escritura** (Settings → API Access) y un token de API de Better Stack Uptime (Settings → API tokens): ningún script puede generarlas. Luego corre `scripts/guardar-claves-monitoreo.sh`, que las pide con entrada oculta, las verifica contra el servicio y las guarda con modo 600 en `~/.config/chatbotrag/` (`healthchecks-api-key` y `betterstack-api-token`).
3. `scripts/configurar-monitoreo.sh plan` (solo lee: lista los chequeos y monitores existentes, sin secretos). Se revisa qué hay de prueba para borrar.
4. `scripts/configurar-monitoreo.sh aplicar --borrar-hc NOMBRE --borrar-bs ID`, con `URL_STAGING` y `GH_CONFIG_DIR` de la cuenta propietaria del repositorio. Crea los chequeos `sonda-15min` y `reporte-diario`, la variable `URL_STAGING`, los secretos `HEALTHCHECKS_PING_SONDA` y `HEALTHCHECKS_PING_REPORTE` (el repositorio es público: los UUID son secretos, nunca variables) y el monitor de Better Stack; borra solo lo que se nombra. Es idempotente. Cargar secretos exige que Andres agregue antes una regla puntual de permiso para `gh secret set` y la retire después.
5. Crear el issue abierto «Monitoreo staging» (el reporte falla a propósito si no existe).
6. Activar el informe semanal por correo en Healthchecks. Disparar ambos workflows con `workflow_dispatch` y verificar el ping y el comentario.
7. Prueba de caída: apuntar una corrida manual a una URL inexistente y confirmar el correo. Prueba de silencio: desactivar la sonda un momento y confirmar que Healthchecks avisa; reactivarla.
8. Confirmar que los correos llegan al teléfono.

El host de la API de Better Stack se toma de `BS_HOST` (por omisión `https://uptime.betterstack.com`; la documentación oficial nombra también `incidents.betterstack.com`): la primera lectura con `plan` lo confirma.

## Límites del plan gratuito (consultados el 2026-10-12; releer al contratar)

- GitHub Actions: gratis en repositorios públicos. Si el repositorio pasara a privado, bajar la sonda a cada 30 min o más (2.000 min/mes del plan Free). **Los workflows programados se desactivan tras 60 días sin actividad del repositorio**: el latido lo detecta; reactivar con `gh workflow enable`.
- Healthchecks.io Hobbyist: 20 chequeos, 100 entradas de bitácora por chequeo (unas 25 h de pings cada 15 min; el historial largo lo da el issue diario). Sin SLA.
- Better Stack gratis: 10 monitores, chequeo cada 3 min, alertas por correo y Slack.

## Prueba

Las pruebas de `scripts/` (sonda, reporte y configuración) ejecutan los scripts de verdad con servidores y herramientas simulados. `scripts/sondear-staging.prueba.ts` ejecuta la sonda de verdad contra un servidor local y comprueba que pase cuando todo está bien y que falle cuando algo se rompe (200 distinto, cuerpo sin `ok`, falta de HSTS o CSP, `/v1/agente` abierto, servicio caído, arranque en frío, falla puntual con reintento, URL inválida). Corre con `pnpm pruebas`.
