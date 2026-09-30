# Costos de nube de ChatbotRAG — insumo para la decisión de facturación

**Fecha: 2026-09-30.** Precios leídos ese día de las páginas oficiales de Google Cloud
(`cloud.google.com/run/pricing`, `.../generative-ai/pricing`, `.../artifact-registry/pricing`,
`.../secret-manager/pricing`), región **us-central1**, en USD.

Este documento existe porque la matriz de costos del estándar
(`00-gobernanza/04-matriz-herramientas-y-costos.md`) excluye a propósito el cómputo, el
almacenamiento y el egreso de nube: «existen con o sin el estándar». Es justamente lo que
falta para decidir si se vincula la cuenta de facturación.

> **Estado de los proyectos al escribir esto**: `rag-generico` (staging) y
> `rag-generico-prod` (producción) existen y están activos, **ninguno con facturación
> habilitada**. Sin ella no se pueden habilitar Cloud Run, Artifact Registry, Vertex AI ni
> Secret Manager, y `setup-oidc-gcp.sh` falla en su primer `gcloud services enable`.

## 1. De dónde salen los números de uso

No son supuestos: se **midieron** sobre el código de este repositorio, envolviendo el
proveedor simulado para capturar cada petición que el agente arma (sin llamar a ninguna nube).

| Medición | Valor |
|---|---|
| Caracteres por llamada al modelo | 10.048 mínimo · **11.532 promedio** · 13.817 máximo |
| Desglose del promedio | 8.519 el prompt de sistema · 1.791 los mensajes · 1.222 las herramientas |
| Tokens de entrada por llamada | **≈ 2.883** (caracteres ÷ 4) |
| Llamadas al modelo por conversación | **7**, para 6 turnos (un turno usó una herramienta y gastó dos) |

Configuración vigente de `configuraciones/segurolotengo.json`: `gemini-2.5-flash`,
`text-embedding-005`, `maxTokensSalida: 1024`, `maxIteraciones: 3`, `ventanaMemoria: 10`,
`conocimiento.topK: 5`.

**El prompt de sistema es el 74 % del costo de entrada.** Se rearma completo en cada llamada
y no cambia dentro de una conversación: es el primer candidato a optimizar (ver §5).

Único supuesto no medido: **150 tokens de salida por llamada**. La voz está configurada en
`longitud: breve` y las respuestas de la simulación rondan ese tamaño, pero el tope es 1024;
si las respuestas reales salen más largas, el renglón de salida crece en proporción.

## 2. Vertex AI — el único costo que importa

Precios por millón de tokens, leídos hoy:

| Modelo | Entrada | Salida | USD por conversación | Conversaciones por USD |
|---|---|---|---|---|
| **`gemini-2.5-flash`** (el configurado) | 0,30 | 2,50 | **0,00868** | 115 |
| `gemini-2.5-flash-lite` | 0,10 | 0,40 | 0,00244 | 410 |
| `gemini-3.1-flash-lite` | 0,25 | 1,50 | 0,00662 | 151 |
| `gemini-3.8-flash` (precio promocional hasta el 31-dic-2026) | 0,75 | 3,75 | 0,01907 | 52 |

Proyección mensual:

| Conversaciones/mes | `2.5-flash` | `2.5-flash-lite` |
|---|---|---|
| 500 | USD 4,34 | USD 1,22 |
| 2.000 | USD 17,36 | USD 4,88 |
| 5.000 | USD 43,40 | USD 12,19 |
| 10.000 | USD 86,79 | USD 24,38 |
| 30.000 | USD 260,38 | USD 73,14 |

**Vertex AI no tiene nivel gratuito** para estos modelos. La cuenta de facturación es
existente, así que tampoco corresponde el crédito de prueba de USD 300.

**Embeddings**: `text-embedding-005` cuesta USD 0,000025 por cada 1.000 unidades de entrada.
El corpus completo son 64 KB (≈ 16.000 tokens) y se indexa una vez por arranque: menos de
USD 0,001. Cada consulta embebe una pregunta de ~20 tokens. **Redondea a cero** y no entra en
las proyecciones.

## 3. Cloud Run — gratis hasta 10.000 conversaciones al mes

Facturación basada en solicitudes (la predeterminada de un servicio): CPU activa USD
0,000024/vCPU-s, memoria USD 0,0000025/GiB-s, solicitudes USD 0,40 por millón. Nivel gratuito
mensual **por cuenta de facturación**: 180.000 vCPU-s, 360.000 GiB-s y 2 millones de solicitudes.

Con 1 vCPU, 512 MiB y 3 segundos por petición —6 peticiones por conversación— cada
conversación consume 18 vCPU-s y 9 GiB-s:

| Recurso | Tope gratuito | Alcanza para |
|---|---|---|
| CPU | 180.000 vCPU-s | **10.000 conversaciones/mes** ← el límite real |
| RAM | 360.000 GiB-s | 40.000 conversaciones/mes |
| Solicitudes | 2.000.000 | 333.333 conversaciones/mes |

