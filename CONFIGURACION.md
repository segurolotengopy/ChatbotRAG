# Configuración por ambiente (plantilla pública)

Este archivo documenta **qué** se configura y **dónde**. Los valores reales van en
`CONFIGURACION.local.md` (ignorado por git) y en los almacenes de secretos; acá
solo hay marcadores `${...}`. Convención heredada de NovuChat: si un valor real
apareciera en este archivo, `gitleaks` y la revisión del PR lo bloquean.

## 1. Servicio (variables de entorno del contenedor)

| Variable | Obligatoria | Valor | Notas |
|---|---|---|---|
| `PUERTO` | no | `8080` | Cloud Run inyecta `PORT`; el servicio lee `PUERTO` (mapear en el despliegue: `PUERTO=8080`). |
| `CHATBOTRAG_DIR_CONFIGURACIONES` | no | `./configuraciones` | Carpeta con los `*.json` de agentes y su `corpus/`. En la imagen se copia la carpeta del repo. |
| `CHATBOTRAG_CLIENTES` | **sí** | JSON | Lista de clientes autorizados. **Solo el SHA-256 de cada clave**, nunca la clave. Ver §3. |
| `CHATBOTRAG_PROVEEDOR_FORZADO` | no | `simulado` | Fuerza el proveedor simulado en todos los agentes (desarrollo, pruebas, demos sin nube). Vacío en staging/producción. |
| `CHATBOTRAG_INDICE` | no | `memoria` \| `pgvector` | `pgvector` exige `PGVECTOR_URL`. |
| `PGVECTOR_URL` | si pgvector | `postgres://…` | Cadena de conexión; en Cloud Run va como secreto (`--set-secrets`). |
| `CHATBOTRAG_LIMITE_IP_MINUTO` | no | `60` | Límite global por IP. |
| `CHATBOTRAG_HMAC_HERRAMIENTAS` | no | secreto ≥ 16 car. | Firma HMAC de las llamadas a herramientas `http`. Secreto. |
| `GCP_PROYECTO` | si vertex | `${GCP_PROYECTO}` | Proyecto donde está habilitada la API de Vertex AI. |
| `GCP_REGION` | no | `us-central1` | Región de Vertex AI (Gemini y `text-embedding-005` están disponibles en `us-central1`). |
| `AWS_REGION` | si bedrock | `us-east-1` | Región de Bedrock. |
| `NODE_ENV` | no | `production` | La imagen ya lo fija. |

Credenciales de nube: **no hay variable**. Vertex usa Application Default Credentials
(la cuenta de servicio de Cloud Run); Bedrock usa la cadena estándar del SDK (rol de la
tarea). En local: `gcloud auth application-default login` o un perfil de AWS.

## 2. Agentes (`configuraciones/*.json`)

Cada archivo es un agente validado contra `paquetes/nucleo/esquemas/configuracion-agente.schema.json`.
Los ejemplos del repo se despliegan tal cual; para un cliente real se copia y se ajusta:

| Sección | Qué se ajusta por ambiente |
|---|---|
| `modelo.proveedor` / `modelo.nombre` | `vertex` + `gemini-2.5-flash` (GCP) · `bedrock` + `anthropic.claude-haiku-4-5-…` (AWS). El nombre exacto del modelo se toma del catálogo de la nube el día del despliegue; un nombre retirado devuelve 404. |
| `modelo.modeloEmbeddings` | `text-embedding-005` (Vertex, 768) · `amazon.titan-embed-text-v2:0` (Bedrock, 1024). Cambiarlo con pgvector implica reindexar (`vector(N)` en `sql/001-esquema.sql`). |
| `operacion.contactoHumano` | Datos reales del cliente (se muestran a las personas). |
| `conocimiento.fuentes` | Rutas dentro de `configuraciones/corpus/`. Solo `visibilidad: publico` se indexa. |

Validar antes de desplegar: `pnpm validar-config configuraciones/*.json`.

## 3. Clientes del servicio

Un cliente = quien llama al servicio (el sitio web, el puente de WhatsApp, la app). Se genera una
clave aleatoria (≥ 32 caracteres), se guarda **la clave** en el almacén de secretos del cliente
(p. ej. Secrets Manager del demo, clave `CHATBOTRAG_TOKEN`) y **su SHA-256** en `CHATBOTRAG_CLIENTES`:

```json
[
  { "id": "segurolotengo-web", "agenteId": "segurolotengo", "claveSha256": "${SHA256_CLAVE_SLT}", "origenes": ["https://${DOMINIO_SLT}"], "limitePorMinuto": 600 },
  { "id": "salon-demo-whatsapp", "agenteId": "salon-clinica-demo", "claveSha256": "${SHA256_CLAVE_SALON}", "limitePorMinuto": 300 }
]
```

`CHATBOTRAG_CLIENTES` va como **secreto** de Cloud Run aunque no contenga la clave en claro:
revela qué agentes existen y qué orígenes se aceptan.

## 4. Google Cloud (ambiente de referencia)

| Recurso | Staging | Producción |
|---|---|---|
| Proyecto | `${GCP_PROYECTO_STAGING}` | `${GCP_PROYECTO_PROD}` |
| Región | `us-central1` | `us-central1` |
| Servicio Cloud Run | `chatbotrag` | `chatbotrag` |
| Artifact Registry | `${GCP_REGION}-docker.pkg.dev/${GCP_PROYECTO_STAGING}/chatbotrag/chatbotrag` (único; producción lee) | ídem |
| SA de runtime | `chatbotrag-run@${GCP_PROYECTO_STAGING}.iam.gserviceaccount.com` (`roles/aiplatform.user`, `roles/secretmanager.secretAccessor`) | ídem en prod |
| Secretos en Secret Manager | `chatbotrag-clientes`, `chatbotrag-hmac-herramientas`, (`chatbotrag-pgvector-url`) | ídem |
| URL | `${URL_STAGING}` | `${URL_PROD}` |

Los valores reales, una vez creados, van en `CONFIGURACION.local.md` y en las **Variables de Actions**
del repositorio (`GCP_PROJECT_ID_STAGING`, `GCP_PROJECT_ID_PROD`, `GCP_REGION`, `ARTIFACT_REGISTRY_REPO`,
`CLOUD_RUN_SERVICE`, `CLOUD_RUN_SA_*`, `CLOUD_RUN_SECRETS`, `STAGING_URL`, `PROD_URL`, `HEALTH_PATH=/salud`).
Secretos de Actions: `GCP_WIF_PROVIDER`, `GCP_SA_DEPLOY_STAGING`, `GCP_SA_DEPLOY_PROD` (se generan con
`setup-oidc-gcp.sh` del estándar). Guía paso a paso: `docs/GUIA-DESPLIEGUE-GCP.md`.

## 5. Integración en segurolotengo-demo

| Dónde | Variable | Valor |
|---|---|---|
| Amplify (entorno) | `ASISTENTE_ENABLED` | `true` |
| Amplify (entorno) | `INTEGRATION_ASISTENTE` | `live` (por defecto `mock`) |
| Amplify (entorno) | `CHATBOTRAG_URL` | `${URL_PROD}` |
| Secrets Manager `slt-demo-app-secrets` | `CHATBOTRAG_TOKEN` | la clave del cliente `segurolotengo-web` |
