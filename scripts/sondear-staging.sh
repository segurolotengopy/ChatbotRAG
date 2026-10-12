#!/usr/bin/env bash
# SONDA DE STAGING (red A del monitoreo externo)
#
# Qué mide, contra la URL pública del servicio y SIN credenciales:
#   1. GET /salud   → 200 y cuerpo con "ok":true.
#   2. GET /health  → 200 (el alias que el estándar espera; una prueba del servicio
#                     verifica que devuelva lo mismo que /salud).
#   3. Cabeceras    → HSTS y CSP presentes en /salud (defecto que se destapó en el
#                     primer despliegue: el pipeline los medía en la raíz).
#   4. GET /v1/agente sin clave → 401. Es la prueba de que el control de acceso
#                     sigue puesto, y no necesita la clave del cliente: esa clave
#                     no sale nunca de Secret Manager. (Es GET; un POST da 404.)
#   5. Latencia     → la primera llamada tras inactividad puede tardar ~11 s por el
#                     arranque en frío de Cloud Run (escala a 0). Si la primera tarda
#                     más que UMBRAL_FRIO_SEG se descarta como arranque en frío y se
#                     mide la segunda: aviso por encima de AVISO_LATENCIA_SEG, fallo
#                     por encima de LIMITE_FALLO_SEG.
# Una falla puntual de red no declara incidente: se reintenta REINTENTOS veces,
# separadas ESPERA_REINTENTO_SEG segundos.
#
# Qué NO garantiza: no llama al modelo (/salud no toca Vertex AI), así que una
# caída de Gemini no se ve acá; no prueba la calidad de las respuestas; y mide desde
# los servidores de GitHub, una sola red. Por eso existe una segunda sonda de otro
# proveedor, y un latido que avisa si ESTA deja de correr.
#
# Entrada: URL_STAGING (https://host, sin barra final ni ruta). Código de salida:
# 0 todo bien · 1 alguna comprobación falló · 2 uso incorrecto.
set -euo pipefail

URL_BASE="${URL_STAGING:-}"
REINTENTOS="${REINTENTOS:-3}"
ESPERA_REINTENTO_SEG="${ESPERA_REINTENTO_SEG:-30}"
TIMEOUT_SEG="${TIMEOUT_SEG:-30}"
UMBRAL_FRIO_SEG="${UMBRAL_FRIO_SEG:-8}"
AVISO_LATENCIA_SEG="${AVISO_LATENCIA_SEG:-3}"
LIMITE_FALLO_SEG="${LIMITE_FALLO_SEG:-10}"

# La URL llega de una variable del repositorio: se valida su forma antes de usarla.
# SONDA_PRUEBAS=1 admite además http://127.0.0.1:<puerto> para la prueba automática.
if [[ ! "$URL_BASE" =~ ^https://[A-Za-z0-9.-]+$ ]] &&
  { [[ "${SONDA_PRUEBAS:-}" != "1" ]] || [[ ! "$URL_BASE" =~ ^http://127\.0\.0\.1:[0-9]+$ ]]; }; then
  echo "::error::URL_STAGING ausente o con forma inválida (se espera https://host, sin ruta ni barra final)." >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fallas=()
avisos=()

# pedir RUTA → deja cabeceras en $TMP/h, cuerpo en $TMP/b; imprime "<código> <segundos>"
# CON salto de línea final (sin él, `read` devuelve 1 y `set -e` mata la sonda en silencio).
# Si curl falla (red, timeout) imprime igual "000 <segundos>": el código 000 no es 200 ni 401.
pedir() {
  curl -sS --max-time "$TIMEOUT_SEG" -D "$TMP/h" -o "$TMP/b" -w '%{http_code} %{time_total}\n' "${URL_BASE}$1" 2>"$TMP/e" || true
}

mayor() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'; }

# Una pasada completa. Rellena `fallas` y `avisos`.
una_pasada() {
  fallas=()
  avisos=()
  local codigo seg

  read -r codigo seg < <(pedir /salud)
  if mayor "$seg" "$UMBRAL_FRIO_SEG"; then
    avisos+=("la primera llamada tardó ${seg}s (arranque en frío); se mide la segunda")
    read -r codigo seg < <(pedir /salud)
  fi
  if [[ "$codigo" != "200" ]]; then
    fallas+=("/salud respondió ${codigo}")
  else
    grep -q '"ok":true' "$TMP/b" || fallas+=('/salud no trae "ok":true en el cuerpo')
    grep -qi '^strict-transport-security:' "$TMP/h" || fallas+=('/salud sin la cabecera HSTS')
    grep -qi '^content-security-policy:' "$TMP/h" || fallas+=('/salud sin la cabecera CSP')
    if mayor "$seg" "$LIMITE_FALLO_SEG"; then
      fallas+=("/salud tardó ${seg}s, por encima del límite de ${LIMITE_FALLO_SEG}s")
    elif mayor "$seg" "$AVISO_LATENCIA_SEG"; then
      avisos+=("/salud tardó ${seg}s, por encima de ${AVISO_LATENCIA_SEG}s")
    fi
  fi

  read -r codigo seg < <(pedir /health)
  [[ "$codigo" == "200" ]] || fallas+=("/health respondió ${codigo}")

  read -r codigo seg < <(pedir /v1/agente)
  [[ "$codigo" == "401" ]] || fallas+=("GET /v1/agente sin clave respondió ${codigo} y debía responder 401")
}

intento=1
while :; do
  una_pasada
  [[ ${#fallas[@]} -eq 0 ]] && break
  echo "Intento ${intento}/${REINTENTOS}: ${fallas[*]}" >&2
  [[ $intento -ge $REINTENTOS ]] && break
  intento=$((intento + 1))
  sleep "$ESPERA_REINTENTO_SEG"
done

resumen="$TMP/resumen.md"
{
  echo "### Sonda de staging · $(date -u +%Y-%m-%dT%H:%MZ)"
  if [[ ${#fallas[@]} -eq 0 ]]; then
    echo "**OK** tras ${intento} intento(s)."
  else
    echo "**FALLA** tras ${intento} intento(s):"
    printf -- '- %s\n' "${fallas[@]}"
  fi
  if [[ ${#avisos[@]} -gt 0 ]]; then
    echo "Avisos:"
    printf -- '- %s\n' "${avisos[@]}"
  fi
} >"$resumen"
cat "$resumen"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then cat "$resumen" >>"$GITHUB_STEP_SUMMARY"; fi
for a in "${avisos[@]}"; do echo "::warning::${a}"; done

[[ ${#fallas[@]} -eq 0 ]]
