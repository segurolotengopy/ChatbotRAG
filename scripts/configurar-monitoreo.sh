#!/usr/bin/env bash
# CONFIGURAR EL MONITOREO EXTERNO DE STAGING (puesta en marcha, una sola vez)
#
# Crea lo que docs/MONITOREO.md pide en Healthchecks.io y Better Stack y carga en
# GitHub la variable y los secretos que usan los workflows, SIN mostrar nunca un
# valor: ni las claves de API, ni los UUID de los chequeos. Los UUID viajan de la
# respuesta de Healthchecks directo a `gh secret set` por entrada estándar; no se
# imprimen y no pasan por argumentos de línea de comandos. Lo único en disco es un
# directorio temporal privado (modo 700) con las cabeceras de autenticación y las
# listas de lectura, que se borra al salir.
#
# Uso:
#   scripts/configurar-monitoreo.sh plan                     solo LEE: lista lo que hay y qué haría
#   scripts/configurar-monitoreo.sh aplicar [--sin-github] [--borrar-hc NOMBRE]... [--borrar-bs ID]...
#   --sin-github: no carga la variable ni los secretos (para cuando `gh secret set` aún no
#   está autorizado); volver a correr sin la opción los carga, porque el script es idempotente.
#
# Entradas (el propietario las deja en archivos de modo 600; el script se niega si
# otros usuarios pueden leerlos y nunca los imprime):
#   HC_API_KEY_FILE  clave de API de Healthchecks con permiso de escritura
#                    (por omisión ~/.config/chatbotrag/healthchecks-api-key)
#   BS_API_TOKEN_FILE  token de API de Better Stack Uptime
#                    (por omisión ~/.config/chatbotrag/betterstack-api-token)
#   URL_STAGING      https://host del servicio, sin ruta
#   REPO             owner/repo de GitHub (por omisión segurolotengopy/ChatbotRAG)
#   GH_CONFIG_DIR    configuración de `gh` de la cuenta PROPIETARIA del repositorio
#                    (cargar secretos exige ser administrador)
#   BS_HOST          host de la API de Better Stack (por omisión https://uptime.betterstack.com;
#                    la documentación oficial nombra también incidents.betterstack.com)
#
# Qué hace `aplicar`, de forma idempotente (volver a correrlo no duplica nada):
#   1. Healthchecks: chequeos «sonda-15min» (período 15 min, gracia 30 min) y
#      «reporte-diario» (período 1 día, gracia 4 h), con las integraciones de la cuenta.
#   2. GitHub: variable URL_STAGING y secretos HEALTHCHECKS_PING_SONDA y
#      HEALTHCHECKS_PING_REPORTE.
#   3. Better Stack: monitor de palabra clave a /salud (200 y "ok":true) cada 3 min, con alerta por correo.
#   4. Borra SOLO lo que se nombre con --borrar-hc / --borrar-bs (los de prueba).
#
# Qué NO hace: no crea el issue «Monitoreo staging» ni las cuentas, no toca el
# servicio ni GCP, y no verifica que las alertas lleguen al teléfono (eso es una
# prueba humana, paso 11 de docs/MONITOREO.md).
set -euo pipefail

MODO="${1:-}"
shift || true
BORRAR_HC=()
BORRAR_BS=()
SIN_GITHUB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --borrar-hc) BORRAR_HC+=("${2:?falta el nombre}"); shift 2 ;;
    --sin-github) SIN_GITHUB=1; shift ;;
    --borrar-bs) BORRAR_BS+=("${2:?falta el id}"); shift 2 ;;
    *) echo "Argumento desconocido: $1" >&2; exit 2 ;;
  esac
done
[[ "$MODO" == "plan" || "$MODO" == "aplicar" ]] || { echo "Uso: $0 plan|aplicar [--sin-github] [--borrar-hc NOMBRE] [--borrar-bs ID]" >&2; exit 2; }

