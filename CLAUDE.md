# ChatbotRAG — memoria del proyecto para Claude Code

Estándar DevSecOps v2.0 (2026-08-24). Stack: `node-cloudrun` (workflow `ci-node-cloudrun.yml`, adaptado del `python-cloudrun` del estándar) · Proveedor: `cloudrun` · Modo: `A` · Estándar local: `/home/andres-alberdi/SeguridadGeneral`

## Descripción

ChatbotRAG es un **agente conversacional genérico**, configurable por JSON, con recuperación documental (RAG) y tres capas de abstracción independientes: **canal** (web, app, WhatsApp, Telegram), **nube** (Vertex AI en GCP, Bedrock en AWS, simulado para pruebas) y **conocimiento** (índice en memoria, pgvector, Vertex AI Search a futuro). Nació de generalizar el chatbot de NovuChat (comercio con citas) y su primera aplicación es el asistente «Terra» de `segurolotengo-demo`, con un perfil por tipo de seguro. La arquitectura completa está en `docs/ARQUITECTURA.md`; **léala antes de tocar el núcleo**.

Repositorio **público** (Modo A): ningún dato real de clientes, ninguna clave, ningún corpus confidencial. Las configuraciones de `configuraciones/` son ejemplos; los valores por ambiente van en `CONFIGURACION.local.md` (ignorado por git) y en Secret Manager.

Monorepo pnpm (Node 22, TypeScript estricto, ESM):

| Paquete | Rol |
|---|---|
| `paquetes/nucleo` | esquema de configuración (Zod → JSON Schema), perfiles, compuertas de entrada/salida, armado del prompt, RAG en memoria, memoria de conversación, herramientas internas, orquestador, proveedor simulado. **Sin dependencias de nube.** |
| `paquetes/proveedor-vertex` | Gemini + embeddings en Vertex AI (`@google/genai`, ADC, sin API key). |
| `paquetes/proveedor-bedrock` | Converse API + Titan (`@aws-sdk/client-bedrock-runtime`). |
| `paquetes/conocimiento-pgvector` | índice persistente PostgreSQL + pgvector (`sql/001-esquema.sql`). |
| `paquetes/canal-web` | contrato HTTP tipado, cliente ligero y widget embebible (`dist-web/chatbotrag-widget.js`). |
| `servicio` | API Fastify para Cloud Run: autenticación por cliente (SHA-256 de la clave, tiempo constante), límites por IP y por cliente, CORS por cliente, herramientas `http` firmadas con HMAC. |
| `configuraciones/` | agentes de ejemplo (`segurolotengo.json`, `comercio-agendamiento.json`) y su `corpus/`. |
| `integraciones/segurolotengo-demo/` | parche con la integración aplicada al demo (puerto `AsistenteProvider`). |

Flujo: trabajo en ramas `feat/*`, `fix/*`, `chore/*`, `hotfix/*` → PR hacia `main` (squash) → merge despliega automáticamente a **staging** → tag `vX.Y.Z` despliega a **producción** con aprobación humana. El manifiesto `.devsecops.yml` declara componentes, proveedores y ambientes; léalo antes de tocar workflows o scripts de despliegue.

## Comandos

| Acción | Comando |
|---|---|
| Instalar dependencias | `pnpm install --frozen-lockfile` (pnpm 11 vía Corepack; `allowBuilds` en `pnpm-workspace.yaml` es la única lista de scripts de instalación permitidos) |
| Tipos y compilación de todos los paquetes | `pnpm tipos` (= `tsc -b`) |
| Lint | `pnpm lint` |
| Pruebas | `pnpm pruebas` · con cobertura: `pnpm pruebas:cobertura` |
| Todo lo anterior (portón antes de commit) | `pnpm verificar` |
| Regenerar el JSON Schema de la configuración | `pnpm esquema` (escribe `paquetes/nucleo/esquemas/configuracion-agente.schema.json`; se versiona) |
| Validar configuraciones de agentes | `pnpm validar-config configuraciones/*.json` |
| Simular una conversación sin nube | `node --import tsx scripts/simular-conversacion.mts` |
| Servicio local con proveedor simulado | `pnpm servicio:dev` (puerto 8080, proveedor simulado; clave Bearer de desarrollo: `clave-local-de-desarrollo-2026`, cuyo SHA-256 está en el script) |
| Widget web | `pnpm --filter @chatbotrag/canal-web run construir` → `paquetes/canal-web/dist-web/` |
| Imagen | `docker build -t chatbotrag .` |
| Seguridad estática local | `./security-local.sh` (informe en `.security-reports/ultimo/resumen.md`) |
| Desplegar a staging | `./deploy.sh staging` (`--dry-run` para ver los comandos) |
| Desplegar a producción | **No lo ejecute.** Lo hace una persona: tag `vX.Y.Z` + aprobación del Environment (A/B) o `workflow_dispatch` del `ci-*` con `confirmar=DESPLEGAR` (B0). Ver `/pase-a-produccion`. |
| Validar workflows | `actionlint .github/workflows/*.yml` |

