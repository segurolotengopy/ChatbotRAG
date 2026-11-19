# Red B del monitoreo (otro proveedor, independiente de GitHub)

La red A es `monitoreo.yml` (GitHub Actions, cada 30 min) con `sondear.sh`. La red B la crea una
persona de Interseguros en un servicio externo gratuito (p. ej. Better Stack Uptime; verificar
límites del plan gratuito en su documentación vigente). No hay script: es configuración del
servicio. Parámetros del monitor (no llevan secretos):

| Campo | Valor |
|---|---|
| URL | `https://<HOST_DEL_SERVICIO>/salud` |
| Tipo | HTTP, método GET, esperar código 200 y que el cuerpo contenga `"ok":true` |
| Frecuencia | cada 3 minutos (o la mínima del plan) |
| Aviso | correo de Interseguros, canal distinto de la red A |

Regla de incidente: se declara cuando fallan la red A y la red B en una ventana de unos 10 minutos.
Si solo falla una, es una alerta para investigar, no un incidente. El silencio de la red A lo avisa
Healthchecks.io (latido); el silencio del reporte diario también.
