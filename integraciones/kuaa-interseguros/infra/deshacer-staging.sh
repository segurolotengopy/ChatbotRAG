#!/usr/bin/env bash
# DESHACER LA INFRAESTRUCTURA DE STAGING DE KUAA (inverso de crear-staging.sh)
#
# Por defecto NO hace nada: imprime los comandos (--dry-run). Con --ejecutar elimina, en orden
# inverso, lo que creó crear-staging.sh. DESTRUCTIVO e irreversible para los buckets: borra todas
# las versiones de los objetos (paquete y banco). Por eso con --ejecutar exige además
# --confirmar-proyecto <ID> igual al PROYECTO de los parámetros.
# Cada recurso se borra solo si existe, para poder repetirlo sin error.
#
# Qué NO hace: no borra el proyecto, la facturación, los chequeos de monitoreo ni los secretos
# o variables de GitHub (las alternativas: borrar el proyecto entero, con su periodo de gracia
# de Google, que debe verificarse en la documentación vigente).
#
# Uso: infra/deshacer-staging.sh [--dry-run | --ejecutar --confirmar-proyecto ID] [--parametros archivo.env]
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/_comun.sh
source "$AQUI/_comun.sh"

CONFIRMAR=""
RESTO=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--confirmar-proyecto" ]]; then
    [[ $# -ge 2 ]] || { echo "Falta el valor de --confirmar-proyecto" >&2; exit 2; }
    CONFIRMAR="$2"; shift 2
  else
    RESTO+=("$1"); shift
  fi
done
analizar_argumentos "${RESTO[@]+"${RESTO[@]}"}"
cargar_parametros
if [[ "$MODO" == "ejecutar" && "$CONFIRMAR" != "$PROYECTO" ]]; then
  echo "Con --ejecutar debe pasar --confirmar-proyecto ${PROYECTO}. No se hizo nada." >&2
  exit 2
fi

echo "# Modo: ${MODO}  Proyecto: ${PROYECTO}"
[[ "$MODO" == "seco" ]] && echo "# Nada se ejecuta."
G=(gcloud --project "$PROYECTO" --quiet)

borrar_si_existe() { # <comprobar...> -- <borrar...>
  local -a comprobar=() borrar=()
  local destino="comprobar" arg
  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then destino="borrar"; continue; fi
    if [[ "$destino" == "comprobar" ]]; then comprobar+=("$arg"); else borrar+=("$arg"); fi
  done
  if [[ "$MODO" == "seco" ]]; then
    printf '[seco] si existe: '; printf '%q ' "${comprobar[@]}"; printf '\n'
    printf '[seco]   entonces: '; printf '%q ' "${borrar[@]}"; printf '\n'
  elif "${comprobar[@]}" >/dev/null 2>&1; then
    "${borrar[@]}"
  else
    echo "no existe, se omite: ${comprobar[*]}"
  fi
}

paso "1. Cloud Run"
borrar_si_existe "${G[@]}" run services describe "$SERVICIO" --region "$REGION" -- \
  "${G[@]}" run services delete "$SERVICIO" --region "$REGION"

paso "2. Workload Identity Federation (el proveedor y luego el pool)"
borrar_si_existe "${G[@]}" iam workload-identity-pools providers describe "$WIF_PROVEEDOR" --workload-identity-pool "$WIF_POOL" --location global -- \
  "${G[@]}" iam workload-identity-pools providers delete "$WIF_PROVEEDOR" --workload-identity-pool "$WIF_POOL" --location global
borrar_si_existe "${G[@]}" iam workload-identity-pools describe "$WIF_POOL" --location global -- \
  "${G[@]}" iam workload-identity-pools delete "$WIF_POOL" --location global

paso "3. Cuentas de servicio (los roles asociados se van con ellas)"
for sa in "$SA_EJECUCION_EMAIL" "$SA_DESPLIEGUE_EMAIL" "$SA_CARGA_EMAIL"; do
  borrar_si_existe "${G[@]}" iam service-accounts describe "$sa" -- "${G[@]}" iam service-accounts delete "$sa"
done

paso "4. Secret Manager"
borrar_si_existe "${G[@]}" secrets describe "$SECRETO_CLIENTES" -- "${G[@]}" secrets delete "$SECRETO_CLIENTES"

paso "5. Buckets (borra TODAS las versiones de los objetos)"
for b in "$BUCKET_PAQUETE" "$BUCKET_BANCO"; do
  borrar_si_existe "${G[@]}" storage buckets describe "gs://${b}" -- "${G[@]}" storage rm --recursive "gs://${b}"
done

paso "6. Artifact Registry"
borrar_si_existe "${G[@]}" artifacts repositories describe "$REPO_AR" --location "$REGION" -- \
  "${G[@]}" artifacts repositories delete "$REPO_AR" --location "$REGION"

echo "# Las APIs habilitadas no se deshabilitan (no cuestan por estar habilitadas). Fin (${MODO})."
