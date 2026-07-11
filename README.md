# lumbre-mcp

Conector [MCP](https://modelcontextprotocol.io) de **Lumbre** (Fase 1) — deja
que Claude Code (u otro cliente MCP) añada y consulte tareas de tu
planificador semanal desde una conversación.

Paquete Node/TS **independiente** del resto del repo (su propio
`package.json`/`tsconfig.json`); no comparte dependencias con la app SvelteKit.

## Qué hace (Fase 1)

- `add_task` — añade una tarea nueva a Lumbre (vía `POST /api/ingest`, el
  mismo endpoint que usa email-to-task/Atajos de iOS). Se encola y se
  materializa en el planificador la próxima vez que un dispositivo tuyo
  sincronice; no es instantáneo si no hay ningún dispositivo online.
- `list_tasks` — lee tus tareas (vía `GET /api/tasks`, solo lectura). Acota
  por `scope`: `today` (default), `week`, `inbox`/`someday` (sin fecha),
  `overdue` o `all`; puede incluir completadas con `includeDone`.

**Limitación conocida:** las listas de "Algún día" (proyectos) viven solo en
el CRDT del cliente, no en el servidor — así que `list_tasks` no puede
filtrar por nombre de lista todavía (el parámetro `list` da un error
explicativo si se usa). Ver `PHASE2.md` para el resto de huecos conocidos y
lo que falta para mutar tareas existentes (completar/editar/reprogramar/
borrar).

## Compilar

```bash
cd mcp
npm install   # o pnpm install / yarn — es un paquete independiente
npm run build # → dist/index.js
```

## Configurar en Claude Code

Necesitas tu **token de email-to-task**: en la app de Lumbre, Ajustes →
sección de email entrante (el mismo token que usa `task+<token>@…` y
`/api/ingest`; si aún no lo tienes, la app lo genera la primera vez que
entras a esa sección).

Añade el servidor a tu configuración de MCP de Claude Code (por ejemplo
`~/.claude.json` o la config de proyecto, según cómo gestiones tus MCP
servers), apuntando `command`/`args` al `dist/index.js` compilado arriba:

```json
{
	"mcpServers": {
		"lumbre": {
			"command": "node",
			"args": ["/ruta/absoluta/a/lumbre/mcp/dist/index.js"],
			"env": {
				"LUMBRE_TOKEN": "tu-token-de-email-to-task",
				"LUMBRE_BASE_URL": "https://lumbre.pro"
			}
		}
	}
}
```

- `LUMBRE_TOKEN` es **obligatorio** — sin él, el proceso falla al arrancar con
  un error explicativo (nunca lo pidas al modelo ni lo hardcodees en el
  código: va en tu config LOCAL, fuera de cualquier repo).
- `LUMBRE_BASE_URL` es opcional (default `https://lumbre.pro`); cámbialo si
  usas un self-host distinto (p. ej. `http://localhost:5173` en dev, aunque
  ahí necesitarás que `/api/ingest`/`/api/tasks` sean alcanzables sin TLS).

También puedes probarlo suelto por stdio para depurar:

```bash
LUMBRE_TOKEN=tu-token node dist/index.js
```

(no imprime nada por stdout salvo el protocolo MCP; los errores de arranque
van a stderr).
