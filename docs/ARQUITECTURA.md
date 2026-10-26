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
                   usoDelRespaldo:"citar|parafrasear",
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
                   maxIteraciones, ventanaMemoria, razonamiento:"automatico|desactivado" },
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
  → se eliminan; (e) PAN (13–19 dígitos con Luhn), CVV y OTP con su palabra de contexto
  se redactan como «(dato eliminado)» sin reemplazar la respuesta; corre siempre. No cubre
  dígitos en palabras, homóglifos, un PAN partido en varios mensajes, vencimientos ni datos
  de resultados de herramientas.
- **Respaldo**: con `exigirRespaldo: true`, si no hay fragmentos por encima del umbral
  y la pregunta no es de cortesía ni de orientación, la respuesta es `mensajes.sinRespaldo`.
- **Bitácora**: hash de la conversación, perfil, latencia, tokens, compuertas
  activadas, ids de fragmentos. Nunca el texto.
- **Secretos**: nunca en la configuración JSON (lista blanca de claves; el validador
  rechaza campos con aspecto de secreto).

### Modo `dato` de la compuerta de entrada

`seguridad.vocabularioEntrada` (`palabra` por omisión, `dato`) decide cómo se detectan
`tarjeta` y `otp`. En `palabra` basta el vocabulario («tarjeta», «código de
verificación») y se rechazan también las preguntas de procedimiento. En `dato` se
bloquea solo el DATO: un número con forma de tarjeta (Luhn), un CVV/CVC con sus
dígitos, un vencimiento mes/año, «últimos 4», una secuencia contigua de 8 o más
dígitos que no sea monto, fecha ni celular, y un código numérico (o alfanumérico, con
vocabulario de OTP) junto a «código», «otp» o «token». Deja pasar «¿puedo pagar con
tarjeta?», «no me llega el código de verificación» o «¿qué es el código de seguridad
de la tarjeta?», y los códigos de otra cosa (postal, de póliza, civil…). No cubre un
dato en un segundo mensaje, escrito con palabras o con letras intercaladas, ni un
CVV/OTP con otra redacción. Los detectores operan sobre texto NFKC: dígitos y letras de
ancho completo, ligaduras y espacios no separables cuentan como su forma simple; los
caracteres invisibles y los homóglifos de otros alfabetos, no. `clave`, `cedula`, `salud`, `pep` e `inyeccion` no cambian.
Consecuencia: lo que pasa llega al proveedor del modelo. La política de retención y de
uso de datos de Vertex AI NO está verificada en este repositorio: pendiente de
verificar con la documentación oficial.

### Razonamiento y respuestas cortadas

`modelo.razonamiento` (`automatico` por omisión, `desactivado`) se pasa al proveedor. Vertex
envía `thinkingBudget: 0` con `desactivado`; Bedrock lo ignora. Origen: en la batería de
staging del 24-oct-2026 dos respuestas terminaron en `MAX_TOKENS` con 37 y 64 tokens visibles
de 1.024, porque el razonamiento de Gemini 2.5 se descuenta del mismo presupuesto de salida
(y se cobra como salida; `tokensSalida` ahora lo suma). Gemini 2.5 Pro no admite apagarlo: la
carga rechaza `desactivado` si el nombre del modelo contiene `pro` como palabra («El modelo
gemini-2.5-pro no admite razonamiento desactivado»). En Gemini 3 el parámetro está obsoleto.
Si aun así una respuesta termina en `max_tokens` sin llamar a herramientas, NO se entrega, ni
recortada (cortar en la «última oración» podía dejar una afirmación sin su salvedad o cortar en
«Gs.» o «1.»): sale `mensajes.errorTemporal` más la derivación al canal, con los avisos
`max_tokens` y `respuesta_incompleta`. El motivo de derivación es `respuesta_cortada` solo si no
hay otro (el de la herramienta o el de una compuerta manda). Si el modelo derivó con la
herramienta y luego no dijo nada, se entrega `mensajes.derivacion` con el aviso
`vacia_con_derivacion`. No hay reintento (repetiría toda la entrada). Una respuesta vacía sin
derivación sigue siendo error temporal con `respuesta_vacia`.

### Compuerta `recomienda_plan`

