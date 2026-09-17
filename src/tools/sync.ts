import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { refreshSync } from '../lumbre-client.js';
import { errorResult, textResult, type ToolCtx } from './shared.js';

/**
 * Familia «sync»: UNA sola tool, `refresh_sync`. Extraída de `index.ts` tal
 * cual (tarea de partir el servidor en `src/tools/` por familia, 2026-09-17) —
 * cero cambios de comportamiento, solo el paso de `config` explícito por
 * `ctx` en vez de closure.
 */
export function registerSyncTools(server: McpServer, ctx: ToolCtx) {
	/**
	 * MEDIDO el 2026-08-27, y cambia lo que hay que contarle al modelo: una
	 * lectura hecha justo DESPUÉS de una mutación de este mismo MCP ya sale
	 * fresca SIN ningún flush por medio. Cinco corridas contra el servidor
	 * real con el binario ANTERIOR a esta descripción (o sea, sin nada que
	 * refrescara solo), por los DOS caminos de escritura que existen
	 * (`add_task` → `POST /api/ingest` y `mutate_tasks` → `POST /api/batch`):
	 * en las cinco, la tarea recién creada aparecía en el `list_tasks`
	 * inmediatamente siguiente.
	 *
	 * DE QUÉ DEPENDE ESA FRESCURA, que no es lo que parece. NO es «las
	 * escrituras van por REST y el rebote solo afecta al WebSocket». Es que
	 * los tres handlers de escritura del repo principal
	 * (`/api/ingest:289`, `/api/batch:253` — uno solo para todo el lote — y
	 * `/api/mutations:148`) llaman a `runHeadlessDrain`
	 * (`src/lib/server/sync/drain.ts:96-107`) ANTES de responder, y ese
	 * drenaje persiste en sus dos ramas: con la app del usuario abierta
	 * fuerza el guardado en vez de esperar al rebote de 250 ms, y sin ella
	 * hidrata un store efímero del blob, materializa y vuelve a persistir a
	 * mano. Dato de la sesión que mantiene ese repo, 2026-08-27.
	 *
	 * O sea que la propiedad se apoya en un drenaje SÍNCRONO al final del
	 * handler ajeno. Si alguien lo mueve a segundo plano para bajar la
	 * latencia (y hay motivo: la mutación tarda ~4,4 s en responder, que es
	 * justo ese drenaje), esta descripción pasa a mentir y NINGÚN test de
	 * este repo se entera. Si la app empieza a leer viejo justo después de
	 * escribir, mira ahí antes que aquí.
	 *
	 * Lo que esta tool SÍ sigue arreglando es el otro caso, que no se puede
	 * medir desde aquí y por eso no se toca: el rancio que arregla no lo
	 * produce este MCP, lo produce un cliente conectado cuyos cambios están
	 * en la room y aún no han bajado al blob. Las lecturas del MCP van por
	 * REST y leen lo persistido, así que ese cambio no se ve hasta que
	 * alguien fuerza el flush. Por eso NO se convierte en no-op cuando «no
	 * hay nada que este MCP haya mutado»: este MCP no se entera de esos
	 * cambios.
	 *
	 * Y no es gratis saltárselo mal: `flushPersister` llama a `save()`
	 * incondicionalmente y acaba en un SELECT más un `insert … on conflict`
	 * con el blob ENTERO, haya cambiado algo o no. Con la app del usuario
	 * CERRADA sí es barato de verdad, porque `flushSyncRoom` corta en la
	 * primera línea al no haber room. Se midieron 506 llamadas en 2.056
	 * transcripts.
	 */
	const refreshSyncTool = server.registerTool(
		'refresh_sync',
		{
			description:
				'Fuerza el flush de sync de Lumbre. NO hace falta llamarla por una mutación hecha con ' +
				'ESTE MCP: cuando la tool de escritura responde, el servidor ya la ha aplicado y la ' +
				'siguiente lectura la ve (medido). SÍ hace falta cuando el cambio viene de FUERA de ' +
				'este MCP (la app o el móvil del usuario) y quieres que se vea ya, porque de esos ' +
				'cambios este MCP no se entera solo. Solo garantiza lo que YA llegó al servidor por ' +
				'WebSocket — si el dispositivo del usuario está offline, sus cambios sin enviar no se ' +
				'pueden recuperar. Sin parámetros.',

			inputSchema: {}
		},
		async () => {
			try {
				await refreshSync(ctx.config);
				return textResult('Sync de Lumbre refrescado: el servidor ya tiene persistido todo lo que le había llegado.');
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	return { refreshSyncTool };
}
