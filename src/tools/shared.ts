import { z } from 'zod';
import type { NotesSeenStore } from '../notes.js';
import type { BrlExistenceCache, TaskExistenceCache } from '../existence-cache.js';
import { LumbreApiError, type LumbreConfig } from '../lumbre-client.js';

/**
 * Contexto explícito que recibe cada `registerXTools(server, ctx)` (tarea de
 * partir `index.ts` en `src/tools/` por familia, 2026-09-17): antes vivía como
 * closure sobre las variables locales de `createServer` (`config`,
 * `taskCache`…); ahora se pasa EXPLÍCITO para que cada módulo de familia
 * pueda registrar sus tools sin depender de dónde vive `createServer`. Mismos
 * valores, mismo ciclo de vida (una instancia por servidor, ver
 * `existence-cache.ts` y `CreateServerOptions` en `index.ts`) — es un cambio
 * de MECANISMO (paso explícito en vez de clausura), no de comportamiento.
 */
export interface ToolCtx {
	config: LumbreConfig;
	/** Caché corta de existencia de TAREAS (ver `requireTaskExists`, más abajo,
	 *  y `existence-cache.ts`). */
	taskCache: TaskExistenceCache;
	/** Caché corta de existencia de entradas del BRL (ver `mutate_brl` en
	 *  `tools/brl.ts`). */
	brlCache: BrlExistenceCache;
	/** Huella de notas vistas (ver `notes.ts`) — default `fileNotesSeenStore`. */
	notesSeenStore: NotesSeenStore;
	/** Si este proceso VE el disco del usuario (ver el JSDoc de
	 *  `CreateServerOptions.localFilesystem` en `index.ts`). */
	localFilesystem: boolean;
}

/** Respuesta de texto plano — la forma que usan casi todas las tools. */
export function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

/** Respuesta de error uniforme: mensaje de `LumbreApiError`/`Error` tal cual,
 *  o `String(err)` para cualquier otra cosa lanzada. */
