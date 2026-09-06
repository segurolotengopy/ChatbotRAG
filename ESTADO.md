# ESTADO — bitácora viva del proyecto ChatbotRAG

Se actualiza al final de cada sesión. **Nunca contiene secretos.** Lo más reciente arriba.

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
