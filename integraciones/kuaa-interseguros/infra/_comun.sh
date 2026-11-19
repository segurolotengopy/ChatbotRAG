#!/usr/bin/env bash
# Utilidades comunes de infra/*.sh (se cargan con `source`; no se ejecuta solo).
#
# Por qué existe: los tres scripts comparten el modo seco por defecto, la validación de
# parámetros y el patrón «crear solo si no existe». Cada llamada a gcloud pasa por aquí.
#
# Qué NO garantiza: no valida permisos ni facturación; en modo seco NO consulta a gcloud
# (ni siquiera de lectura), así que no sabe qué existe ya: imprime cada paso como si faltara.
set -euo pipefail

MODO="seco"   # seco (por defecto) | ejecutar
ARCHIVO_PARAMETROS=""

# Uso: analizar_argumentos "$@"; deja MODO y ARCHIVO_PARAMETROS.
analizar_argumentos() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) MODO="seco" ;;
      --ejecutar) MODO="ejecutar" ;;
      --parametros)
        [[ $# -ge 2 ]] || { echo "Falta el valor de --parametros" >&2; exit 2; }
        ARCHIVO_PARAMETROS="$2"; shift ;;
      -h | --help) echo "Uso: $0 [--dry-run | --ejecutar] [--parametros archivo.env]"; exit 0 ;;
      *) echo "Argumento desconocido: $1" >&2; exit 2 ;;
    esac
    shift
  done
}

# Carga el archivo de parámetros y rechaza marcadores sin reemplazar.
cargar_parametros() {
  local aqui archivo
  aqui="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  archivo="${ARCHIVO_PARAMETROS:-$aqui/parametros.local.env}"
  if [[ ! -f "$archivo" && "$MODO" == "seco" && -z "$ARCHIVO_PARAMETROS" ]]; then
    echo "# AVISO (modo seco): no existe parametros.local.env; se muestra el plan con parametros.ejemplo.env." >&2
    archivo="$aqui/parametros.ejemplo.env"
  fi
  [[ -f "$archivo" ]] || { echo "No existe $archivo. Copie parametros.ejemplo.env a parametros.local.env y complete los marcadores." >&2; exit 2; }
  # shellcheck disable=SC1090
  source "$archivo"
  local pendientes
  pendientes="$(grep -E '^[A-Z_0-9]+=' "$archivo" | sed 's/[[:space:]]#.*$//' | grep -E '<[^>]*>' || true)"
  if [[ -n "$pendientes" ]]; then
    if [[ "$MODO" == "ejecutar" ]]; then
      echo "Quedan marcadores <...> sin reemplazar; no se ejecuta nada:" >&2
      echo "$pendientes" >&2
      exit 2
    fi
    echo "# AVISO (modo seco): quedan marcadores <...> sin reemplazar en $archivo; --ejecutar los rechazaría." >&2
  fi
  export SA_EJECUCION_EMAIL="${SA_EJECUCION}@${PROYECTO}.iam.gserviceaccount.com"
  export SA_DESPLIEGUE_EMAIL="${SA_DESPLIEGUE}@${PROYECTO}.iam.gserviceaccount.com"
  export SA_CARGA_EMAIL="${SA_CARGA}@${PROYECTO}.iam.gserviceaccount.com"
}

paso() { printf '\n# %s\n' "$*"; }

# Ejecuta (o imprime) un comando; los argumentos se entrecomillan para que lo impreso sea copiable.
correr() {
  if [[ "$MODO" == "seco" ]]; then
    printf '[seco] '; printf '%q ' "$@"; printf '\n'
  else
    "$@"
  fi
}

# crear_si_no_existe -- <comando de comprobación...> -- <comando de creación...>
# Comprueba con el primer comando (silencioso); si falla, corre el segundo. En modo seco imprime ambos.
crear_si_no_existe() {
  local -a comprobar=() crear=()
  local destino="comprobar"
  shift # el primer «--»
  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then destino="crear"; continue; fi
    if [[ "$destino" == "comprobar" ]]; then comprobar+=("$arg"); else crear+=("$arg"); fi
  done
  if [[ "$MODO" == "seco" ]]; then
    printf '[seco] si no existe: '; printf '%q ' "${comprobar[@]}"; printf '\n'
    printf '[seco]   entonces:  '; printf '%q ' "${crear[@]}"; printf '\n'
  elif "${comprobar[@]}" >/dev/null 2>&1; then
    echo "ya existe, se omite: ${comprobar[*]}"
  else
    "${crear[@]}"
  fi
}
