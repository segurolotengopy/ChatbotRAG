# Guía de puesta en marcha en Google Cloud (Vertex AI + Cloud Run)

Esta guía separa con claridad **lo que ejecuta el pipeline o Claude Code** de **lo que solo puede hacer el propietario** (autenticarse, aprobar, crear identidades). Los pasos marcados con 🔑 requieren su intervención directa; los demás los ejecuta el pipeline o una sesión de Claude Code con acceso al proyecto.

## 0. Qué se despliega

Un solo servicio Cloud Run (`chatbotrag`) que carga los agentes de `configuraciones/` al arrancar, indexa su corpus en memoria y atiende `/v1/...`. Vertex AI aporta el modelo (`gemini-2.5-flash`) y los embeddings (`text-embedding-005`) usando la **identidad de la cuenta de servicio de runtime**: no hay API key en ninguna parte.

```
Internet ─► Cloud Run (chatbotrag) ─► Vertex AI (Gemini, embeddings)
               │ SA de runtime            (mismo proyecto)
               └► Secret Manager (clientes, HMAC, [pgvector])
```

## 1. Proyecto y APIs 🔑

1. Crear (o elegir) los proyectos de **staging** y **producción**. Recomendación: dos proyectos separados, con facturación y presupuesto de alerta (20 USD/mes como en NovuChat) desde el primer día.
2. Habilitar en cada proyecto: `run.googleapis.com`, `aiplatform.googleapis.com`, `artifactregistry.googleapis.com`, `secretmanager.googleapis.com`, `iamcredentials.googleapis.com`, `cloudbuild.googleapis.com` (solo si se construye en la nube).

## 2. Identidad federada para GitHub Actions 🔑

Ejecutar el script del estándar **desde su equipo autenticado con `gcloud`**, una vez por proyecto:

```
~/SeguridadGeneral/03-scripts/setup-oidc-gcp.sh --proyecto <PROYECTO_STAGING> --repo segurolotengopy/ChatbotRAG --ambiente staging
~/SeguridadGeneral/03-scripts/setup-oidc-gcp.sh --proyecto <PROYECTO_PROD>    --repo segurolotengopy/ChatbotRAG --ambiente production
```

El script crea el Workload Identity Pool, el proveedor OIDC de GitHub (condición atada al repositorio **y** a la rama/entorno, porque el repositorio es público) y las cuentas de servicio de despliegue. Imprime los valores de `GCP_WIF_PROVIDER`, `GCP_SA_DEPLOY_STAGING` y `GCP_SA_DEPLOY_PROD`, que usted carga en **Settings → Secrets → Actions** del repositorio (el de producción como secreto del Environment `production`).

## 3. Cuenta de servicio de runtime (ejecuta el pipeline o Claude Code con acceso)

Por proyecto:

```
gcloud iam service-accounts create chatbotrag-run --display-name "ChatbotRAG runtime"
gcloud projects add-iam-policy-binding <PROYECTO> --member serviceAccount:chatbotrag-run@<PROYECTO>.iam.gserviceaccount.com --role roles/aiplatform.user
gcloud projects add-iam-policy-binding <PROYECTO> --member serviceAccount:chatbotrag-run@<PROYECTO>.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
```

Nada más: la SA de runtime no despliega ni administra. La SA de despliegue (creada en el paso 2) necesita `roles/run.admin`, `roles/artifactregistry.writer` y `roles/iam.serviceAccountUser` sobre la SA de runtime; el script del estándar lo deja configurado.

## 4. Secretos en Secret Manager

| Secreto | Contenido | Quién lo genera |
|---|---|---|
| `chatbotrag-clientes` | JSON de `CHATBOTRAG_CLIENTES` (ver `CONFIGURACION.md` §3) | Claude Code genera la clave aleatoria y su SHA-256 y le entrega **la clave** por canal seguro 🔑; el SHA-256 va al secreto. |
| `chatbotrag-hmac-herramientas` | cadena aleatoria ≥ 32 caracteres | ídem |
| `chatbotrag-pgvector-url` | cadena de conexión | solo si se usa pgvector |

Se declaran en la variable de Actions `CLOUD_RUN_SECRETS`, una línea por secreto: `CHATBOTRAG_CLIENTES=chatbotrag-clientes:latest`, `CHATBOTRAG_HMAC_HERRAMIENTAS=chatbotrag-hmac-herramientas:latest`.

## 5. Variables de Actions 🔑 (Settings → Variables → Actions)

