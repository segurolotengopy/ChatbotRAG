# ChatbotRAG

Agente conversacional **genérico**, configurable por JSON, con recuperación documental (RAG) y tres capas de abstracción independientes: el **canal** por el que habla la persona (web, app móvil, WhatsApp, Telegram), la **nube** donde corre el modelo (Vertex AI en Google Cloud, Amazon Bedrock, o un simulador para pruebas) y el **conocimiento** que respalda cada respuesta (índice en memoria, PostgreSQL + pgvector).

El mismo núcleo atiende a un comercio que agenda citas, a un canal de venta de seguros o a la landing de una empresa de servicios: cambia el archivo de configuración y el corpus, no el código.

```
cliente (web · app · WhatsApp) ──► servicio HTTP ──► núcleo ──► proveedor LLM (Vertex | Bedrock | simulado)
                                                    │
                                                    └──► índice de conocimiento (memoria | pgvector)
```

## Qué lo distingue

- **Configuración por JSON validada** (`paquetes/nucleo/esquemas/configuracion-agente.schema.json`): identidad, voz (enumerados), alcance, conocimiento, seguridad, herramientas, orientación, mensajes, modelo y **perfiles** (un perfil por producto, por sucursal, por tema…).
- **Seguridad en código, no en el prompt**: compuertas de entrada (cédula, tarjeta, salud, PEP, códigos, inyección) que impiden que el dato llegue al modelo, y compuertas de salida (niega ser IA, promete indemnización, decide elegibilidad, término confidencial, marca inventada) que corrigen o reemplazan la respuesta.
- **Sin respaldo no hay afirmación**: solo se indexan fuentes `publico`; sin fragmentos por encima del umbral, el agente responde el mensaje fijo y deriva a una persona.
- **Orientación determinista**: las recomendaciones salen de reglas configuradas sobre facetas no sensibles; el modelo pregunta, la regla decide.
- **Bitácora sin texto**: se registra hash de conversación, latencia, tokens y compuertas; nunca el mensaje.
- **Nube intercambiable**: cambiar `modelo.proveedor` de `vertex` a `bedrock` no toca el núcleo.

## Estructura

| Ruta | Contenido |
|---|---|
| `paquetes/nucleo` | núcleo sin dependencias de nube |
| `paquetes/proveedor-vertex`, `paquetes/proveedor-bedrock` | adaptadores de modelo y embeddings |
| `paquetes/conocimiento-pgvector` | índice persistente |
| `paquetes/canal-web` | contrato HTTP, cliente y widget embebible |
| `servicio` | API Fastify para Cloud Run (Dockerfile en la raíz) |
| `configuraciones` | agentes de ejemplo: `segurolotengo.json` (seguros, 4 perfiles) y `comercio-agendamiento.json` (comercio) con su `corpus/` |
| `integraciones/segurolotengo-demo` | parche de la integración en el sitio SeguroLoTengo |
| `docs/ARQUITECTURA.md` | diseño y principios; `docs/GUIA-DESPLIEGUE-GCP.md`: puesta en marcha en Google Cloud |

## Empezar

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm verificar                       # tipos + lint + pruebas
pnpm validar-config configuraciones/*.json
node --import tsx scripts/simular-conversacion.mts   # conversación completa sin nube
pnpm servicio:dev                    # http://localhost:8080/salud (proveedor simulado)
```

Configuración por ambiente: `CONFIGURACION.md` (plantilla pública) y `CONFIGURACION.local.md` (valores reales, ignorado por git). Política del repositorio: `CLAUDE.md`. Estado y bitácora: `ESTADO.md`.

## Licencia

Apache-2.0.
