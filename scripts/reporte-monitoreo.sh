#!/usr/bin/env bash
# REPORTE DIARIO DEL MONITOREO DE STAGING
#
# Cuenta cuántas veces corrió la sonda en las últimas 24 horas frente a las 96
# esperadas (cada 15 minutos) y cuántas pasaron o fallaron, y lo comenta en un issue
# fijo. Es la prueba periódica de que el monitor sigue vivo: si el reporte deja de
# llegar, el chequeo «reporte-diario» de Healthchecks.io avisa por correo (el silencio
# total también es una alerta).
#
# El issue es público, como el repositorio: el comentario lleva SOLO cifras de estado,
# nunca URLs completas, claves ni texto de conversaciones.
#
# Qué NO garantiza: cuenta ejecuciones del workflow, no la salud del servicio en cada
# instante; GitHub puede omitir ejecuciones de cron, y por eso «faltantes» no es
# siempre una caída. Tampoco crea el issue: si no existe, falla a propósito en lugar
# de publicar algo sin que una persona lo haya pedido.
#
# Entrada: GH_TOKEN, GITHUB_REPOSITORY, y opcionalmente WORKFLOW (monitoreo-staging.yml),
# TITULO_ISSUE («Monitoreo staging»), ESPERADAS (96), PING (UUID del latido; secreto).
set -euo pipefail

WORKFLOW="${WORKFLOW:-monitoreo-staging.yml}"
TITULO_ISSUE="${TITULO_ISSUE:-Monitoreo staging}"
ESPERADAS="${ESPERADAS:-96}"
: "${GITHUB_REPOSITORY:?falta GITHUB_REPOSITORY}"

desde="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
corridas="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$WORKFLOW" --created ">=${desde}" --limit 300 --json conclusion,status)"

total="$(jq 'length' <<<"$corridas")"
exitosas="$(jq '[.[] | select(.conclusion == "success")] | length' <<<"$corridas")"
fallidas="$(jq '[.[] | select(.conclusion == "failure" or .conclusion == "timed_out")] | length' <<<"$corridas")"
otras=$((total - exitosas - fallidas))
faltantes=$((ESPERADAS - total))
[[ $faltantes -lt 0 ]] && faltantes=0

numero="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "\"${TITULO_ISSUE}\" in:title" --json number,title |
  jq -r --arg t "$TITULO_ISSUE" '[.[] | select(.title == $t)] | first | .number // empty')"
if [[ -z "$numero" ]]; then
  echo "::error::No existe un issue abierto titulado «${TITULO_ISSUE}». Una persona debe crearlo; este script no publica por su cuenta." >&2
  exit 1
fi

cuerpo="$(
  cat <<EOF
### Reporte diario · $(date -u +%Y-%m-%d)
Ventana: últimas 24 horas.

| Esperadas | Corrieron | Exitosas | Fallidas | Otras | Faltantes |
|---|---|---|---|---|---|
| ${ESPERADAS} | ${total} | ${exitosas} | ${fallidas} | ${otras} | ${faltantes} |

«Faltantes» puede ser un cron que GitHub omitió y no una caída; el latido de Healthchecks.io es quien decide si hubo silencio.
EOF
)"
gh issue comment "$numero" --repo "$GITHUB_REPOSITORY" --body "$cuerpo" >/dev/null
echo "$cuerpo"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$cuerpo" >>"$GITHUB_STEP_SUMMARY"; fi

# Latido del reporte: solo si el comentario se publicó. Sin secreto, avisa y sigue.
if [[ -z "${PING:-}" ]]; then
  echo "::warning::Falta el secreto HEALTHCHECKS_PING_REPORTE: el reporte salió pero no avisó al latido."
else
  curl --silent --show-error --fail --max-time 10 --retry 3 "https://hc-ping.com/${PING}" >/dev/null
fi
