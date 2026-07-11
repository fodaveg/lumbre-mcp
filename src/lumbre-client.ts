/**
 * Cliente HTTP mínimo contra la API de Lumbre. Fase 1: `POST /api/ingest`
 * (crea) y `GET /api/tasks` (lee). Fase 2: `POST /api/mutations` (encola
 * completar/editar/reprogramar/borrar sobre una tarea EXISTENTE — ver
 * `src/routes/api/mutations/+server.ts` en el repo principal y `PHASE2.md`).
 * Todos se autentican con el MISMO token personal de email-to-task
 * (Ajustes → email entrante en la app), enviado como `Authorization: Bearer`.
 */

export interface LumbreConfig {
	baseUrl: string;
	token: string;
}

/** Recurrencia mínima que acepta `/api/ingest` (mismo shape que `InboundRecurrence`). */
export interface IngestRecurrence {
	freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
	interval?: number;
}

export interface AddTaskInput {
	text: string;
	list?: string;
	notes?: string;
	priority?: 'p1' | 'p2' | 'p3' | 'p4';
	date?: string;
	deadline?: string;
	recurrence?: IngestRecurrence;
	subtasks?: string[];
}

export type TaskScope = 'today' | 'week' | 'inbox' | 'someday' | 'overdue' | 'all';

export interface ListTasksInput {
	scope?: TaskScope;
	/** Nombre (case-insensitive) de una lista de "Algún día"; filtra las tareas
	 *  que pertenecen a ella. Sin `scope` explícito, el servidor amplía el
	 *  alcance temporal a "all" (ver `GET /api/tasks` en el repo principal). */
	list?: string;
	includeDone?: boolean;
}

export interface LumbreTask {
	id: string;
	content: string;
	done: boolean;
	priority: 1 | 2 | 3 | null;
	date: string | null;
	deadline: string | null;
	list: string | null;
	/** Id de la lista de "Algún día" a la que pertenece, o null. */
	somedayListId?: string | null;
	createdAt: string;
}

/** Error con el status HTTP adjunto, para poder dar mensajes específicos (401, 429…). */
export class LumbreApiError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'LumbreApiError';
	}
}

/** Cuerpo de error `{ message }` que produce `error()` de SvelteKit, si acaso. */
function extractMessage(body: unknown): string | null {
	if (body && typeof body === 'object' && 'message' in body) {
		const m = (body as { message: unknown }).message;
		if (typeof m === 'string') return m;
	}
	return null;
}

async function request(config: LumbreConfig, path: string, init: RequestInit = {}): Promise<unknown> {
	const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
	let res: Response;
	try {
		res = await fetch(url, {
			...init,
			headers: {
				authorization: `Bearer ${config.token}`,
				...init.headers
			}
		});
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new LumbreApiError(
			`No se pudo conectar con Lumbre en ${config.baseUrl} (${cause}). ¿Es correcto LUMBRE_BASE_URL?`
		);
	}

	const contentType = res.headers.get('content-type') ?? '';
	const body = contentType.includes('application/json')
		? await res.json().catch(() => null)
		: await res.text().catch(() => null);

	if (!res.ok) {
		if (res.status === 401) {
			throw new LumbreApiError(
				'Token inválido o no configurado (LUMBRE_TOKEN). Consíguelo en Ajustes → email entrante de Lumbre.',
				401
			);
		}
		if (res.status === 429) {
			throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
		}
		const detail = extractMessage(body) ?? (typeof body === 'string' ? body : JSON.stringify(body));
		throw new LumbreApiError(`Lumbre respondió ${res.status}: ${detail}`, res.status);
	}

	return body;
}

/** `POST /api/ingest`: encola una tarea nueva (el cliente de Lumbre la materializa al sincronizar). */
export async function addTask(config: LumbreConfig, input: AddTaskInput): Promise<void> {
	const body = await request(config, '/api/ingest', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	});
	if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
		throw new LumbreApiError('Lumbre no confirmó la ingesta (respuesta inesperada).');
	}
}

/** `GET /api/tasks`: lee las tareas del usuario dueño del token. */
export async function listTasks(config: LumbreConfig, input: ListTasksInput): Promise<LumbreTask[]> {
	const params = new URLSearchParams();
	if (input.scope) params.set('scope', input.scope);
	if (input.list) params.set('list', input.list);
	if (input.includeDone) params.set('includeDone', 'true');
	const qs = params.toString();
	const body = await request(config, `/api/tasks${qs ? `?${qs}` : ''}`);
	if (!Array.isArray(body)) {
		throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks.');
	}
	return body as LumbreTask[];
}

// ── Fase 2: mutar una tarea existente (ver PHASE2.md) ──────────────────────

export type MutationKind = 'complete' | 'update' | 'reschedule' | 'delete';

export interface CompleteMutationPayload {
	done: boolean;
}
export interface UpdateMutationPayload {
	content?: string;
	notes?: string;
	/** Nivel `1|2|3` (p1–p3), o `null` para quitar la prioridad (p4/ninguna).
	 *  El tool `update_task` traduce el `'p1'..'p4'` de cara al modelo a este
	 *  nivel antes de llamar aquí (ver `index.ts`). */
	priority?: 1 | 2 | 3 | null;
}
export interface RescheduleMutationPayload {
	/** `YYYY-MM-DD`, o `null` para mandar la tarea a "Algún día"/Bandeja. */
	date: string | null;
}
export type DeleteMutationPayload = Record<string, never>;

export interface MutateTaskInput {
	taskId: string;
	kind: MutationKind;
	payload: CompleteMutationPayload | UpdateMutationPayload | RescheduleMutationPayload | DeleteMutationPayload;
}

/**
 * `POST /api/mutations`: encola una mutación sobre una tarea EXISTENTE (el
 * cliente de Lumbre la aplica al sincronizar — no es instantáneo). Espejo de
 * `addTask`.
 */
export async function mutateTask(config: LumbreConfig, input: MutateTaskInput): Promise<void> {
	const body = await request(config, '/api/mutations', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	});
	if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
		throw new LumbreApiError('Lumbre no confirmó la mutación (respuesta inesperada).');
	}
}
