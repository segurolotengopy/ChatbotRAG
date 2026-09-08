# Aplicación del estándar DevSecOps — segurolotengopy/ChatbotRAG — 2026-09-06

Stack: `node-cloudrun` (workflow `ci-node-cloudrun.yml`, adaptado del `python-cloudrun` del estándar v2.0) | Modo: **A** (repositorio público; supuesto: el repositorio en GitHub está vacío y público) | Rama: `chore/estandar-devsecops` | PR: pendiente de apertura por el propietario (el entorno de la sesión no tiene credenciales de GitHub).

## Archivos creados / modificados / conservados

**Creados por `bootstrap-repo.sh` (26) y adaptados:**

- `.devsecops.yml` — `stack: node`, `proveedor: cloudrun`, un componente en `./`; proyectos y URLs marcados «A CONFIRMAR».
- `.github/workflows/ci-node-cloudrun.yml` — jobs `preparar` y `calidad` reescritos para Node/pnpm (tipos → lint → Vitest con umbral de cobertura → `pnpm audit --audit-level high` → validación de configuraciones de agentes); `seguridad-estatica` con `stack: node`; `HEALTH_PATH` por defecto `/salud`. Nombres de jobs, `permissions`, `concurrency`, `timeout-minutes` y pines por SHA conservados. `construir`, `desplegar-*`, `dast-y-humo`, `post-despliegue` y `compuerta-pr` sin cambios.
- `.github/workflows/_reusable-security.yml`, `_reusable-dast.yml`, `codeql.yml`, `release.yml`, `scorecard.yml` — copiados del estándar sin cambios.
- `.github/{CODEOWNERS, PULL_REQUEST_TEMPLATE.md, devsecops.schema.json, gitleaks.toml, semgrep.yml, trivy.yaml, zap-rules.tsv, scripts/}` — copiados.
- `.github/dependabot.yml` — se quitaron los ecosistemas `pip` y `terraform` (no existen en el repo); quedan `github-actions`, `npm`, `docker`.
- `.pre-commit-config.yaml`, `deploy.sh`, `security-local.sh` — copiados.
- `CLAUDE.md` — reglas obligatorias del estándar íntegras; descripción, tabla de comandos y convenciones completadas con las reales del proyecto (pnpm, `pnpm tipos/lint/pruebas/verificar`, `pnpm esquema`, `pnpm validar-config`); rutas al estándar en `/home/andres-alberdi/SeguridadGeneral`.
- `.claude/agents/*.md`, `.claude/skills/*` — copiados. `.claude/settings.json` — creado con `permissions.deny` (`.env*`, `CONFIGURACION.local.md`, `deploy.sh prod*`, `git push --force*`).
- `.gitignore` — entradas del estándar añadidas (`.deploy-log/`, `.security-reports/`, `.env*`, claves, `tfplan*`, `.trivyignore.yaml`, `.gitleaksignore`).

**Sin restos de política v1** (repositorio nuevo): no hay `CI_CD_POLICIES.md`, `ci-cd-pipeline.yml`, `deploy.sh` v1, `AGENTS.md` ni rama `staging`.

## Verificación

actionlint: **ok** (6 workflows) · shellcheck: **ok** (`deploy.sh`, `security-local.sh`) · `bash -n`: ok · `security-local.sh`: **CRITICAL=0 HIGH=0 MEDIUM=1** (CKV_GHA_7 en `release.yml:37`, `workflow_dispatch` con inputs; es parte del estándar y no se exceptúa desde aquí) — gitleaks, osv-scanner y checkov ejecutados; **trivy y semgrep no pudieron descargar sus bases** desde el entorno de la sesión (sin salida a `mirror.gcr.io` ni al registro de reglas): el pipeline los ejecuta completos · `deploy.sh staging --dry-run`: lee y valida el manifiesto (proyecto, modo, 1 componente) y se detiene en la fase 1 por **ausencia de `gcloud`** en el entorno de la sesión; debe repetirse en un equipo con `gcloud`.

Calidad del proyecto: `pnpm verificar` (tipos, lint, 74 pruebas) en verde; cobertura de líneas 87,37 % (umbral 70).

## Secretos que debe crear el propietario (por nombre; generar con `setup-oidc-gcp.sh`)

- `GCP_WIF_PROVIDER`, `GCP_SA_DEPLOY_STAGING`, `GCP_SA_DEPLOY_PROD` (este último como secreto del Environment `production`).
- `GITLEAKS_LICENSE` solo si el repositorio pasa a una organización.
- `RELEASE_TOKEN` (opcional) para que el tag de `release.yml` dispare `ci-node-cloudrun.yml`.

## Variables configuradas / pendientes

Ninguna configurada (sin `gh`). Pendientes, con los valores propuestos:

`MODO=A` · `GHAS_ENABLED=false` · `NODE_VERSION=22` · `COVERAGE_MIN=70` · `HEALTH_PATH=/salud` · `CODEQL_LENGUAJES=javascript-typescript` · `BLOQUEAR_EN=CRITICAL,HIGH` · `WORKFLOW_PRODUCCION=ci-node-cloudrun.yml` · `APROBADORES_PROD=` · `TAG_FIRMADO_REQUERIDO=false` · `STAGING_URL`, `PROD_URL` (URLs reales de Cloud Run) · `GCP_PROJECT_ID_STAGING`, `GCP_PROJECT_ID_PROD` (a confirmar) · `GCP_REGION=us-central1` · `ARTIFACT_REGISTRY_REPO=chatbotrag` · `CLOUD_RUN_SERVICE=chatbotrag` · `CLOUD_RUN_SA_STAGING`, `CLOUD_RUN_SA_PROD` (`chatbotrag-run@<proyecto>.iam.gserviceaccount.com`) · `CLOUD_RUN_SECRETS` (`CHATBOTRAG_CLIENTES=chatbotrag-clientes:latest`, `CHATBOTRAG_HMAC_HERRAMIENTAS=chatbotrag-hmac-herramientas:latest`).

## Configuración remota

Ruleset `main`: **pendiente** (sin `gh` autenticado en la sesión; `bootstrap-repo.sh` lo crea al reejecutarse con `gh` o se importa `02-pipelines/config/rulesets/main.json`) · Ruleset de tags `v*`: pendiente · Environments: pendiente (`staging`; `production` con revisores).

## Pendientes y decisiones para el propietario

1. Confirmar modo A y visibilidad pública del repositorio; publicar `main` y la rama, abrir el PR.
2. Confirmar los IDs de proyecto GCP y las URLs de Cloud Run; reemplazar los «A CONFIRMAR» de `.devsecops.yml`.
3. Ejecutar `setup-oidc-gcp.sh` por proyecto y cargar los tres secretos.
4. Crear rulesets y Environments (o reejecutar `bootstrap-repo.sh` con `gh` autenticado, que es idempotente).
5. Decidir si `CKV_GHA_7` de `release.yml` se exceptúa en `.devsecops.yml` (es una regla del estándar; la excepción debería nacer en `SeguridadGeneral`).