Reemplaza por `fueraDeAlcance` más `derivacion` la respuesta que recomienda un plan. Origen:
PAG-plan-011 de la batería del 24-oct-2026, donde el manual de /plan lleva la etiqueta «PLAN
RECOMENDADO» y el modelo la repitió como recomendación propia. Dos detectores sobre texto
normalizado (sin tildes, sin caracteres de formato Unicode como U+200B): (1) frases con el
sustantivo `plan` («el plan recomendado es…», «le recomiendo el plan…», «le conviene el plan…»,
«el mejor plan…»); (2) un nombre de `seguridad.nombresDePlanes` a seis palabras o menos de un verbo
de recomendación, en cualquier orden («le recomiendo VIVE TOTAL», «yo elegiría VIVE»). Los
nombres son dato, obligatorios y no vacíos si la compuerta está activa, con límites de palabra
(«viven» no es «vive»); «vive» en minúscula cuenta como el nombre, así que «si usted vive en…»
junto a un verbo de recomendación se reemplaza (falla hacia lo seguro). Las instrucciones
legítimas («elija el plan y pulse Continuar», «la mejor opción es consultar a un asesor», «le
recomiendo el PDF de condiciones») pasan. Citar la etiqueta («lleva la etiqueta «PLAN
RECOMENDADO»») también pasa: decisión por defecto, a confirmar por el propietario. No cubre otras
redacciones sin un nombre cerca («lo más indicado sería…»), nombres no declarados ni un plan
aludido sin nombre. No puede convivir con la herramienta `recomendar_opcion` (la carga lo
rechaza). Pendiente ajeno: el caso PAG-plan-002 de SeguroLoTengo espera que se nombre «VIVE
TOTAL» ante una pregunta casi idéntica a la de PAG-plan-011 y la compuerta lo reemplaza.

### Marcas literales

`seguridad.marcasLiterales` lista marcas entre corchetes que son TEXTO de los manuales (por
ejemplo `PENDIENTE_DE_DEFINICION_LEGAL`) y no marcas de control: se conservan intactas, sin
aviso. Origen: PAG-retracto-007 respondió «el plazo está ""» porque la compuerta borraba
`[PENDIENTE DE DEFINICIÓN LEGAL]`. La coincidencia es exacta con la clave normalizada (sin
tildes, mayúsculas, espacios como `_`) y no puede repetirse en `marcasPermitidas`. Las demás
marcas siguen borrándose; no garantiza que el modelo cite la marca.

### Criterio de salud y PEP

`seguridad.criterioSaludPep` (`primera_persona` por omisión, `declaracion`) decide cuándo bloquea
la compuerta de entrada `salud` y `pep`. Con `declaracion` solo queda libre una consulta de
formulario: el mensaje EMPIEZA con «si» condicional (sin tilde; «Sí marco…» es una afirmación y se
comprueba sobre el texto con tildes) seguido de «marco/respondo/pongo/…» (no «declaro» ni «indico»,
que son performativos) y «que (sí) soy PEP» o «que tengo una enfermedad», es una pregunta (lleva «?»
o empieza con «¿») y, quitado el marco, queda una pregunta de procedimiento de lista cerrada
(«¿qué pasa?», «¿qué tengo que hacer?»), no vacía y sin vocabulario de salud ni de PEP. Origen:
PAG-actividad-007 («Si marco que sí soy PEP, ¿qué pasa?»), el único error de los 10 bloqueos de
entrada de la batería. Fuera del marco bloquea lo mismo que `primera_persona`: la prueba
(`entrada-declaracion.prueba.ts`) usa una lista cerrada e independiente de frases adversarias y
los casos de `entrada-por-dato.prueba.ts`; es una muestra, no una demostración para todo texto.
Sobre los 174 mensajes de la batería la única diferencia entre ambos criterios es PAG-actividad-007.
No cambia cédula, tarjeta, código, clave ni inyección. Quien escribe «SI» en mayúsculas sin tilde
pasa como condicional si el resto es una pregunta de procedimiento.

**Límite preexistente en ambos criterios (pendiente de decisión del propietario).** La regla de
`esPreguntaGeneral` deja pasar una declaración de salud o de PEP escrita como pregunta, sin
primera persona verbal clara: «me detectaron un tumor ¿me cubren?», «Fui PEP hasta el año pasado,
¿me afecta?», «Era ministro, ¿puedo contratar?» pasan con `primera_persona` y con `declaracion`.
Las pruebas fijan este comportamiento actual para que un cambio futuro sea deliberado; no lo
aprueban.