Dos advertencias:

- **El nivel gratuito es por cuenta de facturación, no por proyecto.** Si se vincula la misma
  cuenta a staging y a producción, los dos comparten el mismo cupo; y también lo comparten
  los demás proyectos de la cuenta que usen Cloud Run.
- **`min-instances` en 0 es lo que mantiene esto en cero.** `deploy.sh` no fija
  `--min-instances`, así que hoy el servicio escala a cero y no se paga inactividad. Poner una
  instancia mínima para evitar el arranque en frío cuesta USD 0,0000025/vCPU-s **y** por
  GiB-s de inactividad: una instancia de 1 vCPU y 512 MiB encendida todo el mes son unos
  **USD 8,20**, más que el propio modelo con 2.000 conversaciones.

## 4. Artifact Registry y Secret Manager — centavos

| Servicio | Precio | Situación de este proyecto |
|---|---|---|
| Artifact Registry | 0,5 GiB-mes gratis; después USD 0,000136986/GiB-hora (≈ **USD 0,10/GiB-mes**) | La imagen **no se pudo medir** (ver §6). Estimada en 300–400 MiB sobre `node:22-bookworm-slim`, que ya son 227 MiB. Diez etiquetas retenidas ≈ 3,5 GiB ≈ **USD 0,30/mes**. Conviene una política de limpieza desde el principio. |
| Transferencia del registro a Cloud Run | Gratis dentro de la misma región | El registro y el servicio están los dos en us-central1: **USD 0**. |
| Secret Manager | 6 versiones activas y 10.000 accesos gratis; después USD 0,06/versión/mes y USD 0,03 por 10.000 accesos | `CHATBOTRAG_CLIENTES` y las credenciales por ambiente entran holgadamente: **USD 0**. |
| Artifact Analysis (escaneo del registro) | USD 0,26 por imagen, sin nivel gratuito | **No activar en staging.** El estándar lo recomienda solo en el registro de producción, donde se publican pocas imágenes al mes. |
| Egreso a internet | 1 GiB/mes gratis en Norteamérica, después tarifas premium | Las respuestas del chat son texto: irrelevante. |

## 5. Las tres palancas, en orden de efecto

1. **El modelo.** Pasar a `gemini-2.5-flash-lite` baja el costo un **72 %** (de 0,00868 a
   0,00244 por conversación). Es la palanca más grande y la más fácil: un campo en
   `configuraciones/segurolotengo.json`. Exige medir calidad —las compuertas de salida y el
   requisito de respaldo documental son el piso de seguridad, no la calidad de redacción— con
   los 200 casos que ya están previstos para el pase a producción.
2. **El prompt de sistema.** 8.519 caracteres rearmados en cada una de las 7 llamadas. El
   contexto en caché cuesta USD 0,03 por millón en lugar de 0,30 —**diez veces menos**— y el
   prompt de sistema es idéntico entre llamadas de una misma conversación. Hoy el adaptador de
   Vertex no usa caché de contexto: implementarlo recortaría buena parte de ese 74 %.
3. **`maxIteraciones: 3`.** Cada iteración es una llamada completa con el prompt entero. La
   medición dio 7 llamadas para 6 turnos; con más uso de herramientas la relación empeora.

## 6. Qué no está verificado

- **La imagen no se pudo construir en este equipo.** El Dockerfile usa
  `RUN --mount=type=cache`, que exige BuildKit, y este equipo tiene Docker 29.1.3 **sin el
  componente buildx** (`docker buildx` no existe), así que el constructor clásico falla con
  «the --mount option requires BuildKit» y con `DOCKER_BUILDKIT=1` falla con «buildx component
  is missing». **No afecta a CI**, que usa `docker/setup-buildx-action`. Sí afecta a
  `./deploy.sh staging` ejecutado desde este equipo: moriría en la fase 4/7. Es una carencia
  del equipo, no del proyecto, pero conviene saberlo antes de intentar un despliegue manual.
- **Los 150 tokens de salida** son el único supuesto de uso (§1).
- **Los 3 segundos por petición** de la §3 son un supuesto razonable para una llamada a
  Gemini Flash, no una medición: no hay despliegue contra el que medirlo.
- **Los precios cambian.** Los de esta página se leyeron el 2026-09-30; `gemini-3.8-flash`
  tiene precio promocional que sube al doble el 1-ene-2027.

## 7. Lectura corta

Para un piloto —de 500 a 2.000 conversaciones al mes— el costo de nube va de **USD 4 a USD 18
mensuales**, y baja a **USD 1 a USD 5** con `flash-lite`. Cloud Run, el registro y los secretos
son cero o centavos en ese rango: **todo el costo es Vertex AI**.

El riesgo no está en el precio unitario, está en tres decisiones de configuración que lo
multiplican: una instancia mínima (USD 8,20/mes de piso), Artifact Analysis en staging (USD
0,26 por push) y un modelo más caro de lo necesario. Ninguna está activada hoy.
