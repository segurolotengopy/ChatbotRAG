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
| `@chatbotrag/conocimiento-gcs` | lector del paquete de conocimiento de Kuaa desde un bucket privado (solo lectura, ADC) | `@google-cloud/storage` |
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
Consecuencia: lo que pasa llega al proveedor del modelo. Retención y uso de datos de
Vertex AI, según la documentación oficial consultada el 2026-10-23 (detalle, fuentes y
límites en `ESTADO.md`, subsección «P18»): Google no entrena con los datos sin permiso;
para los modelos que no son «Frontier» ni «Advanced AI» puede guardar hasta 90 días y
revisar los prompts que sus clasificadores marquen como sospechosos (los clientes con
Acuerdo Maestro están exentos); la caché implícita guarda hasta 24 horas. No está
verificado bajo qué contrato opera la cuenta ni la retención de los embeddings.

### Tiempo máximo y reintento de Vertex

`ProveedorVertex.generar` limita cada intento a 9 000 ms; lo transitorio se reintenta una vez, sin espera (origen: dos peticiones de Kuaa tardaron 58 s y 20,6 s en staging; el sitio corta a los 20 s). Solo se reintenta lo transitorio: vencimiento del tiempo, estados 500/502/504 y errores de red (el 503 se trata con el 429, abajo); un 400, 401, 403, 404 o un error desconocido sale en el primer intento. El presupuesto de 18,5 s (abajo) vale por llamada al modelo, no por turno (el agente puede llamar hasta `maxIteraciones` veces; Kuaa usa una), y el reintento duplica las llamadas facturables en el peor caso; `crearClienteVertex` no pasa `httpOptions.retryOptions` a propósito (sería 2×5). NO garantiza una respuesta: si todos los intentos fallan, el agente responde con su mensaje de respaldo. El texto propio del error de tiempo no incluye la petición; el error de Vertex se propaga tal cual. El embebedor tiene sus propios tope, reintento y semáforo (párrafo «Embebedor» más abajo).

**Causa enumerada (2026-11-05).** `ErrorProveedor.causa` ∈ `cuota | tiempo | autenticacion | modelo | saturacion | servidor | otro`, derivada de `status`/`code` (un código numérico manda sobre el texto): 429 cuota; 503 saturacion; 504 y vencimiento propio o `ETIMEDOUT` tiempo; 500, 502 y demás 5xx servidor; 401/403 autenticacion; 404 modelo; el límite de concurrencia propio, saturacion; lo demás otro. El tipo y el ayudante `causaDeError` viven en el puerto del núcleo (`puertos/proveedor-llm.ts`); la clasificación, en `proveedor-vertex`. Los eventos `error_modelo` de Kuaa (`proveedor` e `indice`) llevan `causa` (aditivo); nunca el mensaje del error. El agente genérico (`orquestador/agente.ts`, línea del evento `proveedor`) sí registra hasta 200 caracteres del mensaje en `detalle`: defecto previo, para otro PR.

**Reintento del 429 y del 503 (origen: staging, 2026-11-05 23:03-23:05 UTC).** Con 5 hilos en paralelo (~100 mensajes/min) hubo 10 `error_modelo` en ráfagas de 4-5 por segundo, con el texto de respaldo y sin vencimientos; en secuencia 15/15 bien. Hipótesis (no confirmada hasta ver la `causa` en la bitácora): 429 por ráfaga. Ahora el 429 y el 503 se reintentan hasta 2 veces con espera ≈400-900 ms y ≈1 000-2 000 ms (jitter). SUPUESTOS NO VERIFICADOS: que un 429 no se factura, y que la cuota de Gemini en Vertex es por proyecto y no por instancia. Durante una limitación un turno puede hacer hasta 4 llamadas a Vertex (1 + 1 transitorio + 2 por cuota, dentro del presupuesto). El 503 no se desactiva con `reintentos: 0`: va por la vía de saturación (`reintentosCuota`). NO garantiza que la cuota se libere en esos segundos.

