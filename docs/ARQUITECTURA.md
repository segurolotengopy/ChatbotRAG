# ChatbotRAG — Arquitectura

Versión 0.1 · septiembre de 2026 · español latinoamericano, sin voseo.

## 1. Qué es

ChatbotRAG es un **agente conversacional genérico**, configurable por JSON, con
recuperación de conocimiento (RAG) y **tres capas de abstracción** independientes:

```
   ┌──────────────┐    ┌──────────────────────────────────────┐    ┌──────────────────┐
   │   CLIENTE    │    │              NÚCLEO                  │    │      NUBE        │
   │ web · móvil  │───►│ configuración → compuertas → prompt  │───►│ Vertex (GCP)     │
   │ WhatsApp ·   │◄───│ → recuperación → LLM → compuertas    │◄───│ Bedrock (AWS)    │
   │ Telegram     │    │ → bitácora                           │    │ (simulado, tests)│
   └──────────────┘    └──────────────┬───────────────────────┘    └──────────────────┘
        canales                       │ puertos                          proveedores
                                      ▼
                       ┌──────────────────────────────┐
                       │  CONOCIMIENTO (RAG)          │
                       │  memoria · pgvector ·        │
                       │  Vertex AI Search (futuro)   │
                       └──────────────────────────────┘
```

El **mismo núcleo** atiende a un comercio que agenda citas (el caso de NovuChat), a
una web de seguros (SeguroLoTengo) o a la landing de una empresa de servicios: lo
que cambia es el **archivo JSON de configuración** y el **corpus documental**.

## 2. Principios heredados de NovuChat (y por qué)

Estos principios nacen de incidentes reales de NovuChat (ver `Analisis/` de ese
repo) y acá son **invariantes del núcleo**, no recomendaciones:

| # | Principio | Dónde vive en ChatbotRAG |
|---|-----------|--------------------------|
| 1 | Una prohibición dura **no vive en el prompt**: vive en código, en la última compuerta antes de la salida. | `compuertas/salida.ts` |
| 2 | Los **enumerados se traducen a frases fijas**: el valor del cliente selecciona una frase nuestra, nunca se interpola. | `prompt/frases.ts` |
| 3 | El **texto libre viaja rotulado y delimitado** como DATO, nunca por delante de las reglas. | `prompt/armar.ts` sección `DATOS` |
| 4 | Los **campos derivados se calculan, no se almacenan** (estado operativo, horario legible, "datos que no tenemos"). | `configuracion/derivados.ts` |
| 5 | Lo que falta **se calcula**: la lista de datos desconocidos sale de los campos vacíos, más los declarados. | `configuracion/derivados.ts` |
| 6 | **Clave de sesión explícita** (nunca memoria compartida entre personas). | `orquestador/agente.ts` |
| 7 | El LLM es un **puerto intercambiable**; cambiar de Vertex a Bedrock no toca el núcleo. | `puertos/proveedor-llm.ts` |
| 8 | **Economía de herramientas**: máximo N iteraciones, una llamada por herramienta y turno. | `orquestador/agente.ts` |
| 9 | La **bitácora nunca lleva texto** de mensajes: solo metadatos. | `bitacora/` |
| 10 | El asistente **no niega ser una IA**. | compuerta `niegaIa` |
| 11 | El sistema **falla hacia el mensaje seguro**, nunca hacia el silencio ni hacia la invención. | `mensajes.*` obligatorios en el esquema |

## 3. Modelo de configuración (JSON)

Un agente se describe en un documento `ConfiguracionAgente` validado por
`paquetes/nucleo/esquemas/configuracion-agente.schema.json` (generado desde Zod).
Secciones:

```jsonc
{
  "version": 1,
  "id": "segurolotengo",                 // ^[a-z0-9][a-z0-9-]{2,59}$
  "identidad":   { nombreAsistente, organizacion, descripcion, idioma:"es-PY", zonaHoraria, moneda },
  "voz":         { tratamiento:"usted|tu|neutro", emojis:"ninguno|pocos|muchos",
                   longitud:"breve|media|amplia", registro:"formal|cercano" },       // ENUMERADOS
  "operacion":   { estado:"operativo|suspendido", horarios:{lun:"09:00-18:00",…},
                   prefijosPermitidos:[], contactoHumano:{whatsapp, correo, texto} },
  "datos":       { direccion, politicas:{…}, datosQueNoTenemos:[…], instruccionesExtra }, // TEXTO LIBRE rotulado
  "alcance":     { temasPermitidos:[…], temasBloqueados:[…], accionesProhibidas:[…] },
  "conocimiento":{ modo:"rag|solo_prompt", coleccion, topK, umbral, exigirRespaldo:true,
                   fuentes:[{id, titulo, version, visibilidad:"publico|interno", ruta}] },
  "seguridad":   { bloquearEntrada:["cedula","tarjeta","salud","pep","otp","clave"],
                   compuertasSalida:["niega_ia","promesa_indemnizacion","decision_elegibilidad",
                                     "dato_confidencial","marca_no_declarada"],
                   terminosConfidenciales:[…], maxCaracteresEntrada:2000 },
  "herramientas":[ { nombre, descripcion, parametros(JSON Schema), tipo:"interna|http", … } ],
  "orientacion": { facetas:[{id, pregunta, opciones:[…]}],
                   reglas:[{si:{faceta:valor,…}, recomendar:"<id>", texto:"…"}] },
  "mensajes":    { bienvenida, errorTemporal, fueraDeAlcance, sinRespaldo, derivacion,
                   entradaBloqueada, suspendido, cierre },
  "modelo":      { proveedor:"vertex|bedrock|simulado", nombre, temperatura, maxTokensSalida,
                   maxIteraciones, ventanaMemoria },
  "perfiles":    { "<perfilId>": { …cualquier sección salvo version/id/modelo… } }  // p. ej. por tipo de seguro
}
```

