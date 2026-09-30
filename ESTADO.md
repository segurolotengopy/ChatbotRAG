# ESTADO — bitácora viva del proyecto ChatbotRAG

Se actualiza al final de cada sesión. **Nunca contiene secretos.** Lo más reciente arriba.

## 2026-09-30 · Sincronización con el estándar y rutas rotas de la entrega

### Qué se hizo

- **Corregidas tres rutas heredadas del equipo de entrega** (`/home/claude/...`, que no existe aquí):
  - `scripts/simular-conversacion.mts` tenía la raíz de `configuraciones/` fijada por ruta absoluta, así que el comando que documenta CLAUDE.md fallaba con ENOENT. Ahora se resuelve relativa al propio archivo (commit `e908715`).
  - Los siete agentes y las dos skills de `.claude/` citaban `/home/claude/SeguridadGeneral` en 28 lugares: cualquier subagente que siguiera sus instrucciones leía rutas inexistentes, y `/aplicar-estandar-devsecops` mandaba a buscar el bootstrap donde no está. Se recopiaron del estándar con la sustitución correcta (commit `cccc83b`); con eso llegaron también los tres agentes nuevos (`planificador`, `implementador`, `revisor-codigo`) y el modelo fijado por rol.
- **Puestos al día los archivos copiados del estándar** (commit `f9599c2`), que eran del 2026-09-06 con 24 PR de atraso. Lo crítico: `.github/scripts/validar-manifiesto.py` **no estaba** y el reusable actual **falla** si falta, no solo avisa; sin ese archivo el primer PR tras la actualización se caía en el job `preparar`. Se comprobó antes, archivo por archivo, que solo `_reusable-security.yml` y `dependabot.yml` tenían diferencias propias, y que ninguna era una adaptación del proyecto.
- **Forzadas tres subdependencias a su versión con corrección** (commit `3014afa`): `brace-expansion`, `fast-uri` e `ip-address`. El `security-local.sh` nuevo —que además corre `npm audit`— dejó el informe en **BLOQUEA con 12 HIGH y 23 MEDIUM**; ninguna de las tres es dependencia directa, así que la única vía era `overrides` en `pnpm-workspace.yaml`, con rango exacto por línea mayor.
- **Completada la excepción de vitest** (commit `ce869c7`): la del 2026-09-20 nombraba solo `osv-scanner` y la comparación es por (herramienta, id), así que trivy reportaba el mismo hallazgo sin exceptuar.
- **En el estándar** (rama `fix/validar-manifiesto-formato-ruff`, 1 commit **sin publicar**): el `validar-manifiesto.py` del PR #26 no pasaba el hook `ruff-format` que el propio estándar reparte, y por eso hizo fallar los tres commits de esta sincronización. Se formateó con ruff 0.13.0 —la versión del `rev` repartido— y se agregó el control al CI del estándar, acotado a `02-pipelines/scripts/`, que es lo único que se copia a los repositorios.

### Verificaciones

- `pnpm install --frozen-lockfile` ✓ con la cuarentena activa · `pnpm verificar` ✓ (**74 pruebas**) · simulación completa ✓ (59 líneas, salida 0).
- `security-local.sh`: **APROBADO — CRITICAL 0 · HIGH 0 · MEDIUM 0**, 4 hallazgos exceptuados (los de vitest en osv-scanner y en trivy). Las seis herramientas corrieron; ninguna quedó sin ejecutar.
- `actionlint` ✓ y `yamllint` ✓ sobre los seis workflows · `bash -n` de `deploy.sh` y `security-local.sh` ✓ · el manifiesto valida con el script recién copiado ✓ · `./deploy.sh staging --dry-run` llega a la fase 7/7 con salida 0.
- En el estándar: `validacion_manifiesto.py` ✓ (25 casos) y `ruff format --check` ✓.
- **No verificado aquí**: ShellCheck no está instalado en este equipo (lo corre el CI del estándar).