```
MODO=A                      GHAS_ENABLED=false           NODE_VERSION=22
COVERAGE_MIN=70             HEALTH_PATH=/salud           BLOQUEAR_EN=CRITICAL,HIGH
WORKFLOW_PRODUCCION=ci-node-cloudrun.yml                 TAG_FIRMADO_REQUERIDO=false
GCP_PROJECT_ID_STAGING=<…>  GCP_PROJECT_ID_PROD=<…>      GCP_REGION=us-central1
ARTIFACT_REGISTRY_REPO=chatbotrag                        CLOUD_RUN_SERVICE=chatbotrag
CLOUD_RUN_SA_STAGING=chatbotrag-run@<STAGING>.iam.gserviceaccount.com
CLOUD_RUN_SA_PROD=chatbotrag-run@<PROD>.iam.gserviceaccount.com
CLOUD_RUN_SECRETS=<líneas VAR=secreto:version>
STAGING_URL=<URL de Cloud Run staging>                   PROD_URL=<URL de producción>
CODEQL_LENGUAJES=javascript-typescript
```

Las variables de entorno **no secretas** del servicio (`GCP_PROYECTO`, `GCP_REGION`, `CHATBOTRAG_INDICE`, `PUERTO=8080`) se fijan en el despliegue de Cloud Run; el `deploy.sh` del estándar las toma del manifiesto y de `CONFIGURACION.local.md`.

## 6. Primer despliegue

1. Fusionar el PR `chore/estandar-devsecops` en `main` (usted 🔑). El push a `main` dispara `ci-node-cloudrun.yml`: calidad → seguridad estática → construcción de la imagen (Trivy, SBOM, firma cosign) → despliegue a **staging** → DAST y humo contra `${STAGING_URL}/salud`.
2. Verificar en staging (Claude Code puede hacerlo si tiene la clave del cliente de pruebas):
   - `GET /salud` → `{ ok: true, agentes: [{ id: "segurolotengo", proveedor: "vertex", indice: "memoria", perfiles: 4 }, …] }`.
   - `GET /v1/agente` con `Authorization: Bearer <clave>` → perfiles y bienvenidas.
   - `POST /v1/conversaciones/web_prueba0001/mensajes` con `{ "perfilId": "VIDA_ONCOLOGICO", "texto": "¿Cuál es la carencia por cáncer?" }` → respuesta con `respaldo` citando «Coberturas, exclusiones y condiciones… v1.0».
   - Los 200 casos de la Fase 4 de la especificación de Terra: `scripts/simular-conversacion.mts` es la base; contra el servicio real se corren con el cliente de `@chatbotrag/canal-web`.
3. Producción: `/pase-a-produccion` prepara el acta; usted crea el tag `vX.Y.Z` y aprueba el Environment 🔑. El despliegue es canario (10 % → 100 %) con rollback automático si `/salud` falla.

## 7. Conectar el demo SeguroLoTengo

1. En Secrets Manager de AWS, agregar la clave `CHATBOTRAG_TOKEN` al secreto `slt-demo-app-secrets` con **la clave** del cliente `segurolotengo-web` 🔑 (Terraform tiene `ignore_changes`; es manual, como el token de WhatsApp-Modular).
2. En Amplify, variables `ASISTENTE_ENABLED=true`, `INTEGRATION_ASISTENTE=live`, `CHATBOTRAG_URL=<PROD_URL>` 🔑.
3. En `CHATBOTRAG_CLIENTES`, el cliente `segurolotengo-web` debe tener en `origenes` el dominio del sitio solo si el navegador llamara directo; con la ruta intermedia `/api/asistente/*` **no hace falta** (el servidor de Amplify es quien llama).

## 8. Costos orientativos

Gemini 2.5 Flash con un prompt de ~3 000 tokens y respuestas de ~200: fracciones de centavo por mensaje; 10 000 conversaciones breves al mes quedan en el orden de 10–30 USD de modelo más el mínimo de Cloud Run (escala a cero). Las palancas de costo son las de NovuChat: ventana de memoria (`modelo.ventanaMemoria`), tiempo de vida de la conversación (`ttlConversacionSeg`), tope de tokens de salida y `maxIteraciones`.

## 9. Qué NO hace este despliegue

- No persiste conversaciones (memoria en proceso con TTL). Con más de una instancia de Cloud Run, la memoria es por instancia: fijar `--max-instances 1` para el piloto o reemplazar `MemoriaEnProceso` por Firestore/Redis detrás del mismo puerto.
- No indexa en Vertex AI Search: el índice es en memoria (recarga en cada arranque, segundos para decenas de documentos) o pgvector.
- No tiene panel de configuración: los JSON se editan en el repositorio y pasan por PR (validados en CI).
