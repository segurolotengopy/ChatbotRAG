# syntax=docker/dockerfile:1.7
# Imagen del servicio ChatbotRAG para Cloud Run (o cualquier runtime de contenedores).
# Multi-etapa: se compila con pnpm y se copia solo lo necesario para ejecutar.
# El proceso corre como usuario sin privilegios y sin shell de escritura.

FROM node:22-bookworm-slim AS base
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

FROM node:22-bookworm-slim AS ejecucion
ENV NODE_ENV=production PUERTO=8080
WORKDIR /app
COPY --from=construccion /salida ./
COPY configuraciones ./configuraciones
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/principal.js"]