export function errorResult(err: unknown) {
	const message = err instanceof LumbreApiError ? err.message : err instanceof Error ? err.message : String(err);
	return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

/**
 * Aviso compartido en `mutate_tasks`/`organize`/`mutate_brl` (desde la fusión
 * de las tools sueltas de Fase 2, 2026-09-19, ya solo tres usos: sus ops
 * heredan el aviso de la tool que las encola): la app de Lumbre es
 * ASÍNCRONA/eventual (igual que `add_task`) — cada
 * mutación se encola y se aplica la próxima vez que un dispositivo del
 * usuario sincronice, no al instante, y ninguna tool da confirmación
 * inmediata de que se aplicó de verdad (usa `list_tasks` más tarde para
 * comprobarlo). Versión CORTA a propósito, y recortada de nuevo el
 * 2026-09-17 (quitado "(como add_task)", que no es uno de los tres hechos que
 * esta frase tiene que dar: se encola, se aplica al sincronizar, sin
 * confirmación inmediata) — el detalle completo (por qué es eventual, el
 * rebote del WebSocket, etc.) vive una única vez en `README.md` ("Qué hace —
 * Fase 2"). Compartida por `tools/tasks.ts`, `tools/brl.ts` y `tools/batch.ts`
 * (tarea de partir `index.ts` en `src/tools/`, 2026-09-17) — antes vivía
 * aquí, en `index.ts`, como una única constante de módulo.
 */
export const ASYNC_NOTE = 'Asíncrono: se encola y se aplica al sincronizar, sin confirmación inmediata.';

/**
 * Mapa op → tool que la implementa, con las 16 ops de tarea repartidas entre
 * las DOS tools de lote (2026-09-19, tarea 6f62c877): `mutate_tasks` opera
 * sobre UNA tarea (`add_task`/`complete`/`cancel`/`update`/`reschedule`/
 * `set_section`/`add_subtask`/`complete_subtask`) y `organize` reorganiza y
 * borra (`delete`/`remove_section`/`create_list`/`nest_list`/`rename_list`/
 * `remove_list`/`set_list_notes`/`move_to_list`). Se consulta en los DOS
 * sentidos: cada tool usa el mapa para señalar a la otra cuando recibe una op
 * ajena (ver `formatOpShapeError`, justo debajo), así que un modelo que
 * mande `delete` a `mutate_tasks` lee dónde vive de verdad en vez de un
 * "discriminador inválido" a secas.
 */
export const TASK_OP_TOOL: Record<string, 'mutate_tasks' | 'organize'> = {
	add_task: 'mutate_tasks',
	complete: 'mutate_tasks',
	cancel: 'mutate_tasks',
	update: 'mutate_tasks',
	reschedule: 'mutate_tasks',
	set_section: 'mutate_tasks',
	add_subtask: 'mutate_tasks',
	complete_subtask: 'mutate_tasks',
	delete: 'organize',
	remove_section: 'organize',
	create_list: 'organize',
	nest_list: 'organize',
	rename_list: 'organize',
	remove_list: 'organize',
	set_list_notes: 'organize',
	move_to_list: 'organize'
};

/**
 * Mensaje legible para un elemento de `ops` que no encaja en la forma
 * ESTRICTA de su `op` (`mutateTasksStrictOpSchema`/`organizeStrictOpSchema`/
 * `mutateBrlStrictOpSchema`, ver `tools/batch.ts`/`tools/brl.ts`): identifica
 * la op y, campo a campo, qué falta o qué sobra — para que el modelo pueda
 * corregir ESE elemento concreto sin adivinar cuál campo venía mal.
 * Compartida por `mutate_tasks`, `organize` y `mutate_brl`: la forma del
 * mensaje no depende de qué dominio mutan.
 *
 * `tool` (opcional, las dos tools de tarea lo pasan): si la op EXISTE pero es
 * de la OTRA tool, el mensaje deja de ser el volcado de Zod y pasa a ser el
 * puntero del mapa `TASK_OP_TOOL` — el único fallo de forma cuya corrección
 * no es tocar un campo, sino cambiar de tool.
 */
export function formatOpShapeError(op: string, error: z.ZodError, tool?: string): string {
	const owner = TASK_OP_TOOL[op];
	if (tool !== undefined && owner !== undefined && owner !== tool) {
		return `la op "${op}" no existe en ${tool}; está en ${owner} — mándala en una llamada a ${owner}.`;
	}
	return formatZodOpShapeError(op, error);
}

/** Volcado campo a campo de un `ZodError` de forma (el caso normal de
 *  `formatOpShapeError`, separado para que el puntero op→tool de arriba se
 *  lea de un vistazo). */
function formatZodOpShapeError(op: string, error: z.ZodError): string {
	const parts = error.issues.map((issue) => {
		if (issue.code === 'unrecognized_keys') {
			return `campo(s) que no aplican a "${op}": ${issue.keys.join(', ')}`;
		}
		const field = issue.path.length > 0 ? issue.path.join('.') : '(op)';
		return `${field}: ${issue.message}`;
	});
	return `${op}: ${parts.join('; ')}`;
}

/** Recurrencia simple (freq + interval), como la celda "Repetir" del quick-add
 *  de Lumbre — compartida por `add_task` (`tools/tasks.ts`) y `mutate_tasks`
 *  (`tools/batch.ts`, misma forma que la op `add_task`). */
export const recurrenceSchema = z
	.object({
		freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']).describe('Frecuencia de la repetición'),
		interval: z.number().int().positive().optional().describe('Cada cuántas unidades (default 1)')
	})
	.describe('Recurrencia simple (freq + interval), como la celda "Repetir" del quick-add de Lumbre');

/** Forma de un tag propio — compartida por `tools/tasks.ts` (`add_task`) y
 *  `tools/batch.ts` (`mutateTasksOpSchema.tags`, ops `add_task`/`update`). */
export const tagSchema = z.string().regex(/^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u);
