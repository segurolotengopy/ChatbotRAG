#!/usr/bin/env bash
# CREAR LA INFRAESTRUCTURA DE STAGING DE KUAA (plantilla; §2.1 del plan del spin-off)
#
# Por defecto NO hace nada: imprime los comandos gcloud (--dry-run). Solo con --ejecutar actúa,
# y entonces lo hace con la identidad gcloud activa, que debe ser la que Interseguros otorgue.
# Cada escritura la autoriza una persona antes de correr con --ejecutar.
#
# Crea: APIs, Artifact Registry (con limpieza), dos buckets privados versionados, tres cuentas de
# servicio con roles separados (ejecución / despliegue / carga), el contenedor del secreto,
# Workload Identity Federation atado al repo y a main + tags v*, y el servicio de Cloud Run
# (máx. 3 instancias, mínimo 0) con las variables de §2.1.b.
# Idempotente: cada recurso se comprueba antes de crearse; los roles se reasignan sin error.
#
# Qué NO hace: no crea cuenta de facturación ni proyecto (los crea una persona de Interseguros),
# no vincula presupuesto ni alertas, no crea el Environment `production` de GitHub, no escribe
# valores de secretos salvo que se indique ARCHIVO_CLIENTES_JSON, y no sube paquete ni banco.
# La imagen inicial es un marcador: el primer despliegue real lo hace el CI.
#
# Uso: infra/crear-staging.sh [--dry-run | --ejecutar] [--parametros archivo.env]
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/_comun.sh
source "$AQUI/_comun.sh"
analizar_argumentos "$@"
cargar_parametros

echo "# Modo: ${MODO}  Proyecto: ${PROYECTO}  Región: ${REGION}"
[[ "$MODO" == "seco" ]] && echo "# Nada se ejecuta. Agregue --ejecutar para actuar."

G=(gcloud --project "$PROYECTO" --quiet)

paso "1. APIs"
correr "${G[@]}" services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  aiplatform.googleapis.com storage.googleapis.com iamcredentials.googleapis.com cloudresourcemanager.googleapis.com \
  iam.googleapis.com sts.googleapis.com

paso "2. Artifact Registry (sin Artifact Analysis; limpieza: últimas ${AR_RETENCION_ULTIMAS})"
crear_si_no_existe -- "${G[@]}" artifacts repositories describe "$REPO_AR" --location "$REGION" -- \
  "${G[@]}" artifacts repositories create "$REPO_AR" --repository-format docker --location "$REGION" \
  --description "Imagenes de Kuaa (staging)"
# La política de limpieza se escribe en un archivo temporal; solo se crea al ejecutar.
POLITICA="$(mktemp)"
trap 'rm -f "$POLITICA"' EXIT
cat >"$POLITICA" <<JSON
[{"name":"conservar-ultimas","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":${AR_RETENCION_ULTIMAS}}}]
JSON
if [[ "$MODO" == "seco" ]]; then echo "# (política) $(cat "$POLITICA")"; fi
correr "${G[@]}" artifacts repositories set-cleanup-policies "$REPO_AR" --location "$REGION" --policy "$POLITICA" --no-dry-run

paso "3. Buckets privados (acceso uniforme, sin acceso público, versionado)"
for b in "$BUCKET_PAQUETE" "$BUCKET_BANCO"; do
  crear_si_no_existe -- "${G[@]}" storage buckets describe "gs://${b}" -- \
    "${G[@]}" storage buckets create "gs://${b}" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
  correr "${G[@]}" storage buckets update "gs://${b}" --versioning
done

paso "4. Cuentas de servicio (tres, con funciones separadas)"
crear_si_no_existe -- "${G[@]}" iam service-accounts describe "$SA_EJECUCION_EMAIL" -- \
  "${G[@]}" iam service-accounts create "$SA_EJECUCION" --display-name "Kuaa: ejecucion del servicio"
