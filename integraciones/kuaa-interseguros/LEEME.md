# Plantillas de infraestructura y vigilancia de Kuaa (spin-off a Google Cloud de Interseguros)

Son plantillas revisables, sin identificadores de AAB1 ni secretos. Todo valor sale de
`parametros.ejemplo.env`: se copia a `parametros.local.env` (no se confirma) y se reemplazan los
marcadores `<...>`. Origen: bloques S3, S4 y S7 del plan del spin-off (16-nov-2026).

## Qué es cada archivo

| Archivo | Para qué |
|---|---|
| `parametros.ejemplo.env` | Variables con marcadores (`<PROYECTO>`, `<REGION>`...). Sin secretos. |
| `infra/crear-staging.sh` | Crea APIs, Artifact Registry, buckets (paquete y banco, versionados y privados), tres cuentas de servicio (ejecución, despliegue, carga), contenedor del secreto, WIF y el servicio Cloud Run (máx. 3 instancias). |
| `infra/deshacer-staging.sh` | Inverso, en orden contrario. Con `--ejecutar` exige `--confirmar-proyecto <ID>`. |
| `infra/verificar-staging.sh` | Solo lectura: confirma cada recurso y sus propiedades clave. |
| `workflows/*.plantilla` | CI con despliegue solo a staging (sin tráfico, prueba de humo, luego tráfico), monitoreo y reporte diario. Se copian a `.github/workflows/` quitando `.plantilla`. |
| `monitoreo/sondear.sh`, `reporte.sh` | Sonda (red A) y reporte diario. `RED-B.md` describe la red B externa. |

`crear` y `deshacer` son **modo seco por defecto**: solo imprimen los comandos. Actúan únicamente con
`--ejecutar`, que además se niega si queda un marcador `<...>`. `verificar` solo lee.

## Quién hace qué

- **Interseguros (una persona):** cuenta de facturación, proyecto de staging, rol para quien opere, Environment
  `production` y su aprobación, cuentas de Healthchecks.io y Better Stack, correo de alertas, presupuesto.
- **Claude (con botón de Andres por escritura):** correr `crear-staging.sh --ejecutar` con la identidad que
  Interseguros otorgue, cargar variables y secretos de GitHub, configurar monitoreo, subir paquete y banco
  con la cuenta de carga.
- Los roles están separados a propósito: quien sube a los buckets (`kuaa-carga`) no edita Cloud Run; quien
  despliega (`kuaa-despliegue`) no toca los buckets; el servicio (`kuaa-ejecucion`) solo lee.

## Cómo deshacer

`infra/deshacer-staging.sh --ejecutar --confirmar-proyecto <ID>` (borra servicio, WIF, cuentas, secreto, buckets
con todas sus versiones y el repositorio de imágenes). Un despliegue malo se revierte moviendo el tráfico a la
revisión anterior. Alternativa total: borrar el proyecto (periodo de gracia de Google: verificar en su documentación).

## Qué NO se probó

- Ningún comando se ejecutó contra Google Cloud ni GitHub. Se verificó sintaxis, `shellcheck`, el modo seco y la
  lógica con un `gcloud` simulado local; los nombres de indicadores de `gcloud` salen de memoria y deben
  confirmarse con `gcloud ... --help` en la primera corrida.
- Los workflows no se pasaron por `actionlint` (no está instalado en este equipo): solo se verificó que el YAML
  carga y que cada acción está fijada por SHA con su versión.
- No se confirmó que `POST /v1/kuaa/mensaje` sin clave devuelva 401 en el servicio real (la sonda y la prueba de
  humo lo suponen; el servicio está en cambio por otro frente).
- No se crean presupuesto, alertas ni exportación de facturación; no hay escaneo ni firma de imagen en el CI.
- `APP_ENV` y las variables de la vía de paquete validado dependen de lo que el servicio acepte tras el bloque S2.