HC_BASE="${HC_BASE:-https://healthchecks.io}"
BS_HOST="${BS_HOST:-https://uptime.betterstack.com}"
REPO="${REPO:-segurolotengopy/ChatbotRAG}"
HC_API_KEY_FILE="${HC_API_KEY_FILE:-$HOME/.config/chatbotrag/healthchecks-api-key}"
BS_API_TOKEN_FILE="${BS_API_TOKEN_FILE:-$HOME/.config/chatbotrag/betterstack-api-token}"
URL_STAGING="${URL_STAGING:-}"

if [[ ! "$URL_STAGING" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
  echo "URL_STAGING ausente o con forma inválida (https://host, sin ruta)." >&2
  exit 2
fi

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

# El archivo de credencial debe existir, ser nuestro y no ser legible por otros.
leer_credencial() { # $1 = archivo, $2 = nombre legible
  local f="$1"
  [[ -f "$f" ]] || { echo "Falta el archivo de $2: $f" >&2; exit 2; }
  local modo
  modo="$(stat -c '%a' "$f")"
  [[ "$modo" == "600" || "$modo" == "400" ]] || { echo "El archivo de $2 debe tener modo 600 o 400 (tiene $modo): $f" >&2; exit 2; }
  tr -d '\r\n ' <"$f"
}

HC_KEY="$(leer_credencial "$HC_API_KEY_FILE" 'la clave de Healthchecks')"
BS_TOKEN="$(leer_credencial "$BS_API_TOKEN_FILE" 'el token de Better Stack')"
# Cabeceras en archivos (no en la línea de comandos, que otros procesos pueden ver).
printf 'X-Api-Key: %s\n' "$HC_KEY" >"$TMP/hc.hdr"
printf 'Authorization: Bearer %s\n' "$BS_TOKEN" >"$TMP/bs.hdr"
unset HC_KEY BS_TOKEN

# api CABECERAS METODO URL [JSON] → cuerpo en $TMP/cuerpo, imprime el código HTTP.
api() {
  local hdr="$1" metodo="$2" url="$3" json="${4:-}"
  local args=(-sS --max-time 30 -o "$TMP/cuerpo" -w '%{http_code}' -H "@${hdr}" -X "$metodo")
  [[ -n "$json" ]] && args+=(-H 'Content-Type: application/json' --data "$json")
  curl "${args[@]}" "$url" || echo "000"
}

exigir() { # $1 = código obtenido, $2 = códigos aceptados separados por |, $3 = qué se hacía
  [[ "$1" =~ ^($2)$ ]] || { echo "FALLÓ: $3 (HTTP $1)" >&2; exit 1; }
}

# ---------- Lectura: qué hay hoy (solo nombres, nunca UUID ni claves) ----------
echo "== Healthchecks: chequeos existentes =="
exigir "$(api "$TMP/hc.hdr" GET "$HC_BASE/api/v3/checks/")" 200 'listar los chequeos de Healthchecks'
jq -r '.checks[] | "- \(.name) (último ping: \(.last_ping // "nunca"))"' "$TMP/cuerpo"
cp "$TMP/cuerpo" "$TMP/hc-lista.json"

echo "== Better Stack: monitores existentes =="
exigir "$(api "$TMP/bs.hdr" GET "$BS_HOST/api/v2/monitors")" 200 'listar los monitores de Better Stack (¿host correcto en BS_HOST?)'
jq -r '.data[] | "- id \(.id): \(.attributes.pronounceable_name) → \(.attributes.url) [\(.attributes.monitor_type), \(.attributes.status)]"' "$TMP/cuerpo"
cp "$TMP/cuerpo" "$TMP/bs-lista.json"

if [[ "$MODO" == "plan" ]]; then
  echo "== Plan (nada se escribió) =="
  echo "- Healthchecks: crear/actualizar «sonda-15min» y «reporte-diario»."
  echo "- GitHub ($REPO): variable URL_STAGING y secretos HEALTHCHECKS_PING_SONDA y HEALTHCHECKS_PING_REPORTE."
  echo "- Better Stack: monitor «ChatbotRAG staging /salud» ($URL_STAGING/salud) cada 3 min."
  for n in "${BORRAR_HC[@]}"; do echo "- Healthchecks: borrar el chequeo «$n»."; done
  for i in "${BORRAR_BS[@]}"; do echo "- Better Stack: borrar el monitor id $i."; done
  exit 0
fi

# ---------- Escritura ----------
crear_chequeo() { # $1 nombre, $2 período s, $3 gracia s, $4 secreto de GitHub
  local json
  json="$(jq -nc --arg n "$1" --argjson t "$2" --argjson g "$3" \
    '{name:$n, tags:"chatbotrag staging", timeout:$t, grace:$g, channels:"*", unique:["name"]}')"
  exigir "$(api "$TMP/hc.hdr" POST "$HC_BASE/api/v3/checks/" "$json")" '200|201' "crear el chequeo «$1»"
  # El UUID pasa por tubería a `gh secret set`: no se imprime ni se guarda.
  if [[ $SIN_GITHUB -eq 1 ]]; then
    rm -f "$TMP/cuerpo"
    echo "Chequeo «$1» listo; el secreto $4 NO se cargó (--sin-github)."
    return 0
  fi
  jq -r '.uuid' "$TMP/cuerpo" | tr -d '\n' | gh secret set "$4" --repo "$REPO" >/dev/null
  rm -f "$TMP/cuerpo"
  echo "Chequeo «$1» listo y secreto $4 cargado en $REPO."
}
crear_chequeo 'sonda-15min' 900 1800 HEALTHCHECKS_PING_SONDA
crear_chequeo 'reporte-diario' 86400 14400 HEALTHCHECKS_PING_REPORTE

if [[ $SIN_GITHUB -eq 1 ]]; then
  echo "Variable URL_STAGING NO cargada (--sin-github)."
else
  gh variable set URL_STAGING --repo "$REPO" --body "$URL_STAGING" >/dev/null
  echo "Variable URL_STAGING cargada en $REPO."
fi

NOMBRE_BS='ChatbotRAG staging /salud'
if jq -e --arg n "$NOMBRE_BS" '[.data[] | select(.attributes.pronounceable_name == $n)] | length > 0' "$TMP/bs-lista.json" >/dev/null; then
  echo "Better Stack: el monitor «$NOMBRE_BS» ya existe; no se duplica."
else
  json="$(jq -nc --arg u "${URL_STAGING}/salud" --arg n "$NOMBRE_BS" \
    '{monitor_type:"keyword", url:$u, required_keyword:"\"ok\":true", check_frequency:180, request_timeout:30, email:true, pronounceable_name:$n}')"
  exigir "$(api "$TMP/bs.hdr" POST "$BS_HOST/api/v2/monitors" "$json")" '200|201' 'crear el monitor de Better Stack'
  echo "Better Stack: monitor «$NOMBRE_BS» creado."
fi

for nombre in "${BORRAR_HC[@]}"; do
  uuid="$(jq -r --arg n "$nombre" '[.checks[] | select(.name == $n)] | first | .uuid // empty' "$TMP/hc-lista.json")"
  if [[ -z "$uuid" ]]; then echo "Healthchecks: no hay un chequeo llamado «$nombre»; nada que borrar."; continue; fi
  exigir "$(api "$TMP/hc.hdr" DELETE "$HC_BASE/api/v3/checks/${uuid}")" 200 "borrar el chequeo «$nombre»"
  echo "Healthchecks: chequeo «$nombre» borrado."
done
for id in "${BORRAR_BS[@]}"; do
  [[ "$id" =~ ^[0-9]+$ ]] || { echo "Id de Better Stack inválido: $id" >&2; exit 2; }
  exigir "$(api "$TMP/bs.hdr" DELETE "$BS_HOST/api/v2/monitors/${id}")" '200|204' "borrar el monitor $id de Better Stack"
  echo "Better Stack: monitor $id borrado."
done
echo "Listo. Falta: crear el issue «Monitoreo staging» y disparar los dos workflows (docs/MONITOREO.md, pasos 5 a 8)."