### Carga a Kuaa: registros habilitados y oportunidad de venta

`conocimiento/registros-habilitados.ts` (`separarRegistrosHabilitados`) deja pasar a Kuaa solo
los registros con `habilitado_produccion === true` (booleano exacto); `estado_validacion` y
`aprobacion` no habilitan. Falla cerrado («true», 1, «si», null o ausencia no habilitan) y
devuelve de los rechazados solo índice y motivo. No valida la veracidad del contenido ni la
revisión humana. `scripts/validar-paquete-kuaa.mts` imprime únicamente conteos
(`--exigir-habilitados` sale con 1 si no hay ninguno); acepta raíz arreglo, `{registros: [...]}` u
objeto único y falla con cualquier otra. La bandera se lee solo como valor de datos propio (un
getter, un Proxy o un objeto no plano no habilitan) y, si el JSON repite la clave, gana la última.

`oportunidad/esquemas.ts` define, con Zod estricto y enumerados, la etapa comercial E01..E12,
los estados operativos (solicitud, pago, aceptación, póliza, documentos, atención humana), el
estado de objeción, el permiso de seguimiento y el `ContextoOportunidad` mínimo, sin datos
personales. `estadosTrasPropuestaDeEtapa` devuelve una copia sin cambios: una etapa propuesta por el modelo
nunca es evidencia, y en ChatbotRAG no existe ninguna transición operativa (los estados los fija
SLT en cada petición). Contrato F2 v0.3 de SLT: el permiso de seguimiento es
`{vigente, canal}` (sin `evidencia_id`), el contexto lleva `pagina` (con `ID_PAGINA`) y un `resumen` de
enumerados cerrados (necesidad, producto, plan, `objecion_codigo` O01..O32 o `ninguna`,
`objecion_estado` o `ninguna`; cualquier otro valor se rechaza); `oportunidad_id` y `tarifa_version`
tienen formas estrictas. `estados` y
`resumen` son datos y nunca se interpolan en el prompt. Se declaran el enum de tipos de evento (sin
endpoint) y el esquema de salida; `filtrarBotonesSalida` descarta `continuar_pago` si la solicitud
no está completada.

### Agente Kuaa y ruta provisional `POST /v1/kuaa/mensaje`

`tipoAgente: kuaa` (por omisión `general`) marca un agente de oportunidad de venta
(`configuraciones/kuaa.json`: voseo, 0 fuentes de conocimiento, criterio de salud y PEP `declaracion`,
sin `recomienda_plan`). `oportunidad/agente-kuaa.ts` es un recorrido aparte de `Agente.responder`: sanea,
aplica las compuertas de entrada, recupera respaldo, arma el prompt (`prompt-kuaa.ts`: jerarquía, reglas
y contexto elegidos por enumerado, nunca interpolados; `oportunidad_id`, `tarifa_version`, `pagina` y el
código de objeción no entran) y exige un objeto JSON `SalidaOportunidad` dentro del texto del modelo (el
puerto no permite pedir JSON con esquema; temperatura baja desde la configuración). Falla cerrado: JSON
inválido, corte por `max_tokens`, enlace o precio (`salida-kuaa.ts`) o error del proveedor devuelven el
mensaje de error temporal con botones y propuestas vacíos, nunca el texto crudo; sin respaldo se responde
el mensaje fijo; `continuar_pago` solo sobrevive con `solicitud: completada`. La bitácora no lleva texto
ni el id de la oportunidad. La ruta autentica con el Bearer del cliente, responde 404 si su agente no es
Kuaa y 400 sin repetir lo recibido; es PROVISIONAL hasta que SLT fije el contrato.

Límites: no garantiza que la etapa propuesta sea correcta (valida SLT) ni que el detector de enlaces y
precios atrape toda forma; la memoria es en proceso (se pierde al reiniciar y no se comparte entre
instancias). Hallazgo K2b: las compuertas de salida, calibradas con usted y tuteo, no detectan «sos
elegible y estás cubierto» ni «te vamos a pagar la indemnización»; las pruebas lo fijan con `it.fails`.

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