### Corrección de lo anotado el 2026-09-20

El pendiente 4 de la entrada anterior decía que la sincronización con el estándar no entraba en el PR #1. Entra: el PR #1 *es* la aplicación del estándar y sigue abierto, así que dejarlo en una versión con 24 PR de atraso para después abrir un segundo PR que lo actualice era peor.

### Pendientes (por orden)

1. 🔑 **Elegir los proyectos GCP.** Existe **`rag-generico`** (creado el 2026-09-17, activo, sin APIs habilitadas salvo `runtimeconfig`), que por nombre y fecha parece ser el previsto para esto. Falta decidir si se usa para staging y se crea otro para producción, o alguna otra combinación. Con eso resuelto: correr `setup-oidc-gcp.sh`, cargar `GCP_WIF_PROVIDER` y `GCP_SA_DEPLOY_STAGING`, y reemplazar los cuatro «A CONFIRMAR» de `.devsecops.yml`. `construir` es el único job del PR #1 en rojo y es por esto.
2. 🔑 Publicar los 5 commits de este repositorio y el commit del estándar; abrir el PR del estándar. Esperan autorización.
3. **Migrar a vitest 4** (rama propia). Las excepciones de `CVE-2026-84373` vencen el **2026-12-19** y ese es el plazo. Ojo: `dependabot.yml` ignora las versiones mayores, así que Dependabot **no** va a proponer esta actualización; se abre a mano.
4. Rulesets y Environments (`staging`, `production` con revisores) en GitHub.
5. Primer despliegue a staging por el pipeline; pruebas contra Vertex real. **Fusionar el PR #1 dispara el despliegue a staging**, así que el punto 1 va antes.
6. Aprobación del corpus por Interseguros/Alianza; panel de configuración web; canal WhatsApp y memoria persistente.

## 2026-09-20 · Cuarentena de dependencias y validación única del manifiesto

### Qué se hizo

- **Activada la cuarentena de 7 días** (`minimumReleaseAge: 10080` en `pnpm-workspace.yaml`, commit `8aa61dc`). Quedó pendiente el 2026-09-06 porque el lockfile de entonces tenía 26 entradas más nuevas que la ventana y rompía `pnpm install --frozen-lockfile`; la más reciente era del 2026-09-04, así que el lockfile completo cumple la ventana desde el 2026-09-11 y entró sin regenerarlo ni mover dependencias. Se declaró también `min-release-age=7` en `.npmrc`, para que cualquier uso de npm sobre el repositorio quede bajo la misma ventana. Con esto **cierran los dos MEDIUM de semgrep** que quedaban abiertos.
- **En el estándar compartido** (`SeguridadGeneral`, rama `fix/validar-manifiesto-compartido`, 2 commits **sin publicar**):
  - La validación de `.devsecops.yml`, que desde el 2026-09-07 vivía dentro de `_reusable-security.yml`, se extrajo a `02-pipelines/scripts/validar-manifiesto.py`. Ahora el job `preparar` **y** `security-local.sh` ejecutan el mismo archivo, que `bootstrap-repo.sh` copia a `.github/scripts/`. Antes solo validaba CI: un manifiesto con una fecha sin comillas pasaba el análisis local y fallaba recién en el pipeline, que es justo la divergencia que el script local existe para evitar.
  - `bootstrap-repo.sh` **siembra la excepción de `CKV_GHA_7`** en el manifiesto que genera, con `creado` de hoy y `vence` a 90 días. Sin ella, todo repositorio que adopte el estándar arranca con checkov bloqueando por el `release.yml` que el propio script acaba de copiar.
  - 22 pruebas nuevas (`02-pipelines/pruebas-workflows/validacion_manifiesto.py`), registradas en el CI del estándar: comportamiento del validador, el manifiesto que genera `bootstrap-repo.sh` para tres combinaciones de stack y modo, y el cableado de los tres consumidores.
