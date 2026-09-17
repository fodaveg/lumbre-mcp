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