## Reglas obligatorias antes de dar por terminada cualquier tarea

1. **Pruebas en verde**: ejecute la suite completa; si añade funcionalidad, añada pruebas. No marque una tarea como terminada con pruebas fallando o saltadas.
2. **`./security-local.sh` sin CRITICAL ni HIGH** no exceptuados. Si faltan herramientas, indíquelo explícitamente en su respuesta; un análisis vacío no equivale a un análisis limpio.
3. **Conventional Commits** con los tipos admitidos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `security`, `revert`; descripción en español permitida. Un cambio por commit; sin `--no-verify`.
4. **Nunca confirme (commit) secretos**: ni `.env`, ni claves, ni JSON de service accounts, ni tokens en código o en workflows. Los secretos se referencian por nombre (`secrets.GCP_WIF_PROVIDER`), nunca por valor. Si detecta uno en el historial, deténgase e informe.
5. **Nunca degrade reglas de seguridad de datos ni de IAM**: `firestore.rules`, `storage.rules`, políticas IAM, trust policies OIDC, roles de service accounts. Un cambio que amplíe permisos requiere justificación escrita en el PR y aprobación del propietario.
6. **Nunca despliegue a producción** ni cree el tag `vX.Y.Z` sin instrucción explícita de una persona; nunca use `deploy.sh prod`, `--forzar`, `gh workflow run ci-*.yml` con `confirmar=DESPLEGAR`, ni apruebe un Environment. Prepare el pase (`/pase-a-produccion`) y entregue los comandos para que la persona los ejecute.
7. **No desactive controles**: no comente pasos de workflows, no añada `continue-on-error`, no relaje `bloquear_en`, no cree `.trivyignore`/`.semgrepignore` para ocultar hallazgos. Las excepciones van solo en `seguridad.excepciones` de `.devsecops.yml`, con `vence`, y las aprueba el propietario.
8. **Acciones fijadas por SHA** con comentario de versión en todo workflow que edite (convenciones en `/home/andres-alberdi/SeguridadGeneral/00-gobernanza/00-convenciones.md`; tabla de SHAs vigente en `/home/andres-alberdi/SeguridadGeneral/02-pipelines/README.md`).
9. **Revise el diff antes de proponer el commit** (`git diff --cached`) y use `.github/PULL_REQUEST_TEMPLATE.md` al abrir PRs.

## Documentos de referencia (léalos por ruta cuando la tarea lo requiera)

| Tema | Documento |
|---|---|
| Convenciones (nombres, jobs, variables, manifiesto) | `/home/andres-alberdi/SeguridadGeneral/00-gobernanza/00-convenciones.md` |
| Política maestra, fases, roles, severidades, excepciones | `/home/andres-alberdi/SeguridadGeneral/00-gobernanza/01-politica-cicd-devsecops.md` |
| Flujo git, ramas, tags, Conventional Commits | `/home/andres-alberdi/SeguridadGeneral/00-gobernanza/02-flujo-git-y-versionado.md` |
| Ambientes, modos A/B/B0, aprobaciones | `/home/andres-alberdi/SeguridadGeneral/00-gobernanza/03-ambientes-modos-y-aprobaciones.md` |
| Herramientas y costos | `/home/andres-alberdi/SeguridadGeneral/00-gobernanza/04-matriz-herramientas-y-costos.md` |
| Multicloud y manifiesto | `/home/andres-alberdi/SeguridadGeneral/00-gobernanza/05-estrategia-multicloud.md` |
| Secretos y variables (nombres exactos) | `/home/andres-alberdi/SeguridadGeneral/01-seguridad/01-gestion-de-secretos.md` |
| OIDC / WIF por nube | `/home/andres-alberdi/SeguridadGeneral/01-seguridad/02-identidad-federada-oidc.md` |
| Hardening GCP/Firebase, AWS, OCI | `/home/andres-alberdi/SeguridadGeneral/01-seguridad/03-hardening-por-nube.md` |
| Contenedores, IaC, SBOM, firma | `/home/andres-alberdi/SeguridadGeneral/01-seguridad/04-contenedores-iac-y-cadena-de-suministro.md` |
| Checklist de pase a producción | `/home/andres-alberdi/SeguridadGeneral/01-seguridad/05-checklist-pase-a-produccion.md` |
| Rollback e incidentes | `/home/andres-alberdi/SeguridadGeneral/01-seguridad/06-rollback-e-incidentes.md` |
| Workflows y configuración de escáneres | `/home/andres-alberdi/SeguridadGeneral/02-pipelines/README.md`, `workflows/`, `config/` |
| Scripts operativos | `/home/andres-alberdi/SeguridadGeneral/03-scripts/` (`deploy.sh`, `security-local.sh`, `bootstrap-repo.sh`, `setup-oidc-*.sh`) |
| Esta integración | `/home/andres-alberdi/SeguridadGeneral/04-claude-code/README.md` |