- **Ya resuelto aguas arriba por otras sesiones**: el umbral local de `CKV_GHA_7` (PR #20 del estándar dejó a checkov corriendo y bloqueando igual que el job `iac` de CI). De los tres puntos que quedaron a decisión del propietario el 2026-09-07, este no hacía falta tocarlo.

### Verificaciones

- `pnpm install --frozen-lockfile` ✓ (384 entradas bajo la política de cadena de suministro, ya con la cuarentena activa) · `pnpm verificar` ✓ (tipos, lint, **74 pruebas**).
- `security-local.sh`: **CRITICAL 0 · HIGH 0 · MEDIUM 2**. Los dos MEDIUM anteriores (`min-release-age`) desaparecieron; los dos actuales son el mismo aviso nuevo, descrito abajo.
- En el estándar: `pruebas-security-local.sh` ✓, `pruebas-tuberias-pipefail.sh` ✓ (21 casos), `validacion_manifiesto.py` ✓ (22 casos). Se ejecutó además el `run:` real del paso del workflow contra repositorios simulados. **ShellCheck y actionlint no están instalados en este equipo**: los ejecuta el CI del estándar.

### Pendientes (por orden)

1. 🔑 **Publicar y abrir el PR del estándar** (`fix/validar-manifiesto-compartido`, 2 commits) y **publicar el commit `8aa61dc`** de este repositorio. Ambos esperan autorización.
2. 🔑 Sigue pendiente todo lo 🔑 de las sesiones anteriores: secretos de Actions (`GCP_WIF_PROVIDER`, `GCP_SA_DEPLOY_STAGING` vía `setup-oidc-gcp.sh`), proyectos GCP «A CONFIRMAR» del manifiesto, rulesets y Environments. `construir` es el único job del PR #1 que sigue en rojo, y es por esto.
3. **`vitest@3.2.7` — CVE-2026-84373 / GHSA-82fw-gwwq-j7x9 (MEDIUM, path traversal en `@vitest/mocker`)**. Apareció después del 2026-09-07. No hay corrección en la línea 3.x: la primera versión corregida es **4.1.11**, o sea una actualización mayor del marco de pruebas. Es dependencia de desarrollo y el vector exige un mock `redirect` con ruta controlada por un tercero, que este repositorio no usa. Decidir entre subir a vitest 4 en su propia rama o registrar una excepción con vencimiento; **no se hizo ninguna de las dos en esta sesión**.
4. **Sincronizar este repositorio con el estándar.** Las copias de `.github/workflows/_reusable-*.yml`, `security-local.sh` y `deploy.sh` son del 2026-09-06 y el estándar lleva más de veinte PR desde entonces (SARIF por componente, `nosemgrep` fuera del SARIF que sube a Code Scanning, excepciones de `npm-audit` en CI, detección de IaC bajo `pipefail`, y la validación del manifiesto de esta sesión). Es un cambio propio, en su rama: no entra en el PR #1.
5. Primer despliegue a staging por el pipeline; pruebas contra Vertex real. **Ojo**: fusionar el PR #1 dispara el despliegue automático a staging, así que los secretos del punto 2 deben estar cargados antes.
6. Aprobación del corpus de SeguroLoTengo por Interseguros/Alianza; panel de configuración web; canal WhatsApp y memoria persistente.

## 2026-09-06 · Puesta en marcha local y cadena de suministro

### Qué se hizo

- **Repositorio operativo en `~/ChatBotRAG`**: historial restaurado desde `chatbotrag.bundle` con `./iniciar.sh` (8 commits, ramas `main` y `chore/estandar-devsecops`, remoto `origin`). Se recuperaron los 24 archivos que la copia no pudo escribir (`.claude/`, `.github/`, `.npmrc`, `.pre-commit-config.yaml`). Dependencias instaladas; `pnpm verificar` y `validar-config` en verde.
- **Corregido el HIGH de `secrets: inherit`** (`ci-node-cloudrun.yml`, commit `7f00a09`): el reusable de seguridad recibe ahora solo `GITLEAKS_LICENSE` y `SNYK_TOKEN`, los dos que declara en `on.workflow_call.secrets`; ya no se le pasan los secretos de despliegue (WIF, Cloud Run).
- **Endurecida la cadena de suministro de pnpm** (`pnpm-workspace.yaml`, commit `003d2e5`): `blockExoticSubdeps: true` y `trustPolicy: no-downgrade`.
  - `trustPolicyExclude` exime a `undici-types@6.21.0` **con versión exacta** (un nombre a secas eximiría a todas las versiones). Lo fija `@types/node@22.20.1` (rango `~6.21.0`) y no lleva atestación de provenance por ser anterior a la publicación por OIDC del paquete (7.x en adelante). Verificado contra el registro: lo publicó `matteo.collina`, mantenedor legítimo de undici; **no es una toma de control**. Se retira al subir `@types/node` a una versión que use `undici-types` 7.x.

### Verificaciones

- `pnpm install --frozen-lockfile` ✓ (política de cadena de suministro: 384 entradas) · `pnpm verificar` ✓ (tipos, lint, **74 pruebas**) · `pnpm validar-config` ✓.
- `security-local.sh`: **CRITICAL 0 · HIGH 0 · MEDIUM 3**. A diferencia de la sesión fundacional, **semgrep y trivy sí corrieron completos** en este equipo; por eso apareció el HIGH de `secrets: inherit`, que aquel informe no podía ver. La cifra «MEDIUM 1» de la entrada anterior queda superada por esta.
- `actionlint`, `gitleaks` y `yamllint` ✓ mediante `pre-commit run --files` sobre los archivos tocados. **Los hooks no están instalados en `.git/hooks`** (el bundle no los trae): se ejecutaron a mano. Para automatizarlos: `pre-commit install --install-hooks`.

### Pendientes (por orden)

1. 🔑 Sigue pendiente todo lo 🔑 de la sesión fundacional: publicar el repositorio, abrir el PR del estándar, secretos/variables de Actions y proyectos GCP.
2. **A partir del 2026-09-11**: activar `minimumReleaseAge: 10080` en `pnpm-workspace.yaml`. Hoy rompe `pnpm install --frozen-lockfile` porque 26 entradas del lockfile son más nuevas que la ventana de 7 días (la más reciente es del 2026-09-04). Pasada esa fecha se activa agregando la línea, sin regenerar el lockfile ni mover dependencias. Es uno de los 3 MEDIUM abiertos, junto con el `min-release-age` de `.npmrc` y CKV_GHA_7 en `release.yml`.
3. Propagar al estándar compartido (`SeguridadGeneral/02-pipelines/workflows/`) el reemplazo de `secrets: inherit` por el mapeo explícito: afecta a `ci-aws-ecs`, `ci-multicloud`, `ci-node-firebase`, `ci-oci-terraform` y `ci-python-cloudrun`. `_reusable-dast.yml` no declara secretos y no se toca. Decisión del propietario.
4. Evaluar si la exención de `undici-types@6.21.0` debe registrarse además en `seguridad.excepciones` de `.devsecops.yml` con vencimiento, o si basta el comentario en `pnpm-workspace.yaml` por tratarse de configuración de pnpm y no de una supresión de escáner.

## 2026-09-06 · Sesión fundacional

### Qué existe

- Monorepo pnpm 11 / Node 22 / TypeScript estricto con 6 paquetes: `nucleo`, `proveedor-vertex`, `proveedor-bedrock`, `conocimiento-pgvector`, `canal-web`, `servicio`. Arquitectura en `docs/ARQUITECTURA.md`.
- Esquema JSON de agente (Zod → `configuracion-agente.schema.json`) con **perfiles** superponibles.
- Compuertas de entrada (cédula PY/BO, tarjeta Luhn, OTP, clave, salud/PEP en primera persona, inyección) y de salida (niega IA, promesa de indemnización, decisión de elegibilidad, término confidencial, marca inventada, cobro simulado).
- Prompt: reglas fijas → frases por enumerado → fecha/hora → alcance → herramientas → orientación → DATOS rotulados → RESPALDO documental → aviso de «sin respaldo».
- RAG en memoria (BM25 + coseno opcional) y pgvector; troceado por encabezados con ids deterministas; solo fuentes `publico` se indexan.
- Orquestador con bucle de herramientas acotado, memoria con TTL, bitácora sin texto, derivación.
- Servicio Fastify: autenticación por SHA-256 de clave en tiempo constante, límites por IP y cliente, CORS por cliente, herramientas `http` firmadas HMAC, Dockerfile multi-stage (usuario `node`).
- Configuraciones: `segurolotengo.json` (4 perfiles, corpus derivado de los textos versionados del demo) y `comercio-agendamiento.json` (NovuChat Demo A).
- Integración en `segurolotengo-demo` entregada como cambios en el árbol de trabajo del repo del demo y como parche en `integraciones/segurolotengo-demo/`.
- Estándar DevSecOps v2 aplicado (rama `chore/estandar-devsecops`): workflow `ci-node-cloudrun.yml`, manifiesto, CLAUDE.md, scripts.

### Verificaciones

- `pnpm verificar`: tipos ✓, lint ✓, **74 pruebas ✓** (núcleo 48, Vertex 6, Bedrock 5, pgvector 4, canal-web 3, servicio 8).
- `pnpm validar-config configuraciones/*.json` ✓ (4 perfiles + 0).
- Simulación completa con proveedor simulado (`scripts/simular-conversacion.mts`): respaldo correcto por perfil, bloqueo de cédula y salud, sin respaldo → derivación, recomendación determinista, fuente interna no indexada.
- `actionlint` ✓ · `shellcheck` ✓ · `security-local.sh`: CRITICAL 0 · HIGH 0 · MEDIUM 1 (CKV_GHA_7 en `release.yml`, propio del estándar). Trivy y Semgrep no pudieron descargar sus bases desde el entorno de la sesión (sin salida a `mirror.gcr.io`/reglas): **el pipeline de CI los ejecuta completos**.
- Demo: `npm run typecheck` ✓, `npm run lint` ✓ (0 errores), **1282 pruebas ✓** con la integración.

### No verificado en esta sesión (requiere nube o equipo del propietario)

- Llamadas reales a Vertex AI y Bedrock (los adaptadores están probados con clientes falsos contra la forma exacta de los SDK).
- Despliegue en Cloud Run (`deploy.sh --dry-run` se detiene en la ausencia de `gcloud` en el entorno de la sesión).
- Build de Next.js y E2E del demo con el widget.
- Push a GitHub: el entorno de la sesión no tiene credenciales del repositorio; el repositorio se entrega en `~/ChatBotRAG` con un `bundle` de git.

### Pendientes (por orden)

1. 🔑 Publicar el repositorio (push de `main` y `chore/estandar-devsecops`), abrir el PR del estándar y configurar secretos/variables de Actions (`docs/GUIA-DESPLIEGUE-GCP.md` §2 y §5).
2. 🔑 Elegir proyectos GCP de staging/producción y completar `.devsecops.yml` (marcados «A CONFIRMAR») y `CONFIGURACION.local.md`.
3. Primer despliegue a staging por el pipeline; pruebas contra Vertex real (200 casos, incluidos ataques de instrucciones).
4. Aprobación del corpus de SeguroLoTengo por Interseguros/Alianza (Fase 1 de la especificación de Terra).
5. Panel de configuración web (segunda entrega, decidido el 06-sep-2026).
6. Canal WhatsApp (puente Meta Cloud API → `/v1/...`), reutilizando el módulo WhatsApp-Modular; memoria persistente (Firestore/Redis) para más de una instancia.