**Perfiles.** Un perfil es una superposición parcial (deep-merge) sobre la base. En
SeguroLoTengo cada tipo de seguro (`VIDA_ONCOLOGICO`, `VIDA`, `ACCIDENTES_PERSONALES`,
`RESPONSABILIDAD_CIVIL`) es un perfil con su propio corpus, sus temas, su orientación
y sus mensajes. El cliente indica `perfilId` en cada mensaje; el núcleo resuelve la
configuración efectiva **por petición**, así el mismo servicio atiende N productos.

**Qué no es configurable desde el JSON**: el prompt base, las frases de los
enumerados, los patrones de las compuertas y los valores de respaldo de los
mensajes. Desde la configuración se aportan **datos**, no comportamiento.

## 4. Recorrido de un mensaje

```
POST /v1/agentes/{agente}/conversaciones/{conversacionId}/mensajes  { perfilId, texto, canal }
 1. autenticar cliente (Bearer por cliente; el agente sale de la clave, no del cuerpo)
 2. limitar (por cliente y por IP, ventana deslizante)
 3. resolver configuración efectiva = base ⊕ perfil       (configuracion/perfiles.ts)
 4. compuertas de ENTRADA (seguridad.bloquearEntrada) ──► si bloquea: mensajes.entradaBloqueada, sin LLM
 5. memoria de la conversación (ventana N, clave = conversacionId)
 6. recuperación: IndiceConocimiento.buscar(texto, {coleccion, topK, umbral}) → fragmentos
 7. armar prompt: REGLAS FIJAS → VOZ (frases) → FECHA/HORA → ALCANCE → ORIENTACIÓN →
                  ═══ DATOS (rotulados) ═══ → ═══ RESPALDO DOCUMENTAL (fragmentos) ═══
 8. bucle LLM ≤ maxIteraciones: texto | llamadas a herramientas (derivar_humano, recomendar, …)
 9. compuertas de SALIDA: corrigen o reemplazan el texto; dejan constancia en `avisos`
10. bitácora (sin texto) → respuesta { texto, respaldo:[{fuente, version}], avisos, derivacion }
```

## 5. Paquetes

| Paquete | Rol | Dependencias externas |
|---------|-----|-----------------------|
| `@chatbotrag/nucleo` | configuración, prompt, compuertas, orquestador, memoria e índice en memoria | `zod` |
| `@chatbotrag/proveedor-vertex` | Gemini + embeddings en Vertex AI | `@google/genai` |
| `@chatbotrag/proveedor-bedrock` | Claude/Titan vía Converse API | `@aws-sdk/client-bedrock-runtime` |
| `@chatbotrag/conocimiento-pgvector` | índice persistente en PostgreSQL + pgvector | `pg` |
| `@chatbotrag/canal-web` | widget embebible (TS puro) y contrato HTTP | — |
| `servicio` | HTTP (Fastify) para Cloud Run; carga configuraciones y corpus | `fastify` |

Regla de dependencias (verificada por lint): **nada fuera de `paquetes/proveedor-*`
y `paquetes/conocimiento-*` importa un SDK de nube**. El núcleo no conoce Google
ni Amazon.

## 6. Seguridad y confidencialidad

- **Entrada**: detectores de cédula (PY/BO), tarjeta (Luhn), OTP, contraseñas y
  vocabulario de salud/PEP. Si algo coincide, el texto **no llega al LLM** ni a la
  memoria; se responde con `mensajes.entradaBloqueada` y se propone derivación.
- **Corpus**: solo se indexan fuentes con `visibilidad: "publico"`. Las fuentes
  `interno` existen en la configuración para que el panel las muestre, pero el
  índice las rechaza en tiempo de carga.
- **Salida**: (a) niega ser IA → se reescribe; (b) promesa de indemnización/decisión
  de elegibilidad/aprobación → se reemplaza por `mensajes.fueraDeAlcance` + derivación;
  (c) `terminosConfidenciales` presentes → se reemplaza; (d) marcas `[X]` no declaradas
  → se eliminan.
- **Respaldo**: con `exigirRespaldo: true`, si no hay fragmentos por encima del umbral
  y la pregunta no es de cortesía ni de orientación, la respuesta es `mensajes.sinRespaldo`.
- **Bitácora**: hash de la conversación, perfil, latencia, tokens, compuertas
  activadas, ids de fragmentos. Nunca el texto.
- **Secretos**: nunca en la configuración JSON (lista blanca de claves; el validador
  rechaza campos con aspecto de secreto).

## 7. Aplicación a segurolotengo-demo

El demo (Next.js 15 en AWS Amplify) **no embebe** el núcleo: consume el servicio por
HTTP mediante el patrón ports/adapters que ya usa:

- `src/ports/asistente-provider.ts` — puerto `AsistenteProvider`.
- `src/adapters/mock/asistente-provider.ts` — responde desde `catalogo.ts` (demo sin red).
- `src/adapters/live/asistente-chatbotrag.ts` — cliente HTTP del servicio (único `fetch`).
- `src/domain/asistente.ts` — caso de uso: filtro local de datos sensibles (defensa en
  profundidad, regla inviolable #7), límite de tamaño, perfil = producto elegido.
- `src/app/api/asistente/mensaje/route.ts` — handler fino con limitador.
- `src/components/shared/ChatFlotante.tsx` — widget con los tokens del proyecto; se
  oculta en las pantallas transaccionales (pago, firma, identidad, declaraciones).

El asistente **no puede invocar** Bancard, Code100 ni SEBAOT: no tiene puerto hacia
ellos y el caso de uso no recibe el expediente.