crear_si_no_existe -- "${G[@]}" iam service-accounts describe "$SA_DESPLIEGUE_EMAIL" -- \
  "${G[@]}" iam service-accounts create "$SA_DESPLIEGUE" --display-name "Kuaa: despliegue desde CI"
crear_si_no_existe -- "${G[@]}" iam service-accounts describe "$SA_CARGA_EMAIL" -- \
  "${G[@]}" iam service-accounts create "$SA_CARGA" --display-name "Kuaa: carga de paquete y banco"

paso "5. Secret Manager (solo el contenedor; el valor no pasa por este script)"
crear_si_no_existe -- "${G[@]}" secrets describe "$SECRETO_CLIENTES" -- \
  "${G[@]}" secrets create "$SECRETO_CLIENTES" --replication-policy automatic
if [[ -n "${ARCHIVO_CLIENTES_JSON:-}" ]]; then
  correr "${G[@]}" secrets versions add "$SECRETO_CLIENTES" --data-file "$ARCHIVO_CLIENTES_JSON"
else
  echo "# ARCHIVO_CLIENTES_JSON vacío: no se agrega versión. Una persona la agrega después."
fi

paso "6. Roles de la cuenta de EJECUCION (mínimo privilegio: Vertex, su secreto, lectura de los dos buckets)"
correr "${G[@]}" projects add-iam-policy-binding "$PROYECTO" --member "serviceAccount:${SA_EJECUCION_EMAIL}" \
  --role roles/aiplatform.user --condition None
correr "${G[@]}" secrets add-iam-policy-binding "$SECRETO_CLIENTES" --member "serviceAccount:${SA_EJECUCION_EMAIL}" \
  --role roles/secretmanager.secretAccessor
for b in "$BUCKET_PAQUETE" "$BUCKET_BANCO"; do
  correr "${G[@]}" storage buckets add-iam-policy-binding "gs://${b}" --member "serviceAccount:${SA_EJECUCION_EMAIL}" \
    --role roles/storage.objectViewer
done

paso "7. Roles de la cuenta de CARGA (sube a los buckets; NO edita Cloud Run)"
for b in "$BUCKET_PAQUETE" "$BUCKET_BANCO"; do
  correr "${G[@]}" storage buckets add-iam-policy-binding "gs://${b}" --member "serviceAccount:${SA_CARGA_EMAIL}" \
    --role roles/storage.objectUser
done

paso "8. Roles de la cuenta de DESPLIEGUE (edita Cloud Run y sube imágenes; NO toca los buckets)"
correr "${G[@]}" projects add-iam-policy-binding "$PROYECTO" --member "serviceAccount:${SA_DESPLIEGUE_EMAIL}" \
  --role roles/run.developer --condition None
correr "${G[@]}" artifacts repositories add-iam-policy-binding "$REPO_AR" --location "$REGION" \
  --member "serviceAccount:${SA_DESPLIEGUE_EMAIL}" --role roles/artifactregistry.writer
correr "${G[@]}" iam service-accounts add-iam-policy-binding "$SA_EJECUCION_EMAIL" \
  --member "serviceAccount:${SA_DESPLIEGUE_EMAIL}" --role roles/iam.serviceAccountUser

paso "9. Workload Identity Federation (solo ${REPO_GITHUB}; ramas main y tags v*)"
crear_si_no_existe -- "${G[@]}" iam workload-identity-pools describe "$WIF_POOL" --location global -- \
  "${G[@]}" iam workload-identity-pools create "$WIF_POOL" --location global --display-name "GitHub Kuaa"
CONDICION="assertion.repository=='${REPO_GITHUB}' && (assertion.ref=='refs/heads/main' || assertion.ref.startsWith('refs/tags/v'))"
crear_si_no_existe -- "${G[@]}" iam workload-identity-pools providers describe "$WIF_PROVEEDOR" \
  --workload-identity-pool "$WIF_POOL" --location global -- \
  "${G[@]}" iam workload-identity-pools providers create-oidc "$WIF_PROVEEDOR" \
  --workload-identity-pool "$WIF_POOL" --location global \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition "$CONDICION"