**Presupuesto de latencia.** `presupuestoMs` = 18 500 ms (2 × 9 s más 500 ms de holgura de temporizadores), medido desde que empieza `generar` con la cola incluida. Todo reintento (cuota, saturación o transitorio) exige transcurrido + espera + 9 s ≤ presupuesto; si no cabe, se lanza el error. `generar` queda así en ≈18,5 s como máximo. Peor caso de un turno de Kuaa con el reintento de JSON roto (#80, solo si pasaron ≤ 3 s desde la llegada): 3 + 18,5 ≈ 21,5 s, que SÍ pasa de los 20 s del sitio; ese valor vale para la vía del reintento de JSON roto, y la búsqueda en el índice va ANTES de `generar`: desde 2026-11-06 está acotada por el embebedor (≈6 s por búsqueda desde 2026-11-07, ver «Embebedor»; antes no tenía cota), y ese tiempo se SUMA: ≈6 + 18,5 ≈ 24,5 s sin JSON roto (ya sobre los 20 s del sitio) y ≈30,5 s con perfil `pruebas` y dos búsquedas; con el reintento de JSON roto exige un primer intento de ≈3 s con JSON roto y una segunda llamada que agote su presupuesto. Es improbable y NO se garantiza evitarlo.

**Tope de concurrencia.** Semáforo por agente y por instancia (un proveedor por configuración; no por proceso ni por proyecto): 4 llamadas simultáneas por omisión (`maxConcurrentes`), espera máxima en cola 3 s (`esperaMaxColaMs`); agotada, falla rápido con causa `saturacion`. Es opción del constructor, no de la configuración JSON (el esquema no cambia). En staging Cloud Run tiene maxScale 3 (≤ 12 simultáneas); en producción el workflow usa `--max-instances 10` por omisión (hasta 40 en vuelo). El despliegue no cambia, y el 4 por instancia y la cola de 3 s deben medirse con la latencia real (p50 ≈ 1 s en staging) antes de fijarlos en producción. El cupo se mantiene durante los reintentos. Riesgo conocido (MEDIUM), compromiso de corrección a 30 días (2026-12-05): el semáforo no es por cliente, así que un cliente con clave puede dejar sin cupo a otros del mismo agente; no se implementa en este cambio.

**Mensaje al cliente.** Con causa `cuota` o `saturacion` (429, 503 o tope propio), Kuaa responde la frase fija `FRASE_ALTA_DEMANDA` (por `voz.tratamiento`, sin teléfonos ni correos) en lugar de «problema técnico»; las demás causas (incluida `servidor`) siguen con `mensajes.errorTemporal`.

**Embebedor de Vertex (2026-11-06, ajustado tras la revisión).** Origen: en la prueba de staging (rev 00066, 5 hilos × 47 críticas = 265 respuestas) la API de EMBEDDINGS devolvió 429 cuatro veces (causa `cuota` en 4 eventos `error_modelo` con `codigo: 'indice'`, 4 `indice_error`, 4 `sin_respaldo`) y el agente contestó «No tengo información aprobada…» como si no hubiera información: una falla de infraestructura disfrazada de contenido. El modelo de lenguaje no falló ni una vez. `EmbebedorVertex` aplica el mismo patrón que `ProveedorVertex`, con DOS perfiles (opciones del constructor, no de la configuración JSON):

- CONSULTA (`embeber`; la usa `buscar` en cada turno): tope de 4 s por intento (`AbortController`; vencido, causa `tiempo`, sin reintento; era 2,5 s hasta 2026-11-07), 1 reintento del 429 y el 503 con espera ≈400-900 ms (jitter) solo si transcurrido + espera + 4 s ≤ presupuesto de 6 s por llamada (era 4,5 s) (cola incluida), y semáforo de 4 simultáneas con cola de 2 s (agotada, falla rápido con causa `saturacion`). El semáforo es por agente Y por instancia (`armar-agentes.ts` crea un `EmbebedorVertex` por configuración): no es por proceso ni por proyecto.
- INDEXACIÓN (`embeberParaIndexar`, método opcional del puerto `Embebedor`; lo usan `indexar` del índice en memoria y del de pgvector al cargar el corpus y el paquete): tope de 30 s por intento, SIN reintento por tiempo, hasta 2 reintentos del 429/503 dentro de 40 s por lote, sin semáforo (es en serie y fuera del tráfico). Motivo: los lotes llegan a 100 textos y 20 000 caracteres (~25 lotes); con el tope corto de la consulta un lote vencería y tumbaría `cargarCorpus` o dejaría `paquete_no_cargado`. SUPUESTO NO VERIFICADO: no se midió la latencia real de un lote de 20 000 caracteres; los 30 s son un margen razonado, no un dato.

Un lote es UNA llamada y se reintenta entero; cada lote tiene su presupuesto. PEOR CASO de la búsqueda de un turno: ≈6 s por búsqueda (más la imprecisión de los temporizadores); antes no tenía cota. Sumado a `generar` (≈18,5 s) queda ≈24,5 s con UNA búsqueda (≈6 + 18,5), por encima de los 20 s del sitio; con perfil `pruebas` y ambas colecciones con vectores hay DOS búsquedas en serie: ≈12 s + 18,5 s ≈ 30,5 s. NO está garantizado y supera los 20 s del sitio. Son peores casos (todo agota su tope), no lo habitual, y NO se garantiza evitarlos. Solo el índice EN MEMORIA con la colección base vacía (`fuentes: []`, como en Kuaa) no llama al embebedor: en staging hoy solo ocurre la búsqueda del paquete. pgvector embebe SIEMPRE la consulta: con perfil `pruebas` son dos búsquedas aunque la base esté vacía, y el peor caso es ≈30,5 s.

Vía de indexación y envoltorios: `embeberParaIndexar` es opcional en el puerto; la usan `indexar` (memoria y pgvector), `prepararIndiceSemantico` y `scripts/medir-umbral-banco.mts` (también para embeber la evaluación). `EmbebedorConMemoria` (banco) la delega en el interno SIN memoria: H4d envuelve el embebedor con memoria y se lo pasa al índice, y sin esa delegación `indexar` heredaría los topes cortos de la consulta.

Interacción con el arranque (H4d, rama aparte, no integrada en este cambio): `prepararSemanticaConReintento` reintenta tras 2 s ante cuota y el embebedor ya agotó su presupuesto de consulta, así que los reintentos se acumulan; y `conTiempoLimite` del arranque NO cancela: al vencer su tope de 10 s el `embeber` sigue en segundo plano ocupando cupos del semáforo y llamadas a Vertex. Debe coordinarse al integrar H4d (señal de cancelación, o decidir qué vía usa).

SUPUESTOS NO VERIFICADOS: que la cuota de embeddings sea por proyecto (ni este semáforo ni el del modelo la protegerían del todo), que un 429 no se facture, y que 4 simultáneas, 2 s de cola y 6 s de presupuesto sean los valores correctos; deben medirse en staging. NO garantiza que la cuota se libere en esos segundos, ni que la respuesta armada solo con la base (paquete con cuota) sea pertinente: puede serlo poco. Seguridad: `ErrorProveedor.message` incluye el mensaje del SDK, que podría citar texto de la petición en un 400 (SOSPECHA NO VERIFICADA), por eso se registra solo la `causa`; `CUOTA_EN_TEXTO` (RESOURCE_EXHAUSTED) decide solo con errores sin `status` ni `code` numéricos. El MEDIUM del semáforo no por cliente (compromiso 2026-12-05, arriba) cubre también el del embebedor: un cliente con clave puede agotar los cupos de consulta de los demás del mismo agente.

**Qué responde Kuaa cuando el índice falla (2026-11-06).** Siempre queda el evento `error_modelo` con `codigo: 'indice'` y la `causa`, y el aviso `indice_error`. Con causa `cuota` o `saturacion` en la búsqueda de la colección base, el agente responde `FRASE_ALTA_DEMANDA` (la misma del modelo), SIN llamar al modelo (sin fragmentos no hay respaldo, y el RAG es obligatorio: jamás se contesta con conocimiento propio del modelo), sin propuesta de atención humana, sin botones, con el aviso `alta_demanda_indice` y sin guardar el turno en la memoria, igual que el fallo del modelo por 429 (tampoco emite `mensaje_atendido` ni `sin_respaldo`). Con causa `tiempo` o `servidor` (desde 2026-11-07) responde `config.mensajes.errorTemporal` («Tuve un problema técnico momentáneo…»), sin modelo, sin propuesta de atención humana, sin guardar el turno y con el aviso `error_temporal_indice`: es una falla de infraestructura, no falta de información. Con `autenticacion`, `modelo` u `otro` nada cambia: fragmentos vacíos, el modelo se llama y el turno termina en `sin_respaldo` con la derivación (son errores de configuración o de petición; reintentar no los arregla; cambiar esta política se decide con Andres). Un fallo en la colección del paquete (perfil `pruebas`) con causa `cuota`, `saturacion`, `tiempo` o `servidor` aplica el criterio correspondiente SI la base no aportó fragmentos (caso de staging: base vacía y todo el respaldo en el paquete); si la base sí aportó, se responde con esos fragmentos (RAG cumplido, nada inventado; la respuesta puede ignorar el paquete y el evento y el aviso `indice_error` lo dejan visible).

**Evidencia del ajuste del 2026-11-07.** Bitácora de staging, rev 00071, 16:09-16:33 UTC, 541 mensajes de Kuaa medidos por SLT: 2 eventos `error_modelo` con `codigo: 'indice'` y causa `tiempo` (TMV12 y TCV061), que terminaron en `sin_respaldo` y, al repetirse, salían bien 5 de 5 veces (≈0,37 % de los mensajes). Hubo 0 «mucha demanda» y 0 429: el #94 resolvió el 429, pero su tope de 2,5 s cortaba llamadas lentas que antes terminaban. SUPUESTO: la latencia de cola de una consulta de embeddings supera 2,5 s en ≈0,4 % de los casos (medido solo por esa corrida); el tope de 4 s es un supuesto a medir.

| Causa del fallo del índice | Respuesta de Kuaa | Aviso |
|---|---|---|
| `cuota`, `saturacion` | `FRASE_ALTA_DEMANDA`, sin modelo, turno no guardado | `alta_demanda_indice` |
| `tiempo`, `servidor` | `errorTemporal`, sin modelo, sin atención humana, turno no guardado | `error_temporal_indice` |
| `autenticacion`, `modelo`, `otro` | fragmentos vacíos, modelo llamado, `sin_respaldo` con derivación | `indice_error`, `sin_respaldo` |
| paquete falla y la base aportó fragmentos | responde con la base | `indice_error` |

**Qué dispara cada texto de respaldo de Kuaa.** (a) «Problema técnico» (`mensajes.errorTemporal`): falla del modelo con causa distinta de cuota o saturación, fallo del índice por `tiempo` o `servidor`, salida que no se puede leer, corte por `max_tokens`, o un verificador (enlace, hecho no respaldado, fuga del prompt, etc.) que descarta la respuesta. (b) «Mucha demanda» (`FRASE_ALTA_DEMANDA`): causa `cuota` o `saturacion`. (c) «Sin respaldo» (`mensajes.sinRespaldo` + derivación): RAG exigido y sin fragmentos; también sale con el aviso `respuesta_contra_base_reemplazada` cuando no queda respuesta útil tras retirar una afirmación contraria a la base (ver «Afirmaciones contrarias a la base»). Solo en (c), si la petición trae `plataforma.contacto.whatsapp_e164`, la derivación nombra ese WhatsApp con una frase fija por `voz.tratamiento` (con vos, la de `salidaSinCifras`: «Podés escribir al WhatsApp +595 … y una persona del equipo te ayuda»; `salidaSinCifras` sigue fija en vos); sin plataforma o sin ese campo queda la derivación genérica de siempre, sin contacto inventado. Antes de usarlo, `textoSinRespaldo` verifica con `patronEnlaceOPrecio` (con el número permitido) que el texto no sería objetado; si lo fuera, vuelve al texto de siempre. La propuesta `atencion_humana_solicitada` se conserva como antes. NO garantiza que el número sea el vigente (lo informa SLT).

### Reintento de Kuaa ante una salida que no es JSON legible

`AgenteKuaa` vuelve a llamar al modelo UNA vez cuando la salida no se puede leer como JSON (causas `json_roto` y `sin_objeto`; origen: un TCV036 de la corrida de SLT del 4-nov devolvió JSON roto de forma aleatoria con una pregunta que otras veces se respondía bien). El aviso `reintento_formato` queda en la bitácora (enumerado, sin texto) y los tokens de ambas llamadas se suman. NO se reintenta un error de esquema (el contenido es el problema, no el formato), un corte por `max_tokens`, un error del proveedor (el de Vertex ya tiene su reintento) ni una terminación que no sea normal (un bloqueo de seguridad del proveedor), ni si desde que llegó la petición pasaron más de 3 s (búsqueda RAG incluida): así se reduce la probabilidad de pasar el tope de 20 s del sitio, pero NO se garantiza, porque el segundo intento puede agotar los 9 s × 2 de Vertex (peor caso ≈ 21 s y hasta 4 llamadas facturables a Vertex por petición). El evento `error_modelo` y `mensaje_atendido` registran `iteraciones` y los tokens de ambas llamadas. NO garantiza respuesta: si el segundo intento también falla, se responde el mensaje de respaldo de siempre.

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

`seguridad.criterioSaludPep` (`primera_persona` por omisión, `declaracion`, `sin_sujeto`) decide cuándo bloquea
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

**Límite preexistente en `primera_persona` y `declaracion`.** La regla de `esPreguntaGeneral` deja
pasar una declaración de salud o de PEP escrita como pregunta, sin primera persona verbal clara:
«me detectaron un tumor ¿me cubren?», «Fui PEP hasta el año pasado, ¿me afecta?», «Era ministro,
¿puedo contratar?». Las pruebas fijan ese comportamiento para que un cambio sea deliberado. El
criterio `sin_sujeto` (siguiente sección) lo cierra en gran parte.

### Criterio `sin_sujeto` para salud y PEP

`seguridad.criterioSaludPep` (`primera_persona` por omisión | `declaracion` | `sin_sujeto`; este último admite también el marco de formulario de `declaracion`) decide cómo trata la compuerta de entrada el vocabulario de salud y de PEP. Origen: hallazgo HIGH sobre la regla #7. `esPreguntaGeneral` deja pasar todo texto con «?», de modo que una declaración escrita como pregunta («me detectaron un tumor, ¿me cubren?», «fui PEP hasta el año pasado, ¿me afecta?») llegaba al modelo y a la memoria.

Con `sin_sujeto`, el vocabulario de salud o de PEP bloquea siempre, salvo que el mensaje sea una pregunta de producto sin sujeto personal (`compuertas/sujeto-personal.ts`). Esa excepción exige, a la vez: pregunta (lleva «?» o empieza con «¿»); 200 caracteres o menos y una sola oración; apertura con una palabra de una lista cerrada (interrogativo, artículo o verbo del producto en tercera persona); ningún marcador personal (pronombres, verbos en primera persona, parientes, terceros); ninguna ancla de tiempo; y que además la apruebe la regla de siempre. Excepción estrecha: «¿Me cubre el cáncer…?» pasa (equivale a «¿cubre cáncer?»). Dentro de `sin_sujeto` también se quitan los caracteres invisibles, se detecta «P E P» con separadores y se neutralizan las frases de pago con «operación».

Monotonía: `sin_sujeto` bloquea todo lo que bloquea `primera_persona` y nunca bloquea menos; la prueba `entrada-sin-sujeto.prueba.ts` lo verifica con la ruta vieja como oráculo. Las demás categorías y el `modo` de `vocabularioEntrada` no cambian. Si el PR de `declaracion` (`esConsultaDeFormulario`) se integra, `sin_sujeto` debe componer con él (`criterio !== 'primera_persona'`).

Impacto medido sobre 543 entradas (174 de la batería por pantalla y 369 de la batería del demo): cambian 5, todas de PASA a BLOQUEA; ninguna de BLOQUEA a PASA.

| Caso | Mensaje | Lectura |
|---|---|---|
| SEN-030 | «¿Mi enfermedad está cubierta por el seguro?» | Correcto (era una fuga) |
| PAG-revision-manual-004 | «¿Fue por mi enfermedad o por ser PEP?» | Correcto |
| DER-015 | «Si me diagnostican cáncer el mes que viene, ¿me pagan?» | Falso positivo por especificación (hipótesis personal) |
| MED-002 | «¿Qué medicamento me conviene tomar para la presión alta?» | Aceptable: es consejo médico y lleva dato implícito |
| GUA-005 | «Pe seguro ojapo piko cobertura cáncer rehe?» | Falso positivo en guaraní |

Qué NO garantiza: reduce, no elimina. Bloquea las declaraciones de salud o PEP que usan el vocabulario conocido, aunque vengan como pregunta; no detecta datos personales escritos sin ese vocabulario ni sin marcas de persona (sinónimos como «biopsia» o «diálisis», diagnósticos impersonales, guaraní o portugués sin vocabulario en español, homóglifos de otros alfabetos, datos repartidos en varios turnos). Falso positivo conocido: «¿Funcionario público de alto rango cuenta como PEP?».

Revisión posterior (revisor de código y seguridad): la excepción también rechaza la cláusula subordinada sobre la condición (`que` no interrogativo, `aunque`, `porque`, `mientras`, `cuando` fuera de la apertura y `si` seguido de un verbo en primera persona), los enclíticos («cubrirme», «tratarme»), `acabo` y las anclas de tiempo («hoy», «semana pasada», días de la semana). Los invisibles y combinantes (\p{Mn}, \p{Me}, \p{Cf} y rellenos Hangul o braille) se quitan antes del vocabulario, y la sigla PEP admite hasta tres separadores no alfanuméricos. Solo se neutralizan «Recibimos tu operación» (sin complemento médico), «operación de pago», «operación bancaria» y «número, código o comprobante de operación».

Límites que quedan abiertos y se documentan, no se corrigen aquí: terceros con nombre propio sin cláusula relativa («¿La señora Gómez con diabetes puede contratar?»), sinónimos fuera del vocabulario («diálisis», «biopsia»), «¿Cubre el cáncer de mamá?» (se admite «de mamá» para no bloquear «cáncer de mama»), homóglifos y letras separadas. Compromiso: PR de ampliación del vocabulario de salud en 30 días. Además, un perfil puede volver a `primera_persona` con su propia sección `seguridad` (como con las demás claves de seguridad), así que el cierre del hallazgo depende de la configuración vigente y no del código solo.

### Carga a Kuaa: registros habilitados y oportunidad de venta

`conocimiento/registros-habilitados.ts` (`separarRegistrosHabilitados`) deja pasar a Kuaa solo
los registros con `habilitado_produccion === true` (booleano exacto); `estado_validacion` y
`aprobacion` no habilitan. Falla cerrado («true», 1, «si», null o ausencia no habilitan) y
devuelve de los rechazados solo índice y motivo. No valida la veracidad del contenido ni la
revisión humana. `scripts/validar-paquete-kuaa.mts` imprime únicamente conteos
(`--exigir-habilitados` sale con 1 si no hay ninguno); `--perfil=pruebas` acepta además los `false` con `validacion: "no_validado"` y `version_paquete` X.Y.Z, que salen con `estado: 'no_validado'` y se cuentan aparte, nunca como habilitados (el perfil `produccion`, por omisión, no los admite ni en el tipo); un registro `true` que además trae `validacion: "no_validado"` es contradictorio y se rechaza en ambos perfiles (`registro_contradictorio`); acepta raíz arreglo, `{registros: [...]}` u
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

### Paquete de conocimiento no validado de Kuaa (solo staging)

Para probar el paquete de contenido antes de que alguien lo valide, el servicio puede cargarlo marcado
`no_validado`; **nunca en producción**. Reglas:

- **Perfil por entorno.** `CHATBOTRAG_PERFIL_CONOCIMIENTO` ausente o vacío = `produccion`; `pruebas` lo activa;
  cualquier otro valor no vacío («PRUEBAS», «staging») es un `ErrorEntorno` (un typo no pasa por válido). `pruebas`
  exige `CHATBOTRAG_BUCKET_PAQUETE` y `CHATBOTRAG_VERSION_PAQUETE` (X.Y.Z); `produccion` los rechaza; y el perfil `pruebas` o el bucket
  solo se admiten con `APP_ENV` (sin espacios ni mayúsculas) en {staging, development, test}: ausente, `prod*`,
  `production` en cualquier grafía o un valor desconocido dan `ErrorEntorno` (NODE_ENV no distingue lo local).
- **Solo agentes `kuaa`.** `conocimiento.paquete.habilitado` (booleano, solo en la base, nunca en un perfil)
  lo exige el esquema; `armar-agentes` carga el paquete solo si el agente es `kuaa`, el perfil es `pruebas` y el
  índice no es pgvector (con pgvector queda el evento `paquete_no_cargado` con código `PGVECTOR_NO_ADMITE`, sin
  tocar el índice; `IndicePgvector.indexar` además rechaza todo fragmento con `validacion`).
- **Origen.** `paquetes/conocimiento-gcs` lee `gs://<bucket>/<version>/manifiesto.json` y los archivos que lista,
  con la identidad del servicio. El manifiesto exige `bytes` y `sha256` por archivo, rutas sin duplicar, 5 MB por
  archivo, 50 MB y 200 archivos en total; el tamaño se contrasta con los metadatos antes de descargar y con lo
  descargado, y el SHA-256 con el contenido. Errores tipados: `NO_AUTORIZADO`, `NO_ENCONTRADO`, `INTEGRIDAD`,
  `MANIFIESTO`, `VERSION`, `ERROR`.
- **Solo `no_validado`, colección propia.** `cargarPaqueteKuaa` acepta únicamente registros
  `habilitado_produccion:false` + `validacion:"no_validado"` + `version_paquete` igual al del manifiesto; todo
  lo demás es rechazo. Indexa una sola vez, tras validar todos los archivos, en `<coleccion>--paquete`; si algo
  falla se vacía solo esa colección y el corpus público queda intacto. `AgenteKuaa` consulta la base y la del
  paquete y mezcla por puntaje; con perfil `produccion` descarta cualquier fragmento marcado.
- **Visible.** Con `pruebas` y paquete cargado, el prompt rotula cada fragmento «[NO VALIDADO, paquete X.Y.Z]»,
  antepone una frase enumerada de aviso y la respuesta de `/v1/kuaa/mensaje` lleva `validacion` y
  `version_paquete` (campos opcionales del sobre, fuera de `SalidaOportunidad`).
- **Preparación.** `scripts/preparar-paquete-kuaa.mts` convierte el paquete de origen (lista literal; sin PDF,
  prompts, formularios, imágenes, CSV ni `PRUEBAS_*`; `MANUAL_CAPACITACION_IA.docx` tampoco, porque contiene
  instrucciones a una IA) y escribe solo en una carpeta de salida ajena al repo. `CONVERSACIONES.json` exige
  **revisión humana por datos personales antes de subir**. No anonimiza nada.
- `prompt/armar.ts` normaliza (NFKC, sin ancho cero) y neutraliza en los fragmentos los dibujos de
  caja, `═`/`━`/`=` repetidos (incluso separados por espacios), «FIN DE RESPALDO|DATOS», «INICIO DE RESPALDO|DATOS» y
  un falso encabezado `[n] Documento:` al inicio de línea, para que un texto del paquete no cierre el bloque de respaldo.

### Agente Kuaa y ruta provisional `POST /v1/kuaa/mensaje`

`tipoAgente: kuaa` (por omisión `general`) marca un agente de oportunidad de venta
(`configuraciones/kuaa.json`: voseo, 0 fuentes de conocimiento, criterio de salud y PEP `declaracion`,
sin `recomienda_plan`). `oportunidad/agente-kuaa.ts` es un recorrido aparte de `Agente.responder`:

**Contrato v0.4: bloque opcional `plataforma`.** El cuerpo de `POST /v1/kuaa/mensaje` admite `plataforma`
(`oportunidad/esquemas.ts`, estricto): `version`, `catalogo` (hasta 4 productos con nombre y estado
`disponible`/`proximamente`), `planes` (hasta 3, sin repetir `plan`; premio anual, capital por fallecimiento,
indemnización por cáncer, renta hospitalaria por día y máximo de días, gastos médicos por accidente, en Gs enteros) y
`contacto` (`whatsapp_e164`, `canal`, `correo_derechos`, `direccion`, `sitio_web`). Los nombres solo admiten letras, números, espacio y `+ . -`.
Sin el bloque, nada cambia: el prompt es el de siempre y el detector bloquea toda cifra, enlace o teléfono. Con él, el
prompt agrega «DATOS DE LA PLATAFORMA» armado con plantillas fijas (importes con punto de miles, teléfono agrupado) y
unas reglas que mandan a decir solo esos datos; `detector-enlace-precio.ts` (reexportado por `salida-kuaa.ts`) retira del texto las apariciones EXACTAS de esos
importes, teléfonos y correos (con límites de dígitos y de dominio) antes de aplicar los patrones, así que cualquier
otra cifra sigue bloqueada. El bloque no se guarda en la memoria ni en la bitácora (solo el aviso `plataforma:<version>`).
No garantiza que los datos sean correctos (los fija SLT) ni que el modelo los use en el contexto adecuado.

`contacto` admite además dos campos opcionales que SLT envía ya saneados. `direccion` es la dirección de Interseguros
(5 a 120 caracteres; solo letras, números, espacio y `. + -`, sin comas ni «º»; el esquema rechaza la que dispare el
detector de enlaces, teléfonos o cifras, lo que incluye cualquier grupo de 5 o más dígitos seguidos) y Kuaa puede darla tal cual, como frase
completa; la misma frase con otro número se bloquea. `sitio_web` es el sitio de Interseguros como dominio suelto en
minúsculas (sin esquema, ruta, puerto ni punycode, y con el último rótulo alfabético: «390.000» no es un sitio) y es la única excepción a la prohibición de enlaces: solo cuenta escrito suelto,
precedido de inicio, espacio, signo de apertura o «:» y seguido de fin, espacio, signo de cierre o puntuación de frase,
con adornos de Markdown (`*`, `_`, comilla invertida) a los lados (lista blanca; los correos permitidos usan el mismo
límite). Los permitidos se comparan contra el texto tal como lo leerá la persona, antes de plegar homóglifos, tildes y
marcas combinantes: «іnterseguros360.com» con «і» cirílica no es el dominio permitido (los invisibles U+200B y U+00AD sí
se ignoran, como lo hace UTS46). No cuenta con letras pegadas de otro alfabeto o con tilde, con
`https://`, ruta, consulta, puerto, otro rótulo ni como destino de un enlace Markdown. Sin estos campos el detector se comporta como
antes, salvo que los límites de lista blanca de los correos permitidos son más estrictos que la versión anterior.

`sitio_web` y `direccion` son datos de confianza: `/v1/kuaa/mensaje` se llama de servidor a servidor con la clave en el
backend de SLT, y el cliente Kuaa no debe tener `origenes` CORS (un navegador no debe poder enviar estos campos).
No se admite ningún otro dato de contacto (otra dirección, redes, otros dominios).

Límites conocidos (frente aparte; decide Andres): «interseguros360 punto com» no se bloquea; el patrón de dominio solo
cubre unos pocos TLD (`.tk`, `.xyz` pasan); y `patronEnlaceOPrecio` tiene costo cuadrático con entradas largas y
repetitivas (con 50 000 caracteres tarda segundos; con el tope de 4000 del texto del modelo queda bajo 500 ms, que es lo que
verifica la prueba de tiempo).

1. **Entrada.** Normaliza localmente (NFKC, sin caracteres de formato, marcas combinantes ni rellenos,
   homóglifos cirílicos y griegos plegados) ANTES de las compuertas y de enviar al modelo; el modelo recibe
   el texto normalizado. Un mensaje más largo que `maxCaracteresEntrada` responde 413 `TEXTO_LARGO` (con
   bitácora) y uno vacío 400.
2. **Prompt** (`prompt-kuaa.ts`): jerarquía, reglas y contexto elegidos por enumerado, nunca interpolados;
   `oportunidad_id`, `tarifa_version`, `pagina` y el código de objeción no entran.
3. **Salida.** El modelo responde un objeto JSON dentro del texto (el puerto no permite pedir JSON con
   esquema; temperatura baja desde la configuración). Se valida contra `SalidaOportunidad`, se sanea el
   texto y se aplican detectores deterministas propios (`salida-kuaa.ts`): enlaces, precios y contactos
   (con NFKC, sin invisibles ni homóglifos, formas ofuscadas), afirmaciones de hecho que solo el sistema
   conoce (pago acreditado o póliza emitida salvo que `estados` lo informe, «quedó agendado», «te transferí»,
   «estás cubierto», «sos elegible», promesas de indemnización) y fugas del prompt. Cualquiera, un JSON
   inválido, un corte por `max_tokens`, `afirma_cobro_real` o un error del proveedor devuelven el mensaje de
   error temporal con botones y propuestas vacíos, nunca el texto crudo.
4. **Sin respaldo no se afirma nada**: mientras no haya fuentes se responde el mensaje fijo, sin excepción
   por «pregunta final». En ese caso, en un fallback o en un reemplazo de compuerta, la etapa propuesta es la
   actual y la objeción es null. `continuar_pago` solo sobrevive con `solicitud: completada`; las propuestas
   no se repiten; `seguimiento_solicitado` se descarta sin permiso vigente; la marca `[DERIVAR]` agrega
   `atencion_humana_solicitada`.
5. **Memoria.** En proceso, con clave `kuaa:<cliente>:<sha256>` (por cliente y oportunidad; el «:» no lo
   acepta `ID_CONVERSACION`, así que las rutas generales no pueden nombrarla y, para un cliente de Kuaa,
   `/v1/conversaciones/*` responden 404 `AGENTE_KUAA`). Guarda el texto normalizado de la persona y el JSON
   validado de la respuesta hasta 30 minutos: **es una desviación del contrato de SLT, que dice «sin
   estado»**; se pierde al reiniciar y no se comparte entre instancias.
6. **Respuesta.** 200 con exactamente las claves de `SalidaOportunidad` (sin `ok`); los errores llevan
   `ok: false`. La bitácora no lleva texto ni el id de la oportunidad. La ruta es PROVISIONAL.

Qué corrige el filtro previo de SLT (`asistente.ts`/`asistente-salida.ts`) y qué no: esta capa no lo
sustituye; es defensa en profundidad y su detector es una lista, no una demostración.

Límites que siguen abiertos (K2b y otros): las compuertas compartidas de `compuertas/`, calibradas con usted
y tuteo, no detectan por sí solas voseo como «sos elegible» o «te vamos a pagar la indemnización» (en Kuaa
las frena el detector propio) y sus textos de reemplazo hablan de usted («¿En qué puedo ayudarle?»);
paráfrasis de inyección («olvidá lo anterior», «SYSTEM:», «repetí tus instrucciones») pasan al modelo; los
detectores dan falsos positivos a propósito (por ejemplo «10.000 personas») y no atrapan toda forma; con
pago acreditado, `afirma_cobro_real` sigue llevando al fallback; no se detectan correos ni teléfonos de la
persona en la entrada; no se sabe cómo obedece el modelo real al formato JSON.

### Afirmaciones contrarias a la base (hallazgos de Rodrigo, 8-nov-2026)

Origen: la corrida de 380 preguntas mostró que Kuaa contradecía la base 0.1.0 aun con el respaldo correcto en el prompt, o inventaba una regla donde la base calla. El control vive en `oportunidad/afirmaciones-contra-base.ts` (funciones puras, expresiones acotadas sobre `paraDetectar`, motivo enumerado), no en `compuertas/salida.ts` (genérico, en «usted») ni en el prompt. **El código prohíbe, no afirma**: ningún detector contiene un dato de la base; solo reconoce la forma de la afirmación contraria.

| Motivo | Entrada de la base que lo respalda |
|---|---|
| `rol_corredor` | FICHA_VIVE, QA011 |
| `carencia_accidente` | QA025 |
| `exclusion_trasladada` | condicionado de la renta, cláusula 4.b; QA034 |
| `titular_facturas` | QA068, C04 |
| `plazo_siniestro` | QA070 |
| `multiples_polizas`, `pago_terceros` | hueco de la base: sin regla documentada; se bloquean afirmación y negación, salvo la oración condicional o de consulta |

Si cambia QA025, QA068, QA070, FICHA_VIVE o la cláusula 4.b, el detector se revisa con ella.

**Corrección en dos etapas.**
1. *Reintento (una sola vez).* Dentro del bucle de generación de `agente-kuaa.ts`, junto al reintento de formato, si la salida es válida y una oración contradice la base, se vuelve a llamar al modelo agregando al mensaje de la persona una corrección fija por motivo (`CORRECCION_POR_MOTIVO`: frases enumeradas, jamás el texto del modelo, un dato de la base ni texto libre). Reutiliza la guarda `TIEMPO_MAXIMO_PARA_REINTENTAR_MS` (3 s desde la llegada, búsqueda incluida), suma los tokens de ambas llamadas y deja el aviso `reintento_contra_base:<motivo>`. Entre el reintento de formato y este nunca hay más de 2 llamadas extra por turno (3 en total). No se reintenta si el turno terminaría en «sin respaldo». La memoria guarda el mensaje original de la persona y el texto final, nunca la corrección ni la afirmación falsa. La corrección termina pidiendo no mencionarla ni disculparse (la persona no vio la respuesta anterior). Se guarda la primera salida válida: si el reintento falla (error del proveedor, JSON roto, corte por `max_tokens`), se sigue con ella y la etapa 2 retira la oración, con el aviso `reintento_contra_base_fallido`; no se responde «problema técnico» ni «mucha demanda», que serían falsos.
2. *Red de seguridad.* Si tras el reintento (o sin él, por tiempo) la afirmación persiste, se retira la oración (más la siguiente si es una anáfora: «Este plazo…») y se agrega la derivación (`fraseDerivacionKuaa`); si no queda respuesta útil, se responde `textoSinRespaldo` sin botones y solo con la propuesta `atencion_humana_solicitada`. Nunca «problema técnico», que sería falso. Avisos: `contra_base:<motivo>`, `frase_contra_base_retirada`, `respuesta_contra_base_reemplazada` (solo códigos; la bitácora sigue sin texto).

**Latencia.** El reintento agrega una llamada al modelo (≈1 s en el p50 de staging) solo cuando hay detección. Como la guarda exige que hayan pasado ≤ 3 s desde la llegada, el nuevo peor caso por esa vía es 3 + 18,5 ≈ 21,5 s (el mismo del reintento de JSON roto), que no supera el peor caso ya existente sin reintentos: ≈24,5 s con una búsqueda y ≈30,5 s con perfil `pruebas` y dos búsquedas (ver «Presupuesto de latencia» y «Embebedor»). El sitio corta a 20 s: todos esos peores casos pasan de ese tope y **evitarlo NO está garantizado**. Hasta 3 llamadas facturables al modelo por turno (cada una con sus propios reintentos de Vertex).

**Qué NO garantiza.** Atrapar toda paráfrasis («la renta corre desde el primer momento», «la que responde es Interseguros»), afirmaciones repartidas en dos oraciones, plazos sin número ("en un par de semanas"), voz pasiva con otros verbos, la pregunta retórica afirmativa dentro de «¿…?» («¿Sabías que Interseguros es la aseguradora?»: de cada oración se quitan los tramos «¿…?» y se evalúa el resto, para no bloquear «¿Interseguros es la aseguradora? No, es el corredor.»; una pregunta sin «¿» de apertura sí se evalúa), la distancia entre «factura» y «a tu nombre» (se exige menos de 60 letras y no se cuenta «póliza/contrato a tu nombre» tras un verbo de recepción o estado, como «recibís una póliza a tu nombre»; una factura nombrada fuera de esa ventana o con otro verbo, por ejemplo «la factura que recibís del seguro a tu nombre», se escapa), la negación de la carencia repartida entre oraciones, y cualquier paráfrasis fuera de las listas de verbos y sustantivos de cada motivo; que lo que queda sea completo (al retirar la oración se pierde también lo correcto que traía); que el modelo deje de intentarlo (el prompt no cambió). Da falsos positivos a propósito (lado seguro). Textos de derivación por motivo aprobados por Rodrigo y la derivación útil del hallazgo 8 (declarar medicamentos) quedan para el banco del bucket cuando exista H4d; los hallazgos 3 y 8 no tienen detector.

### Banco de respuestas (modelo híbrido, H1)

El modelo híbrido contesta las preguntas frecuentes y los casos que exigen derivación con textos aprobados por una
persona, no generados por el modelo. Esta primera entrega (H1) solo define y carga el banco; el enrutador que lo
consulta llega en una entrega posterior. Todo vive en el núcleo (`paquetes/nucleo/src/banco/`), de modo que
sirve a cualquier agente de ChatbotRAG y no solo a Kuaa.

- **Forma.** Un JSON con `formato` (1), `version`, `respuestas` (pregunta, plantilla, tema, riesgo y condiciones
  de derivación), `derivaciones` (motivo, preguntas o términos, texto), `textos_derivacion` (un texto por motivo)
  y `aclaraciones`. El esquema (`banco/esquema.ts`) es estricto: una clave de más, un riesgo fuera de lista, un id
  repetido o una pregunta repetida se rechazan.
- **Responsable obligatorio.** Cada texto lleva `aprobado_por` (nombre o rol, texto corto, sin fecha), sin valor
  por defecto. Ese campo nunca va a la bitácora.
- **Dónde vive.** En un bucket, nunca en el repositorio. El único banco versionado es
  `banco/banco-ejemplo.json`, sintético y fuera de `configuraciones/` para que la imagen no lo copie.
- **Variables.** Las plantillas usan `{{variable}}` de una lista cerrada (`VARIABLES_PLANTILLA`): datos del plan
  elegido y de contacto. `resolverVariablesPlataforma` las rellena con las mismas funciones de formato que arman
  el prompt, así que el detector de la salida reconoce las cifras como permitidas. Una variable fuera de la lista,
  o llaves mal formadas, impiden cargar el banco.
- **Integridad.** `cargarBanco` calcula el SHA-256 del texto y, si se le entrega uno esperado, rechaza cualquier
  diferencia sin mostrar ningún hash. También rechaza valores con forma de secreto. No hace red ni lee archivos:
  recibe el texto.
- **Nunca sale una plantilla sin rellenar.** `rellenarPlantilla` hace una sola pasada; si un dato falta, informa
  los faltantes para que quien llama derive, y si aun así quedan llaves, lanza un error. Un valor que contenga
  `{{...}}` no se reinterpreta.

Resuelto en H2: el texto armado pasa siempre por las compuertas de salida (`banco/texto-fijo.ts`:
`armarTextoFijo` y `verificarBanco`), y `cargarBanco` rechaza el banco sintético fuera de pruebas (opción
`admitirSintetico`) y las llaves en los textos de derivación y las aclaraciones.

Qué NO garantiza: que la respuesta sea correcta, completa o conveniente. Eso lo da quien figura en `aprobado_por`;
el código solo asegura la forma, la integridad del archivo y que ningún marcador llegue al cliente.

### Enrutador (modelo híbrido, H2)

`banco/enrutador.ts` decide, sin modelo y sin red, por cuál de tres carriles sigue un mensaje: `fijo` (respuesta
aprobada), `derivacion` (texto aprobado que pasa la conversación a una persona) o `ia` (el agente de siempre).
El orden es fijo: (a) enrutador apagado, (b) mensaje sin contenido, (c) término de bloqueo (emergencia u otro motivo), (d) pregunta
conocida del banco, (e) sin coincidencia. La derivación va primero: un término de emergencia gana sobre cualquier
respuesta fija, y una pregunta de derivación deriva aunque el carril fijo esté apagado.

- **Dos normalizaciones, a propósito.** `normalizarPregunta` (de H1) compara preguntas completas y fija la unicidad
  del banco; no se cambió para no romperla. `normalizarParaTerminos` busca términos por palabra completa: además
  quita caracteres de formato invisibles (guion blando, ancho cero, controles BIDI) y marcas combinantes, y
  convierte todo lo que no sea letra o número en un espacio. Así «hola,termino.emergencia» coincide y
  «terminos» no coincide con «termino».
- **Sin expresiones regulares construidas con datos.** Los grupos de palabras consecutivas del texto
  normalizado se comparan contra un mapa de términos (el costo no crece con la cantidad de términos); una prueba estructural prohíbe `RegExp(`, `fetch` y `process.env` en el
  archivo, y otras miden el tiempo con 4000 términos (incluido el peor caso, con la misma primera palabra) y entradas de
  50 000 caracteres.
- **Coincidencia exacta solamente.** Sin coincidencia parcial ni similitud.
- **Sin texto de la persona.** La decisión y sus avisos (`avisosDecision`) llevan solo ids y valores enumerados.
- **Sección `enrutador` de la configuración.** `{ activo, carrilFijo }`, ambos apagados por defecto, solo en la
  base (un perfil que la defina se rechaza) y sin efecto hasta H4, que conectará el enrutador al agente; `carrilFijo`
  exige `activo`. H2 no se conecta al orquestador ni a `agente-kuaa.ts` ni carga el banco desde el bucket.
- **Texto verificado.** `armarTextoFijo` rellena la plantilla (o toma el texto de derivación), lo pasa por
  `aplicarCompuertasSalida` y lo descarta, sin corregirlo, si una compuerta lo cambia o avisa; un
  `VerificadorAdicional` permite detectores propios de un agente. Los resultados de falla nunca llevan texto,
  valores resueltos ni `aprobado_por`. `verificarBanco` aplica lo mismo a todo el banco y devuelve solo los
  fallos, para validarlo antes de publicarlo.

Qué NO garantiza: homóglifos de otros alfabetos (una «е» cirílica evita un término), sinónimos, errores
ortográficos, preguntas parecidas pero no idénticas, ni negaciones («no es una emergencia» deriva igual, que es la
dirección segura). Solo reconoce coincidencias exactas. Tampoco cubre guiones o puntuación dentro de una palabra
(«sui-cidio», «acci.dente»), formas pronominales («matarme»), leetspeak («acc1dente»), letras separadas por
espacios, palabras pegadas ni homóglifos. La red de seguridad para las emergencias que el enrutador no detecte es
el carril IA (H4). Un invisible se prueba de dos formas (dentro de una palabra o como separador, con los rellenos
Hangul incluidos), pero un mismo mensaje que mezcle ambos usos en un solo término no se reconoce.

Pendientes y decisiones:

- **D1** (decide Andres): con `carrilFijo` apagado, las condiciones de entrada (`contenido_pendiente`,
  `atencion_humana_solicitada`) no derivan; solo derivan las preguntas de derivación y los términos de bloqueo. Excepción desde H4a: una respuesta de riesgo
  `critico` deriva aun con el carril apagado (ver D5).
- **D2** (decide Rodrigo): un dato faltante con la condición `sin_dato` deriva con el motivo `contenido_pendiente`.
- **D3** (decide Andres): la aclaración «¿sobre qué plan?» queda fuera de H2; decidir en H4 si hay un carril
  `aclaracion`.
- **D4**: encender `carrilFijo` es un booleano; falta decidir si exige una medición con confusión 0. H2 no lo hace
  cumplir. Desde H4a, la vía semántica sí lo cumple en código (`verificarCalibracion`, ver H4a).
- **D5** (decidida y AMPLIADA por Andres, implementada en H4a): un texto fijo de riesgo `critico` que no se puede
  entregar se DERIVA y nunca pasa a la IA, sea cual sea la causa: entrada no hallada (manda el riesgo de la decisión),
  plantilla inválida, datos faltantes sin `sin_dato`, compuerta de salida o verificador adicional. `armarTextoFijo`
  pide la derivación `contenido_pendiente`; `armarTextoConD5` completa la cadena: si ese texto también se rechaza o no
  existe, sale el mensaje general de derivación con la propuesta `atencion_humana_solicitada` (los avisos de ambos
  rechazos se conservan; solo códigos). Por semántica, un crítico propuesto sin respaldo de D4 (`!fijoApto`) deriva con
  `contenido_pendiente` (origen `pregunta_semantica`). **Frontera exacta:** el riesgo normal rechazado o sin armar
  sigue a la IA. **Excepción explícita a D1 (decidida por Andres):** con `activo: true` y `carrilFijo: false`, una
  respuesta de riesgo `critico` hallada (por coincidencia exacta o por semántica) DERIVA con `contenido_pendiente`
  (origen `condicion_entrada`) en vez de ir a la IA, y la cadena de D5 sigue (mensaje general con la propuesta
  `atencion_humana_solicitada` si ese texto falla). Esto cambia el contrato de `enrutar` para críticos con el carril
  apagado; D1 sigue valiendo para el riesgo normal (IA con su candidata, `carril_fijo_apagado`). Con el enrutador
  APAGADO del todo (`activo: false`) nada cambia: todo va a la IA. D5 alcanza a un crítico ya ELEGIDO. **Caminos por los
  que un crítico SÍ puede llegar a la IA** (lista exacta): (1) enrutador apagado (`enrutador_apagado`); (2) una pregunta
  cercana a un crítico que no alcanza el umbral o con duda por el margen: `sin_coincidencia`, porque nunca se eligió;
  (3) la vía semántica sin poder proponer: `semantica_no_disponible`, `embebedor_error`, `embebedor_tiempo` o
  `calibracion_no_apta` (sin candidata); y (4) un mensaje sin contenido (`sin_contenido`).
- Los términos de bloqueo y los textos de derivación reales los entrega Rodrigo (Legal); el banco versionado
  sigue siendo sintético. Desde H4a las derivaciones admiten `terminos` con cualquier motivo (antes solo `emergencia`;
  un banco anterior carga igual): un término de otro motivo deriva con ese motivo y el origen `termino_derivacion`,
  y el de emergencia conserva `termino_emergencia`. Ningún vocabulario real vive en el código.

### Calibración (modelo híbrido, H3)

H3 mide cuánto se parece una pregunta nueva a las del banco y cómo fijar, con datos, desde qué parecido conviene
proponer una entrada. Son tres módulos del núcleo (`banco/similitud.ts`, `banco/evaluacion.ts`, `banco/medir.ts`),
un script (`scripts/medir-umbral-banco.mts`) y un ejemplo sintético (`banco/evaluacion-ejemplo.json`).

- **D6: la semántica se SUMA a la exacta.** La coincidencia exacta de H2 sigue yendo primero y `enrutar()` no
  cambió. `prepararIndiceSemantico` embebe las preguntas de respuestas y derivaciones; `emparejarSemantico` propone
  una entrada solo si su mejor puntaje (coseno) alcanza el umbral de SU tipo y se distancia al menos `margen` del
  mejor puntaje de cualquier OTRA entrada. Si una derivación y una respuesta empatan, el orden pone primero a la
  derivación (con margen mayor que cero el empate da nulo: hay duda y va a la IA).
- **Regla B (confirmada por Andres en H4a): derivación casi empatada con la respuesta LÍDER.** Sea «candidata» la
  mejor derivación y «líder» la respuesta de mayor puntaje. Si la candidata alcanza `umbralDerivacion` y está casi
  empatada con la respuesta líder (a lo sumo `margen`, en cualquiera de los dos sentidos), DERIVA, esté o no la líder
  sobre `umbralFijo` (derivar de más es la dirección segura), siempre que se distancie al menos `margen` de la mejor de
  las demás entradas (se excluyen la candidata y las respuestas casi empatadas con ella; otra derivación cercana da
  nulo: hay duda y va a la IA). Si la líder está claramente por encima de la candidata (más allá del margen), no hay
  empate con la líder y decide la regla común: esa respuesta se propone si cumple su umbral y su margen; si no, nulo.
  Eso elimina la franja de H3 donde una derivación más parecida iba a la IA. Con `umbralFijo` 0,80, `umbralDerivacion`
  0,70 y margen 0,05: respuesta y derivación en 0,79/0,78, 0,79/0,79, 0,79/0,80, 0,79/0,84 y 0,81/0,79 derivan (con o
  sin una tercera entrada lejana); y tres ejemplos con dos respuestas quedan fijados en las pruebas: r0 0,70, r1 0,80,
  d 0,70 → respuesta r1; r0 0,70, r1 0,76, d 0,70 → nulo; d 0,79, r0 0,80, r1 0,845 → nulo. Fuera de la zona de empate,
  una respuesta bajo `umbralFijo` no puede proponerse (si es la mejor, nulo) y no compite por el margen de una
  derivación líder; una derivación bajo su umbral da nulo. Las comparaciones de umbral y de margen toleran
  `EPSILON = 1e-9`. El `margen` devuelto es la distancia real a la siguiente mejor entrada que compite; cuando la única
  otra es una respuesta excluida o casi empatada puede ser MENOR que el margen pedido, así que H4 no debe suponer ese
  invariante. Un puntaje no finito nunca propone nada: `coseno` lanza `ErrorSimilitud` si algún componente (o el resultado) no es finito, `decidirEmparejamiento` devuelve nulo ante un puntaje no
  finito, `coseno` escala cada vector por su mayor valor absoluto cuando sus cuadrados se saldrían de rango (componentes
  enormes o diminutos dan el coseno correcto, no NaN ni 0), y `medir`/`barrerUmbrales` fallan de forma ruidosa en vez de calibrar con NaN.
  `VERSION_REGLA_DECISION` (hoy 1) versiona la regla: si cambia, súbase y las calibraciones anteriores dejan de servir.
- **D7: dos umbrales asimétricos más margen.** `umbralFijo` y `umbralDerivacion` (la derivación puede exigir menos:
  derivar de más es la dirección segura) y `margen`.
- **D8: mínimos por partición.** En CADA partición (calibración y control): al menos 5 casos por entrada del
  índice y al menos 30 casos «ninguna». Si la calibración no los cumple, `elegirUmbral` devuelve `null` (sin datos
  suficientes, un umbral de 0,50 «sin errores» sería un espejismo; nunca se usa el piso del barrido como valor por
  defecto). Si el control no los cumple, la calibración queda inválida (`minimos_insuficientes`).
- **D9: el umbral NO va en el código.** Vive en el bucket junto al banco, ligado a modelo, dimensión y SHA-256 del
  banco; si cambia cualquiera de los tres, se vuelve a medir. El script imprime esos tres datos más el SHA-256 de
  la evaluación.
- **Evaluación** (`evaluacion.ts`): `{formato: 1, version, casos: [{id, texto, esperado: {tipo, entradaId?},
  particion}]}`, estricta; cada `entradaId` debe existir en el banco con el tipo declarado y «ninguna» no lleva
  `entradaId`. Vive en el bucket; el archivo versionado es un ejemplo inventado.
- **Medición** (`medir.ts`): `medir` cuenta aciertos, confusiones (la entrada X tomada por Y; D4 exige 0), falsos
  positivos sobre «ninguna», falsos negativos (debía responder o derivar y fue a la IA) y cobertura.
  `barrerUmbrales` recorre de 0,50 a 0,99 en pasos de 0,01 con los vectores ya calculados (sin llamadas nuevas).
  `elegirUmbral` toma el MENOR umbral con cero confusiones y cero falsos positivos «ninguna» en calibración,
  informa el control, devuelve `null` si no hay umbral factible o la calibración no cumple D8 (nunca un valor por
  defecto) y marca inválida la calibración si el control tiene alguna confusión (`confusion_en_control`), algún
  falso positivo «ninguna» (`falso_positivo_en_control`) o no cumple los mínimos (`minimos_insuficientes`).
  `barrerUmbrales` valida `margen` y `diferenciaDerivacion` al entrar.
- **Script.** `--banco` y `--evaluacion` deben estar fuera del repositorio (si no, sale con código 1); imprime solo
  conteos, umbrales, margen, modelo, dimensión y SHA-256, nunca texto. El banco sintético solo se admite con
  `--proveedor=simulado`; `--proveedor=vertex` exige `--sha256` y `--sha256-evaluacion` y llama al servicio de embeddings (con costo). Lee
  cada archivo por su ruta real desde un descriptor abierto (`fstat` del mismo descriptor, sin carrera entre
  comprobar y leer), solo si es regular y pesa hasta 20 MiB; informa `resultado=minimos_calibracion_insuficientes`
  (distinto de `sin_umbral_factible`) y `umbral_en_piso=true` si el umbral fijo elegido es el piso 0,50 o el de
  derivación queda bajo él; abre con `O_NONBLOCK` para que un FIFO no bloquee (se rechaza como no regular); `pnpm tipos`
  también verifica los tipos de `scripts/*.mts` (`scripts/tsconfig.json`); rechaza valores vacíos de `--margen` y
  `--diferencia-derivacion`; la evaluación rechaza textos con forma de secreto; y ante un error ajeno al banco, la
  evaluación o la similitud imprime solo el nombre y el código de sistema, nunca el mensaje.

**Qué NO garantiza.**

- Un banco o una evaluación sintéticos NO fijan un umbral real: el proveedor simulado (hashing de palabras) no
  tiene semántica, así que su resultado solo prueba que la mecánica funciona.
- H3 no conecta nada: ni el orquestador, ni `agente-kuaa.ts`, ni el enrutador. La conexión del emparejamiento
  semántico al agente es de H4.
- Encender `carrilFijo` exige un informe de calibración válido con confusión 0 en el control, medido con el banco
  y el modelo reales. H3 no lo hacía cumplir; desde H4a lo hace `verificarCalibracion` para las respuestas fijas
  semánticas (`fijoApto`).
- Un umbral medido con pocos casos o poco variados se sobreestima, y el control solo sirve si es independiente de
  la calibración (lo decide quien arma el conjunto). El paso de 0,01 es una rejilla, no un óptimo demostrado.

### Enrutamiento con semántica (modelo híbrido, H4a)

H4a es el núcleo puro que une H2 y H3; no se conecta al agente (H4d) ni a un bucket (H4c). Cuatro módulos en
`paquetes/nucleo/src/banco/`:

- **`enrutador-semantico.ts`: `enrutarConSemantica`.** Corre primero `enrutar` (su contrato no cambió). Solo si da
  `sin_coincidencia` y hay un índice semántico apto usa el vector YA calculado de la consulta (el núcleo no llama a
  nada) y `emparejarSemantico`. Devuelve `{ decision, via: 'exacta' | 'semantica', similitud }` (similitud redondeada a
  milésimas, sin texto). Una derivación propuesta lleva el origen `pregunta_semantica`; una respuesta pasa por las
  mismas condiciones `derivar_cuando` que la vía exacta (`decidirRespuesta`, función compartida) y por el carril fijo
  apagado, que va primero. Motivos de caída a la IA, enumerados: `semantica_no_disponible` (sin contexto o sin
  consulta), `embebedor_error` (error, vector de otra dimensión, vacío o con valores no finitos), `embebedor_tiempo`
  y `calibracion_no_apta`. `semantica_no_disponible` cubre también un `IndiceEnrutador` sin `bancoSha256` (el índice
  lo lleva: `prepararEnrutador(banco, sha256)`, y se compara con la calibración) y un índice semántico con algún
  `entradaId` que no existe en el banco con su tipo (no se ignora en silencio). `eventoEnrutador` arma el evento de bitácora `enrutador` (carril, vía, similitud, motivo,
  latencia y los avisos de ids y enumerados; nunca texto ni el término que coincidió).
- **`calibracion.ts`.** Esquema Zod estricto de `calibracion.json` (`formato`, `regla`, `banco_sha256`, `evaluacion_sha256`,
  `proveedor` `vertex|simulado`, `modelo`, `dimension`, umbrales, `valido`, `motivos_invalidez`, `control`
  `{total, confusiones, falsos_positivos}`, `medido`) y `verificarCalibracion`: la semántica es apta si la
  calibración es válida, su `regla` es la versión vigente (`VERSION_REGLA_DECISION`), su SHA del banco, modelo y
  dimensión coinciden con los cargados y el proveedor no es el simulado (salvo `admitirSimulado`, solo pruebas); el carril fijo es apto además con `confusiones` y
  `falsos_positivos` en 0 (D4 en código; defensa en profundidad, porque el esquema ya exige coherencia). El esquema
  rechaza un archivo incoherente: `valido` si y solo si no hay `motivos_invalidez`; confusiones o falsos positivos sin su
  motivo; `valido` con control menor que `MINIMO_NINGUNA` de `medir.ts`; `umbral_fijo` bajo el piso del barrido (0,50). `umbral_derivacion` solo debe ser mayor que 0, porque la medición lo
  baja hasta 0,01 con `--diferencia-derivacion` (D7); la salida real de `elegirUmbral` se prueba contra este esquema. Una
  calibración de H3, sin `regla`, se rechaza. Si el fijo no es apto (hoy solo alcanzable con un objeto que no pasó por el esquema), las respuestas de riesgo
  normal van a la IA con la candidata y las críticas derivan (D5). Una derivación semántica no depende de `fijoApto`
  pero sí de `semanticaApta`, que incluye `valido`: como `valido` implica control sin confusiones ni falsos positivos,
  una confusión en el control apaga también las derivaciones semánticas (a propósito: una calibración inválida no respalda
  ninguna propuesta). La derivación por coincidencia exacta no necesita calibración.
- **`embebedor-memo.ts`.** `EmbebedorConMemoria` memoriza la PROMESA del cálculo (clave SHA-256 del texto, 32
  entradas, 60 s, reloj inyectable) para que el enrutador y el RAG compartan el vector con una sola llamada; un fallo
  no se memoriza y se entregan copias. `embeberConTiempo` (tope y temporizador inyectables) y `consultarEmbedding` (lo
  traduce a `ok | error | tiempo`). Un lote mayor que `maximo` se resuelve desde su propia promesa, con una sola
  llamada; `maximo`, `vidaMs` y el tope `ms` se validan (`RangeError`); un embebedor que lanza de forma síncrona o
  devuelve una lista vacía o mal formada es un error controlado. El tope de tiempo NO aborta la llamada en curso:
  deja de esperarla, y el servicio sigue (y factura) hasta terminar.
- **`similitud.ts` y `esquema.ts`.** Regla B con la respuesta líder (ver H3) y términos con cualquier motivo (ver H2).

Qué NO garantiza H4a: que el modelo de embeddings entienda el dominio (lo acota la calibración); que el SHA-256 de la
evaluación corresponda a un archivo real (solo queda como constancia); que `semantica_no_disponible` sea un fallo (es
también el estado de un agente sin semántica configurada); ni una conexión al agente, al bucket o a Vertex: eso es
H4c y H4d. La memoria es por instancia de Cloud Run, no se comparte entre instancias.

### Producción de `calibracion.json` (modelo híbrido, H4b)

`scripts/medir-umbral-banco.mts` acepta `--salida=<directorio> [--sobrescribir]` y escribe allí `calibracion.json` con el
contrato de `calibracion.ts` (formato 1, `regla` = `VERSION_REGLA_DECISION`, SHA-256 del banco y de la evaluación,
`proveedor`, `modelo`, `dimension`, umbrales, `margen`, `valido`, `motivos_invalidez`, `control` con solo conteos y
`medido` AAAA-MM-DD). Reglas:

- El directorio debe existir y estar fuera del repositorio y de la raíz común de git (mismas comprobaciones de ruta real que
  `--banco` y `--evaluacion`); se verifica antes de medir, para no gastar embeddings en un error de ruta.
- Escritura atómica (temporal exclusivo en el mismo directorio, modo 0600, escritura completa con `fsync`, `link`/`rename`)
  y sin sobrescribir un `calibracion.json` existente salvo `--sobrescribir`. Justo antes de abrir el temporal se revalida el
  directorio (misma ruta real, fuera del repo, del usuario actual y sin escritura de grupo/otros). Si el destino no admite
  enlaces duros, el script lo dice y pide un directorio local.
- Se escribe también un resultado inválido con umbrales MEDIDOS (`valido: false` con sus motivos, por confusión o falso
  positivo en el control; el código de salida sigue siendo 1). Con el proveedor simulado el archivo dice
  `proveedor: "simulado"`, que `verificarCalibracion` no acepta fuera de pruebas.
- Si NO hay nada medido (`sin_umbral_factible`, `minimos_calibracion_insuficientes`, esquema incumplido o error de
  ejecución) NO se escribe archivo y sale con código 1: no se inventan umbrales ni un control no medido. Un
  `calibracion.json` anterior no corresponde a esa medición: con `--sobrescribir` se renombra a
  `calibracion.json.invalidada` (con sufijo `-AAAAMMDDTHHMMSSZ-<hex>` si ya existe; nunca pisa un archivo) y se informa. Para
  restaurarla: `mv calibracion.json.invalidada calibracion.json`. Sin `--sobrescribir` y con un `calibracion.json` presente el script
  sale antes de medir (no gasta embeddings); si uno apareciera durante la ejecución (carrera) no se toca, se avisa por stderr
  que no debe usarse, y el `link` atómico final impide pisarlo. El contenido se valida con `cargarCalibracion` antes de escribirse; jamás lleva
  texto de casos ni del banco. `medido` es la fecha UTC.
- **`modelo` es el `nombre` del embebedor, y ese nombre incluye el modelo**: `vertex-embeddings:<modelo>` (por defecto
  `vertex-embeddings:text-embedding-005`), `bedrock-embeddings:<modelo>` y `simulado`. Por eso un cambio de modelo de
  embeddings (o de dimensión) invalida la calibración: `verificarCalibracion` compara `modelo` y `dimension` con los del
  índice y, si difieren, la semántica no es apta y todo cae a la IA hasta volver a medir. Nota: el nombre anterior de
  Bedrock era `bedrock-titan`; cualquier calibración o índice que lo guardara deja de coincidir (en el repositorio no había ninguno).
- El script mide solo con el modelo por defecto del embebedor (Vertex: `text-embedding-005`); un agente con otro modelo cae a la IA hasta
  que se añada `--modelo-embeddings`. El nombre completo debe caber en 100 caracteres (se verifica antes de gastar embeddings).
- `calibracion.json` solo admite `proveedor` `vertex|simulado`: una calibración con Bedrock no está soportada por el esquema.

### Carga del banco desde el bucket (modelo híbrido, H4c)

El banco aprobado y su calibración se leen de un bucket privado al arrancar, con la identidad del servicio (ADC), solo
lectura. **H4c solo carga y verifica; la conexión al agente es H4d** (ver más abajo); el resultado queda en
`AgenteArmado.enrutadorBanco`.

- **Ruta**: `<CHATBOTRAG_BUCKET_BANCO>/<agenteId>/<X.Y.Z>/banco.json` y `calibracion.json` (esta última opcional).
- **Variables** (no secretas): `CHATBOTRAG_BUCKET_BANCO` (nombre de bucket) y `CHATBOTRAG_BANCOS`, un JSON
  `{"<agenteId>":{"version":"X.Y.Z","sha256":"<hex64>","sha256Calibracion":"<hex64>"}}` validado con Zod estricto en
  `entorno.ts` (versión semver estricta, hex de 64, sin claves extra; las dos variables van juntas). Un `agenteId` que no
  corresponde a ningún agente cargado detiene el arranque. Sin las variables no se construye el lector ni se registra nada:
  el comportamiento es idéntico al anterior.
- **`LectorBancoGcs`** (`paquetes/conocimiento-gcs/src/lector-banco.ts`): consulta el tamaño en los metadatos (tope 2 MiB
  el banco, 64 KiB la calibración) antes de descargar, baja esa generación exacta, verifica el SHA-256 de los bytes contra el
  declarado ANTES de interpretarlos, y recién entonces usa `cargarBanco` (`admitirSintetico` solo con `APP_ENV=test`) y
  `cargarCalibracion`. El SHA del banco alimenta `prepararEnrutador`.
- **Nunca lanza por contenido del bucket.** Banco ausente, sin permiso, ilegible, grande, con otra huella, inválido o
  sintético: `indice: null` y un motivo enumerado (`banco_*`); el servicio arranca y atiende como hoy. Calibración ausente,
  con otra huella, inválida o no apta (`banco_sha256` distinto del banco cargado, otra `regla` o `valido: false`): se
  ignora (`calibracion: null`, motivo `calibracion_*`) y el banco queda con coincidencia exacta y derivación por términos.
- **Aviso de arranque**: evento `banco_cargado` o `banco_no_cargado` con `agenteId`, `codigo` (motivo o `ok`) y
  `calibracion=si|no`. Sin texto del banco ni de las derivaciones, ni nombres de bucket o rutas.
- **Tiempo límite**: la carga del banco de cada agente tiene un tope de 10 s (inyectable en pruebas con `tiempoBancoMs`); si
  GCS se cuelga, el motivo es `banco_tiempo` y el servicio arranca igual. Los agentes de `CHATBOTRAG_BANCOS` se validan contra las
  configuraciones ANTES de leer ningún banco (dos pasadas), así un arranque que va a fallar no gasta lecturas ni emite eventos.
  Defecto previo, NO corregido aquí: la lectura del paquete de Kuaa (`LectorPaqueteGcs`) no tiene tiempo límite; una llamada
  colgada a GCS detendría el arranque. Un tope allí exige cancelar la carga en curso para que no indexe tarde, y queda para otra tarea.
- **UTF-8 inválido**: un archivo con bytes que no son UTF-8 pero cuya huella coincide con la declarada se rechaza como
  `banco_invalido` (o `calibracion_invalida`), no como error de huella.
- **Calibración simulada**: una calibración medida con el proveedor `simulado` solo se admite con `APP_ENV=test`; fuera de
  pruebas es `calibracion_no_apta`.
- **Qué NO hace**: no conecta el enrutador al agente; no verifica `modelo` ni `dimension` de la calibración (H4d, cuando exista el
  embebedor: `verificarCalibracion`); no recarga en caliente; no escribe en el bucket ni lo crea; no garantiza que la huella
  declarada sea la correcta (la fija quien despliega) ni protege frente a quien pueda escribir el bucket y la variable (IAM).
- **Cómo se invalida o actualiza**: se publica una versión nueva en el bucket (carpeta `X.Y.Z` nueva, nunca se pisa una
  existente), se actualiza `CHATBOTRAG_BANCOS` con la versión y los SHA nuevos y se despliega. Quitar la entrada del agente (o
  las variables) y desplegar vuelve al comportamiento anterior.

### Enrutador conectado a Kuaa (H4d)

Conecta el enrutador de H2 a H4c al agente Kuaa (`oportunidad/enrutador-kuaa.ts` y `agente-kuaa.ts`). **Apagado por defecto:
solo se enciende por ambiente.**

- **Activación efectiva = configuración Y variable de entorno.** `enrutador.activo` en la configuración (`kuaa.json` lo
  declara `activo: true, carrilFijo: false`) y `CHATBOTRAG_ENRUTADOR` ∈ `apagado | activo | activo_fijo` (ausente o vacío =
  `apagado`; otro valor detiene el arranque). Además debe haber un banco declarado en `CHATBOTRAG_BANCOS` que haya cargado.
  `activo_fijo` solo enciende el carril fijo si la configuración también declara `carrilFijo: true`; ninguna de las dos lo
  enciende sola. Con `apagado`, sin banco o con la configuración apagada el recorrido de Kuaa es IDÉNTICO al anterior (una
  prueba compara los argumentos a `generar`, la salida, los eventos y las llamadas de embedding) y no se construye nada nuevo.
- **Dónde corre.** Tras la compuerta de entrada y ANTES de la memoria, el RAG y el modelo. `fijo` y `derivacion` no llaman al
  modelo: el texto sale por `armarTextoConD5` (D5), pasa por las compuertas de salida y por un verificador propio de Kuaa
  (enlaces y precios con los permitidos de la plataforma, tratamiento tributario, hechos no respaldados, fuga del prompt).
  El verificador además rechaza (descarta, no corrige) un texto aprobado que los retoques del modelo cambiarían: una marca
  literal como `[DERIVAR]` (salvo las `marcasLiterales`), un código interno, una promesa de entrega, un número de registro o un
  saludo inicial, con igualdad estricta y códigos enumerados (`marca_del_modelo`, `codigo_interno`, `promesa_entrega`,
  `numero_registro`, `saludo_inicial`). Las variables de la plantilla resueltas desde `plataforma`. Una derivación agrega la propuesta
  `atencion_humana_solicitada`; si ningún texto aprobado sirve, sale `mensajes.derivacion` con la misma propuesta. Un fijo no
  crítico rechazado sigue a la IA. La memoria de conversación se guarda como siempre. El tratamiento (vos, tú, usted) lo da
  el banco aprobado y la configuración.
- **Fallo seguro.** La semántica se usa solo si `verificarCalibracion` da `semanticaApta` con el modelo y la dimensión REALES del
  embebedor (y sin `admitirSimulado`, que solo vale con `APP_ENV=test`). El índice semántico se prepara UNA vez al arrancar
  (un embedding por pregunta del banco, con tope de 10 s) y solo si hay calibración; si falla no detiene el servicio y queda sin
  semántica (`semantica_no_disponible`). Si falla por cuota o saturación hay UN reintento tras una espera (2 s; reloj/espera
  inyectables), dentro del mismo tope. Cada instancia de Cloud Run lo prepara por su cuenta: el costo es un lote de N embeddings
  (N = preguntas del banco) por arranque en frío. Conviene alertar sobre `semantica=no` en el aviso de arranque. Sin calibración no
  se prepara nada. Embebedor caído, tiempo vencido, vector de otra dimensión o calibración no apta: el
  mensaje sigue por la IA de siempre, con el motivo enumerado en el evento `enrutador`. La coincidencia exacta nunca gasta embedding.
- **Latencia.** Solo el mensaje sin coincidencia exacta paga el embedding de la consulta, con tope de 1500 ms (inyectable). Con
  IA + RAG el vector se COMPARTE: la espera es la de esa única llamada (el RAG la habría hecho igual) y no se suma una segunda. Los
  ≈1,5 s se suman de verdad solo donde el RAG no corre (conocimiento sin RAG o sin índice). El tope deja de ESPERAR la llamada, no
  la cancela; si el servicio de embeddings está lento, el RAG espera la misma llamada compartida sin ese tope (como ya hacía con
  la suya). Una cortesía («gracias», «hola») salta la vía semántica y no gasta embedding.
- **Costo.** Un embedding por mensaje que no coincide de forma exacta, compartido con el RAG: ambos usan el mismo
  `EmbebedorConMemoria` (clave SHA-256 del texto, 60 s, 32 entradas), de modo que el vector se calcula una sola vez. Más el
  costo único de indexar las preguntas del banco al arrancar.
- **Bitácora.** Evento `enrutador` con carril, vía, similitud redondeada, motivo y latencia. El evento dice el carril FINAL: un
  fijo rechazado que sigue a la IA queda `carril:ia` con `carril_final:ia` y `texto_fijo_rechazado:<causa>`; un fijo crítico que D5
  deriva queda `derivacion`. También se registra si el enrutador falla por dentro (`motivo_ia:enrutador_error`). Con el enrutador
  encendido `mensaje_atendido` anota `carril:ia|fijo|derivacion` y, en los carriles fijo y derivación, `plataforma:<versión>`
  como el carril IA; con el enrutador apagado no hay ningún aviso nuevo. el aviso de arranque agrega
  `semantica=si|no enrutador=<modo>` solo cuando el enrutador está solicitado. Jamás el texto de la persona ni el del banco; la
  prueba de bitácora sin texto cubre el evento y los dos carriles nuevos.
- **Qué NO hace.** No recarga el banco en caliente (cambiarlo exige desplegar); no implementa D3 (aclaración «¿sobre qué plan?»); no
  corre sobre un mensaje que la compuerta de entrada bloquea. **D10 (un término de emergencia gana sobre una entrada bloqueada)
  queda PENDIENTE de decisión de Andres:** la causa es el ORDEN en `agente-kuaa.ts` (la compuerta de entrada va primero), no que
  `enrutar` no lo defina. Verificado: un mensaje de emergencia que menciona salud («me quiero suicidar, tengo depresión», «tengo
  cáncer y estoy muy mal, ayuda urgente», «estoy embarazada y tuve un sangrado fuerte») recibe `entradaBloqueada` hoy; es el
  comportamiento previo, no una regresión, y hay una prueba que lo documenta. La memoria del embebedor es
  por instancia; no verifica que el banco real sea correcto.
- **Observaciones.** (a) Una derivación emite la propuesta `atencion_humana_solicitada` también cuando `estados.atencion_humana` ya
  está en `en_curso` o `solicitada`: la plataforma debe deduplicarla. (b) El hueco «deducible del IRP» de la gramática tributaria
  (`afirmaTratamientoTributario`) es previo a H4d y sigue pendiente; el verificador de Kuaa hereda ese límite.
- **Cómo medirlo en staging sin riesgo.** La bandera está apagada por defecto y en producción no se declara. En staging se pone
  `CHATBOTRAG_ENRUTADOR=activo` (primero sin `carrilFijo`: solo derivaciones y críticos) con el banco y la calibración reales del
  bucket, y se observan los eventos `enrutador` (carril, vía, similitud, latencia) frente a los `mensaje_atendido`. Para apagarlo
  basta quitar la variable y desplegar.

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
