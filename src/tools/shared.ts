import type { z } from 'zod';
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
 * Aviso compartido en las tools de Fase 2 y en `mutate_tasks`/`mutate_brl` (13
 * usos): la app de Lumbre es ASÍNCRONA/eventual (igual que `add_task`) — cada
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
 * Mensaje legible para un elemento de `ops` que no encaja en la forma
 * ESTRICTA de su `op` (`mutateTasksStrictOpSchema`/`mutateBrlStrictOpSchema`,
 * ver `tools/batch.ts`/`tools/brl.ts`): identifica la op y, campo a campo,
 * qué falta o qué sobra — para que el modelo pueda corregir ESE elemento
 * concreto sin adivinar cuál campo venía mal. Compartida por `mutate_tasks` y
 * `mutate_brl`: la forma del mensaje no depende de qué dominio mutan.
 */
export function formatOpShapeError(op: string, error: z.ZodError): string {
	const parts = error.issues.map((issue) => {
		if (issue.code === 'unrecognized_keys') {
			return `campo(s) que no aplican a "${op}": ${issue.keys.join(', ')}`;
		}
		const field = issue.path.length > 0 ? issue.path.join('.') : '(op)';
		return `${field}: ${issue.message}`;
	});
	return `${op}: ${parts.join('; ')}`;
}
