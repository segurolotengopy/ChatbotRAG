# syntax=docker/dockerfile:1.7
# Imagen del servicio ChatbotRAG para Cloud Run (o cualquier runtime de contenedores).
# Multi-etapa: se compila con pnpm y se copia solo lo necesario para ejecutar.
# El proceso corre como usuario sin privilegios y sin shell de escritura.

# node:22-bookworm-slim (digest medido el 2026-10-10). El tag va de comentario:
# el digest es obligatorio para que la imagen sea reproducible y auditable.
FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

FROM base AS dependencias
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY paquetes/nucleo/package.json paquetes/nucleo/
COPY paquetes/proveedor-vertex/package.json paquetes/proveedor-vertex/
COPY paquetes/proveedor-bedrock/package.json paquetes/proveedor-bedrock/
COPY paquetes/conocimiento-pgvector/package.json paquetes/conocimiento-pgvector/
COPY paquetes/canal-web/package.json paquetes/canal-web/
COPY servicio/package.json servicio/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM dependencias AS construccion
COPY tsconfig.base.json tsconfig.json ./
COPY paquetes ./paquetes
COPY servicio ./servicio
RUN pnpm construir && pnpm --filter servicio deploy --prod --legacy /salida

# node:22-bookworm-slim, el mismo digest que la etapa de construcción.
FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS ejecucion
ENV NODE_ENV=production PUERTO=8080
WORKDIR /app

# Dos correcciones de la imagen base, medidas con Trivy el 2026-10-10 sobre el
# digest de arriba. Las dos van ANTES de `USER node` porque necesitan root.
#
# (1) `perl-base` viene en 5.36.0-7+deb12u3 y arrastra 3 CRITICAL y 4 HIGH
#     (travesía de rutas en Archive-Tar, desbordamiento de heap, proceso
#     incorrecto de expresiones regulares). El parche está en +deb12u4, en el
#     repositorio de seguridad de Debian; la imagen base aún no lo incorpora,
#     así que pinear un digest más nuevo NO alcanza. No se puede desinstalar:
#     en Debian `perl-base` es Essential y dpkg depende de él.
#     La versión va fija porque hadolint lo exige (DL3008) y porque deja por
#     escrito qué parche se instaló. Tiene un costo: cuando Debian publique
#     +deb12u5 y retire esta del espejo, la construcción FALLARÁ. Es el
#     comportamiento preferible: una falla ruidosa que obliga a revisar el
#     parche, en lugar de una deriva silenciosa.
#
# (2) El `npm` que trae la imagen aporta 10 hallazgos más por sus propias
#     dependencias (brace-expansion, ip-address, pacote, picomatch, sigstore).
#     Esta etapa no lo usa: el árbol de ejecución lo produce `pnpm deploy` y el
#     arranque es `node dist/principal.js`. Se quita en lugar de exceptuarlo:
#     menos superficie y una imagen más chica. Corepack vive aparte y solo se
#     usa en las etapas de construcción, que conservan su npm.
RUN apt-get update \
 && apt-get install --no-install-recommends -y perl-base=5.36.0-7+deb12u4 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=construccion /salida ./
COPY configuraciones ./configuraciones
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/principal.js"]
