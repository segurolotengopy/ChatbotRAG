#!/usr/bin/env bash
# VERIFICAR LA INFRAESTRUCTURA DE STAGING DE KUAA (solo lectura)
#
# Comprueba con `gcloud ... describe/list/get-iam-policy` que existe cada recurso de
# crear-staging.sh y que las propiedades que importan para la seguridad y el costo son las
# esperadas: máx. de instancias, versionado y acceso público bloqueado de los buckets, y que
# la cuenta de despliegue NO tenga rol sobre los buckets ni la de carga sobre Cloud Run.
# No escribe nada, por eso consulta de verdad por defecto. Con --dry-run solo imprime lo que
# consultaría (sin llamar a gcloud).
# Salida: 0 todo bien · 1 falta algo o difiere · 2 uso incorrecto.
#
# Qué NO garantiza: no prueba que el servicio funcione (eso lo hace la prueba de humo del CI),
# ni que el presupuesto o las alertas existan, ni el Environment de GitHub; y los roles se
# comprueban por nombre, no se simulan permisos efectivos.
#
# Uso: infra/verificar-staging.sh [--dry-run] [--parametros archivo.env]
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/_comun.sh
source "$AQUI/_comun.sh"
for a in "$@"; do [[ "$a" != "--ejecutar" ]] || { echo "Este script es de solo lectura; no admite --ejecutar." >&2; exit 2; }; done
MODO="ejecutar" # es de solo lectura: consulta de verdad por defecto
analizar_argumentos "$@"
cargar_parametros
G=(gcloud --project "$PROYECTO" --quiet)
fallos=0

# comprobar "<descripción>" <comando...>: éxito del comando = recurso presente.
comprobar() {
  local desc="$1"; shift
  if [[ "$MODO" == "seco" ]]; then printf '[seco] %s: ' "$desc"; printf '%q ' "$@"; printf '\n'; return 0; fi
  if "$@" >/dev/null 2>&1; then echo "OK     $desc"; else echo "FALTA  $desc"; fallos=$((fallos + 1)); fi
}

# valor "<descripción>" <esperado> <comando...>: compara la salida con lo esperado.
valor() {
  local desc="$1" esperado="$2"; shift 2
  if [[ "$MODO" == "seco" ]]; then printf '[seco] %s (esperado: %s): ' "$desc" "$esperado"; printf '%q ' "$@"; printf '\n'; return 0; fi
  local real
  real="$("$@" 2>/dev/null || true)"
  if [[ "$real" == "$esperado" ]]; then echo "OK     $desc = $real"; else echo "DIFIERE $desc: esperado «$esperado», real «${real:-vacío}»"; fallos=$((fallos + 1)); fi
}

# sin_rol "<descripción>" <comando que lista miembros> <patrón>: no debe aparecer el patrón.
sin_rol() {
  local desc="$1" patron="$2"; shift 2
  if [[ "$MODO" == "seco" ]]; then printf '[seco] %s: ' "$desc"; printf '%q ' "$@"; printf '| grep -c %q (debe ser 0)\n' "$patron"; return 0; fi
  if "$@" 2>/dev/null | grep -q -- "$patron"; then echo "DIFIERE $desc"; fallos=$((fallos + 1)); else echo "OK     $desc"; fi
}

echo "# Proyecto: ${PROYECTO} (modo ${MODO/ejecutar/consulta}, solo lectura)"
for api in run artifactregistry secretmanager aiplatform storage iamcredentials cloudresourcemanager; do
  valor "API ${api} habilitada" "${api}.googleapis.com" "${G[@]}" services list --enabled --filter "config.name=${api}.googleapis.com" --format 'value(config.name)'
done
comprobar "Artifact Registry ${REPO_AR}" "${G[@]}" artifacts repositories describe "$REPO_AR" --location "$REGION"
for b in "$BUCKET_PAQUETE" "$BUCKET_BANCO"; do
  comprobar "bucket ${b}" "${G[@]}" storage buckets describe "gs://${b}"
  valor "bucket ${b}: versionado" "True" "${G[@]}" storage buckets describe "gs://${b}" --format 'value(versioning_enabled)'
  valor "bucket ${b}: acceso uniforme" "True" "${G[@]}" storage buckets describe "gs://${b}" --format 'value(uniform_bucket_level_access)'
  valor "bucket ${b}: prevención de acceso público" "enforced" "${G[@]}" storage buckets describe "gs://${b}" --format 'value(public_access_prevention)'
  sin_rol "bucket ${b}: la cuenta de DESPLIEGUE no tiene rol" "$SA_DESPLIEGUE_EMAIL" "${G[@]}" storage buckets get-iam-policy "gs://${b}"
  comprobar "bucket ${b}: la cuenta de EJECUCION lo lee" bash -c "${G[*]} storage buckets get-iam-policy gs://${b} 2>/dev/null | grep -q '${SA_EJECUCION_EMAIL}'"
done
for sa in "$SA_EJECUCION_EMAIL" "$SA_DESPLIEGUE_EMAIL" "$SA_CARGA_EMAIL"; do
  comprobar "cuenta de servicio ${sa}" "${G[@]}" iam service-accounts describe "$sa"
done
comprobar "secreto ${SECRETO_CLIENTES}" "${G[@]}" secrets describe "$SECRETO_CLIENTES"
comprobar "pool WIF ${WIF_POOL}" "${G[@]}" iam workload-identity-pools describe "$WIF_POOL" --location global
comprobar "proveedor WIF ${WIF_PROVEEDOR}" "${G[@]}" iam workload-identity-pools providers describe "$WIF_PROVEEDOR" --workload-identity-pool "$WIF_POOL" --location global
valor "proveedor WIF: condición ligada al repo" "1" bash -c "${G[*]} iam workload-identity-pools providers describe '${WIF_PROVEEDOR}' --workload-identity-pool '${WIF_POOL}' --location global --format 'value(attributeCondition)' | grep -c -F '${REPO_GITHUB}'"
comprobar "servicio Cloud Run ${SERVICIO}" "${G[@]}" run services describe "$SERVICIO" --region "$REGION"
valor "Cloud Run: máximo de instancias" "$MAX_INSTANCIAS" "${G[@]}" run services describe "$SERVICIO" --region "$REGION" --format 'value(spec.template.metadata.annotations."autoscaling.knative.dev/maxScale")'
valor "Cloud Run: cuenta de ejecución" "$SA_EJECUCION_EMAIL" "${G[@]}" run services describe "$SERVICIO" --region "$REGION" --format 'value(spec.template.spec.serviceAccountName)'
sin_rol "proyecto: la cuenta de CARGA no tiene rol de Cloud Run" "$SA_CARGA_EMAIL" "${G[@]}" projects get-iam-policy "$PROYECTO" --flatten bindings --filter "bindings.role~roles/run" --format 'value(bindings.members)'

if [[ "$MODO" == "seco" ]]; then echo "# Fin (seco): no se consultó nada."; exit 0; fi
if [[ $fallos -gt 0 ]]; then echo "# ${fallos} comprobación(es) fallida(s)."; exit 1; fi
echo "# Todo conforme."
