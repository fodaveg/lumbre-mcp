# Imagen del transporte HTTP remoto de lumbre-mcp (mcp.lumbre.pro, tarea M2).
# `dist/` viene VERSIONADO en el repo (ver `ce4169b chore(dist): dist/
# versionado...` y la sección "Actualizar sin toolchain" del README) — esta
# imagen NO compila TypeScript, solo instala dependencias de producción y
# copia el `dist/` ya construido. Si `dist/` no trae `http.js`, recompílalo
# (`npm run build`) y commitéalo ANTES de construir la imagen.
#
# Base fijada por digest (índice multiarquitectura de `node:22-alpine`, Node
# 22.23.3, leído con `docker buildx imagetools inspect node:22-alpine` el 11
# oct 2026): un rebuild sin caché ya no cambia de Node sin avisar. Para
# subirla, repetir ese comando y cambiar el digest en un commit propio.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /app

# Solo dependencias de producción (@modelcontextprotocol/sdk + zod) — sin
# devDependencies (typescript, vitest) que no hacen falta en runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# El servidor no tiene token propio (relé stateless, ver `src/http.ts`):
# LUMBRE_TOKEN NO se declara aquí. `PORT` y `LUMBRE_BASE_URL` sí son del
# proceso — ver `deploy/README-deploy.md` para los valores reales.
ENV PORT=8787
EXPOSE 8787

# Commit del que sale la imagen (lo pasa `deploy/publicar.sh` vía compose).
# Al final a propósito: cambia en cada deploy y no debe invalidar la capa de
# `npm ci`. Se lee con
# `docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' lumbre-mcp`.
ARG REVISION=desconocida
LABEL org.opencontainers.image.revision=$REVISION

CMD ["node", "dist/http.js"]