## Convenciones de código

- **Idioma: español en todo** — nombres de archivos (`compuertas/salida.ts`), identificadores (`resolverConfiguracion`, `armarPrompt`), comentarios, commits, pruebas (`*.prueba.ts`) y documentación; español latinoamericano formal, **sin voseo** (el trato al cliente final lo decide `voz.tratamiento`, que sí admite `vos`). Excepción: los nombres de los SDK y de la API de Fastify.
- **Comentarios narrativos**: cada módulo abre con un bloque que explica el porqué, el defecto que motivó el control y qué NO garantiza (herencia de NovuChat y segurolotengo-demo).
- **Frontera de nube (lint la hace cumplir)**: nada fuera de `paquetes/proveedor-*` y `paquetes/conocimiento-*` importa `@google/genai`, `@aws-sdk/*` ni `pg`; el núcleo no usa `fetch`. Un proveedor nuevo es un paquete nuevo que implementa `ProveedorLLM`/`Embebedor`/`IndiceConocimiento`.
- **Lo que determina comportamiento es enumerado; el texto libre es DATO.** Un valor de configuración jamás se interpola en las reglas del prompt: selecciona una frase de `prompt/frases.ts`. Las prohibiciones duras viven en `compuertas/salida.ts`, no en el prompt.
- **Los campos derivados se calculan** (`configuracion/derivados.ts`); no existen en el esquema.
- **Bitácora sin texto**: ningún evento lleva el mensaje de la persona ni del asistente. La prueba `la bitácora nunca contiene el texto de los mensajes` lo verifica; no la debilite.
- **Secretos**: nunca en `configuraciones/*.json` (el validador rechaza claves por forma), nunca en el repo. Credenciales de nube por identidad del entorno (ADC / rol); clave de clientes solo como SHA-256 en `CHATBOTRAG_CLIENTES`.
- TypeScript estricto (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), sin `any`; Zod en el borde; Vitest con cobertura mínima 70 %.
- Contenedores: Dockerfile multi-stage, usuario `node`, sin secretos en `ARG`/`ENV`.

## Qué hacer ante hallazgos de seguridad

1. Lea `.security-reports/ultimo/resumen.md` (o el SARIF del pipeline). Clasifique por severidad y herramienta.
2. CRITICAL/HIGH: corrija en la misma rama antes de continuar. Si es una dependencia, actualice a la versión con fix y vuelva a correr pruebas; si no hay fix, documente el análisis y proponga al propietario una excepción con `id`, `herramienta`, `componente`, `justificacion`, `aprobado_por`, `creado`, `vence` (máximo 90 días).
3. MEDIUM: corrija si el costo es bajo; si no, regístrelo en el PR con fecha de compromiso (30 días).
4. Secreto detectado (gitleaks, secret scanning): no lo borre "en silencio". Informe al propietario, rote la credencial y luego limpie el historial según `/home/andres-alberdi/SeguridadGeneral/01-seguridad/01-gestion-de-secretos.md`.
5. Falso positivo: justifíquelo con evidencia (línea, contexto, por qué no es explotable) en la excepción; nunca editando la configuración del escáner para silenciar la regla completa.
6. Delegue el análisis detallado al agente `seguridad` cuando el hallazgo no sea trivial; entregue su informe en el PR.

## Subagentes disponibles (`.claude/agents/`)

| Agente | Úselo para | No puede |
|---|---|---|
| `devsecops` | Aplicar o corregir el estándar: workflows, manifiesto, rulesets, pines por SHA, `bootstrap-repo.sh`, migrar de v1 a v2 | Relajar controles; añadir excepciones |
| `seguridad` | Revisar código, reglas Firestore/IAM, Dockerfiles, IaC, dependencias; interpretar informes; proponer remediaciones | Modificar archivos (solo lectura y comandos de análisis) |
| `deploy` | Desplegar a staging con `deploy.sh`, diagnosticar despliegues y health checks, guiar rollbacks | Ejecutar `deploy.sh prod`, crear tags, usar `--forzar` |
| `proyectos` | Revisar estado del proyecto frente al estándar, preparar actas de pase a producción, métricas DORA, resúmenes para dirección | Modificar archivos |

Skills: `/aplicar-estandar-devsecops` (repositorio nuevo o desactualizado) y `/pase-a-produccion` (antes de crear un tag de release).