if [[ "$MODO" == "seco" ]]; then
  NUMERO="<NUMERO_DEL_PROYECTO>"
else
  NUMERO="$("${G[@]}" projects describe "$PROYECTO" --format 'value(projectNumber)')"
fi
correr "${G[@]}" iam service-accounts add-iam-policy-binding "$SA_DESPLIEGUE_EMAIL" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${NUMERO}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${REPO_GITHUB}"

paso "10. Cloud Run: servicio ${SERVICIO} (máx. ${MAX_INSTANCIAS}, mín. ${MIN_INSTANCIAS}); el CI lo actualiza después"
# Delimitador ^@^ porque BANCOS_JSON lleva comas. Las variables vacías no se envían.
ENV=""
agregar() { [[ -n "$2" ]] && ENV="${ENV:+${ENV}@}$1=$2"; return 0; }
agregar GCP_PROYECTO "$PROYECTO"
agregar GCP_REGION "$REGION"
agregar APP_ENV "$APP_ENV"
agregar APP_VERSION "$APP_VERSION"
agregar CHATBOTRAG_PERFIL_CONOCIMIENTO "$PERFIL_CONOCIMIENTO"
agregar CHATBOTRAG_PAQUETE_VALIDADO "$PAQUETE_VALIDADO"
agregar CHATBOTRAG_BUCKET_PAQUETE_VALIDADO "$BUCKET_PAQUETE"
agregar CHATBOTRAG_VERSION_PAQUETE_VALIDADO "$VERSION_PAQUETE_VALIDADO"
agregar CHATBOTRAG_SHA256_MANIFIESTO_VALIDADO "$SHA256_MANIFIESTO_VALIDADO"
# El bucket del banco y su declaración van juntos (entorno.ts); sin declaración no se envía ninguno.
if [[ -n "$BANCOS_JSON" ]]; then
  agregar CHATBOTRAG_BUCKET_BANCO "$BUCKET_BANCO"
  agregar CHATBOTRAG_BANCOS "$BANCOS_JSON"
fi
agregar CHATBOTRAG_ENRUTADOR "$ENRUTADOR"
ACCESO="--no-allow-unauthenticated"
[[ "$ACCESO_PUBLICO" == "si" ]] && ACCESO="--allow-unauthenticated"
crear_si_no_existe -- "${G[@]}" run services describe "$SERVICIO" --region "$REGION" -- \
  "${G[@]}" run deploy "$SERVICIO" --region "$REGION" --image "$IMAGEN_INICIAL" \
  --service-account "$SA_EJECUCION_EMAIL" --cpu "$CPU" --memory "$MEMORIA" \
  --min-instances "$MIN_INSTANCIAS" --max-instances "$MAX_INSTANCIAS" \
  --set-env-vars "^@^${ENV}" --set-secrets "CHATBOTRAG_CLIENTES=${SECRETO_CLIENTES}:latest" "$ACCESO"

paso "Valores para las variables y secretos de GitHub (los carga una persona o con su autorización)"
echo "# GCP_WIF_PROVIDER = projects/${NUMERO}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVEEDOR}"
echo "# GCP_SA_DEPLOY_STAGING = ${SA_DESPLIEGUE_EMAIL}   CLOUD_RUN_SA_STAGING = ${SA_EJECUCION_EMAIL}"
echo "# GCP_PROJECT_ID_STAGING = ${PROYECTO}  GCP_REGION = ${REGION}  ARTIFACT_REGISTRY_REPO = ${REPO_AR}  CLOUD_RUN_SERVICE = ${SERVICIO}  CLOUD_RUN_MAX_INSTANCES = ${MAX_INSTANCIAS}"
echo "# CLOUD_RUN_SECRETS = CHATBOTRAG_CLIENTES=${SECRETO_CLIENTES}:latest"
echo "# Fin (${MODO})."
