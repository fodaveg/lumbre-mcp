# Imagen del transporte HTTP remoto de lumbre-mcp (mcp.lumbre.pro, tarea M2).
# `dist/` viene VERSIONADO en el repo (ver `ce4169b chore(dist): dist/
# versionado...` y la sección "Actualizar sin toolchain" del README) — esta
# imagen NO compila TypeScript, solo instala dependencias de producción y
# copia el `dist/` ya construido. Si `dist/` no trae `http.js`, recompílalo
# (`npm run build`) y commitéalo ANTES de construir la imagen.
FROM node:22-alpine

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

CMD ["node", "dist/http.js"]
