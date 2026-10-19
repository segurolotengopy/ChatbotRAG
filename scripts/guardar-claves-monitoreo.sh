#!/usr/bin/env bash
# GUARDAR LAS CLAVES DE API DEL MONITOREO (paso humano, una sola vez)
#
# Las claves de Healthchecks.io y de Better Stack SOLO se crean en la web de cada
# servicio: ningún script puede generarlas. Lo que este script hace es el resto, sin
# exponerlas: las pide con la entrada oculta (no se muestran, no quedan en el historial
# del terminal ni en la línea de comandos), comprueba su forma, las verifica contra el
# servicio y las guarda en archivos de modo 600 dentro de un directorio de modo 700,
# que es lo que `scripts/configurar-monitoreo.sh` exige y lee.
#
# Uso:  scripts/guardar-claves-monitoreo.sh [ambas|healthchecks|betterstack] [--reemplazar]
#
# Dónde se crea cada clave:
#   Healthchecks.io  → Settings → API Access → «Create API Key» (clave CON escritura,
#                      no la de solo lectura). Las claves son por proyecto.
#   Better Stack     → Uptime → Settings → API tokens → crear un token de Uptime.
#
# Salida: solo mensajes de estado; nunca el valor de una clave.
# Qué NO hace: no genera claves, no las envía a nadie salvo al propio servicio para
# verificarlas (una lectura), no toca GitHub ni crea chequeos (eso es
# `scripts/configurar-monitoreo.sh`).
set -euo pipefail

DIR="${CHATBOTRAG_CONFIG_DIR:-$HOME/.config/chatbotrag}"
HC_BASE="${HC_BASE:-https://healthchecks.io}"
BS_HOST="${BS_HOST:-https://uptime.betterstack.com}"
QUE="ambas"
REEMPLAZAR=0
for a in "$@"; do
  case "$a" in
    ambas | healthchecks | betterstack) QUE="$a" ;;
    --reemplazar) REEMPLAZAR=1 ;;
    *) echo "Argumento desconocido: $a" >&2; exit 2 ;;
  esac
done

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# pedir_clave NOMBRE → deja la clave en $TMP/valor (entrada oculta).
pedir_clave() {
  local valor=""
  printf 'Pegue %s y pulse Enter (no se muestra): ' "$1" >&2
  IFS= read -rs valor || true
  printf '\n' >&2
  # Solo se recortan los extremos (un salto de línea o espacio al pegar); un espacio
  # interior hace inválida la clave, no se borra.
  valor="${valor#"${valor%%[![:space:]]*}"}"
  valor="${valor%"${valor##*[![:space:]]}"}"
  if [[ ! "$valor" =~ ^[A-Za-z0-9_.-]{16,200}$ ]]; then
    echo "La clave no tiene la forma esperada (16 a 200 caracteres alfanuméricos, guion, punto o guion bajo). No se guardó nada." >&2
    exit 1
  fi
  printf '%s' "$valor" >"$TMP/valor"
  unset valor
}

# http_get 'CABECERA:' URL → imprime el código HTTP; cuerpo en $TMP/cuerpo. La clave
# va en un archivo de cabeceras temporal, nunca en la línea de comandos.
http_get() {
  printf '%s %s\n' "$1" "$(cat "$TMP/valor")" >"$TMP/hdr"
  curl -sS --max-time 20 -o "$TMP/cuerpo" -w '%{http_code}' -H "@$TMP/hdr" "$2" || echo 000
  rm -f "$TMP/hdr"
}

guardar() { # $1 = archivo destino
  local destino="$DIR/$1"
  if [[ -e "$destino" && $REEMPLAZAR -eq 0 ]]; then
    echo "Ya existe $destino. Use --reemplazar para sobrescribirlo. No se guardó nada." >&2
    exit 1
  fi
  install -m 600 "$TMP/valor" "$destino"
  echo "Guardada en $destino (modo 600)." >&2
}

if [[ "$QUE" == "ambas" || "$QUE" == "healthchecks" ]]; then
  echo "== Healthchecks.io: clave de API CON escritura ==" >&2
  pedir_clave 'la clave de API de Healthchecks'
  codigo="$(http_get 'X-Api-Key:' "$HC_BASE/api/v3/checks/")"
  if [[ "$codigo" != "200" ]]; then
    echo "Healthchecks rechazó la clave (HTTP $codigo). No se guardó nada." >&2
    exit 1
  fi
  # Una clave de solo lectura omite el uuid de cada chequeo y agrega unique_key.
  if jq -e '[.checks[]? | has("unique_key")] | any' "$TMP/cuerpo" >/dev/null; then
    echo "Esa clave es de SOLO LECTURA; se necesita una con escritura. No se guardó nada." >&2
    exit 1
  fi
  guardar healthchecks-api-key
fi

if [[ "$QUE" == "ambas" || "$QUE" == "betterstack" ]]; then
  echo "== Better Stack: token de API de Uptime ==" >&2
  pedir_clave 'el token de API de Better Stack'
  codigo="$(http_get 'Authorization: Bearer' "$BS_HOST/api/v2/monitors")"
  if [[ "$codigo" != "200" ]]; then
    echo "Better Stack rechazó el token (HTTP $codigo; ¿host correcto en BS_HOST?). No se guardó nada." >&2
    exit 1
  fi
  guardar betterstack-api-token
fi

echo "Listo. Siguiente: avisar a Claude para correr «configurar-monitoreo.sh plan» (solo lee)." >&2
