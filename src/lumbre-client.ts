import { randomUUID } from 'node:crypto';
// El tope de bajada es el MISMO que el de subida y vive en un solo sitio
// (`attachments.ts`), que no importa nada de aquí: no hay ciclo.
import { MAX_ATTACHMENT_BYTES } from './attachments.js';

/**
 * Cliente HTTP mínimo contra la API de Lumbre. Fase 1: `POST /api/ingest`
 * (crea) y `GET /api/tasks` (lee). Fase 2: `POST /api/mutations` (encola
 * completar/editar/reprogramar/borrar/mover-de-sección/cancelar/añadir-
 * subtareas sobre una tarea EXISTENTE, o crear/anidar-desanidar/renombrar/
 * borrar una LISTA de "Algún día" — ver
 * `src/routes/api/mutations/+server.ts` en el repo principal y `PHASE2.md`).
 * Feature batch (`plan-batch.md`): `POST /api/batch` (N ops de golpe) y
 * `GET /api/tasks?ids=` (existencia en lote) — ver el final de este fichero.
 * `POST /api/attachments?taskId=` (`uploadAttachment`) sube un fichero y lo
 * enlaza a una tarea — a diferencia de todo lo anterior, es SÍNCRONO: escribe
 * la metadata al CRDT antes de responder, sin esperar a que el cliente
 * sincronice (ver su JSDoc, más abajo). `DELETE /api/attachments/:id`
 * (`deleteAttachment`) retira un adjunto propio por el mismo canal autenticado.
 * Todos se autentican con el MISMO token personal de email-to-task
 * (Ajustes → email entrante en la app), enviado como `Authorization: Bearer`.
 */

export interface LumbreConfig {
	baseUrl: string;
	token: string;
	/** Cómo llegó `token` a este proceso — decide el mensaje de un 401 (ver
	 *  `unauthorizedApiError`). `'token'` (default si se omite): credencial
	 *  ESTÁTICA — el `LUMBRE_TOKEN` de env del conector stdio (`index.ts`,
	 *  `loadConfig`), o el mismo tipo de token pasado por HTTP en modo
	 *  compatibilidad (Bearer directo/path, ver `http.ts`). `'oauth'`: el
	 *  transporte HTTP remoto resolvió un access token OAuth 2.1 a la
	 *  credencial dedicada (`oauth.ts`, `resolveAccessToken`) — nombrar
	 *  `LUMBRE_TOKEN` ahí sería falso (este proceso nunca lo lee) y no le dice
	 *  a quien lo usa cómo arreglarlo de verdad. Tarea 0a717ae9. */
	authMode?: 'token' | 'oauth';
}

/** Frecuencia de una regla de repetición (`Freq` de `$lib/recurrence` en el
 *  repo principal). */
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

/**
 * Regla de repetición COMPLETA, la misma forma que `Recurrence` de
 * `$lib/recurrence` en el repo principal: es lo que aceptan `/api/ingest` y el
 * `update` de `/api/batch` (los dos pasan por `normalizeRecurrence`) y lo que
 * devuelve `GET /api/tasks` en `recurrence`, ya parseada.
 *
 * Hasta el 23 sep 2026 aquí solo había `freq` e `interval` (MC3 del audit de
 * paridad del MCP): Zod descartaba en silencio el resto, así que «semanal
 * lunes y jueves» se creaba en el día del ancla y retocar la regla de un
 * hábito le quitaba `streak`, que es lo que lo hace hábito.
 *
 * `mode: 'afterCompletion'` viaja con `freq` como UNIDAD (la app la
 * reescribe a su forma serializada en `normalizeRecurrence`); en ese modo la
 * app ignora `byWeekday`, igual que en cualquier `freq` que no sea `weekly`.
 */
export interface IngestRecurrence {
	mode?: 'calendar' | 'afterCompletion';
	freq: RecurrenceFreq;
	interval?: number;
	/** Solo semanal: días en los que repite, 0 = lunes … 6 = domingo. */
	byWeekday?: number[];
	/** Último día de la serie, inclusive (`YYYY-MM-DD`). */
	until?: string;
	/** Número máximo de ocurrencias (>= 1). */
	count?: number;
	/** Hábito: la serie cuenta racha. */
	streak?: boolean;
}

/**
 * Cambio PARCIAL de la regla que pide `mutate_tasks` en un `update`: solo los
 * campos enviados cambian, el resto se conserva de la regla actual (ver
 * `mergeRecurrencePatch`). `null` en `byWeekday`/`until`/`count` quita ese
 * campo, `streak: false` quita la marca de hábito y `mode: 'calendar'`
 * vuelve al modo por defecto.
 */
export interface RecurrencePatch {
	mode?: 'calendar' | 'afterCompletion';
	freq?: RecurrenceFreq;
	interval?: number;
	byWeekday?: number[] | null;
	until?: string | null;
	count?: number | null;
	streak?: boolean;
}

export interface AddTaskInput {
	text: string;
	/** Tags propios explícitos; `[]` declara deliberadamente que la tarea no
	 *  tiene ninguno. */
	tags?: string[];
	list?: string;
	/** Id ESTABLE de la lista de "Algún día" destino (lote 2 — identidad de
	 *  listas), alternativa a `list` (por nombre) inmune a renames. Preferente
	 *  sobre `list` si se indican ambos — ver `/api/ingest` en el repo principal. */
	listId?: string;
	/** Nombre de la sección/heading dentro de `list` (se crea si no existe);
	 *  se ignora si no se indica `list`. */
	section?: string;
	notes?: string;
	priority?: 'p1' | 'p2' | 'p3' | 'p4';
	date?: string;
	deadline?: string;
	/** Hora "HH:MM" (24h); sin `date`, el servidor agenda la tarea hoy. Mismo formato que el chip de hora
	 *  de la app (ver `/api/ingest` en el repo principal). Sin sentido sin
	 *  `date`, pero el servidor no lo impone. */
	time?: string;
	recurrence?: IngestRecurrence;
	subtasks?: string[];
}

/** Alcances que acepta `GET /api/tasks`. `upcoming` (2026-07-26) es la ventana
 *  RODANTE de N días CONTANDO hoy — existe porque `week` es la semana de
 *  CALENDARIO y en domingo (o en viernes) apenas tiene nada por delante: son
 *  dos preguntas distintas ("qué queda de esta semana" vs "qué viene"). Ver el
 *  JSDoc de ese endpoint en el repo principal. */
export type TaskScope = 'today' | 'week' | 'upcoming' | 'inbox' | 'someday' | 'overdue' | 'all';

export interface ListTasksInput {
	scope?: TaskScope;
	/** Nº de días de la ventana de `scope: 'upcoming'`, CONTANDO hoy (default 7
	 *  server-side, tope 14). Con cualquier otro scope el servidor responde 400
	 *  a propósito (un parámetro que no hace nada es un bug esperando): se
	 *  reenvía tal cual, sin filtrarlo aquí, para no tener DOS versiones de esa
	 *  regla — la del endpoint es la única. */
	days?: number;
	/** Nombre (case-insensitive) de una lista de "Algún día"; filtra las tareas
	 *  que pertenecen a ella. Sin `scope` explícito, el servidor amplía el
	 *  alcance temporal a "all" (ver `GET /api/tasks` en el repo principal). */
	list?: string;
	/** Nombre (case-insensitive) de una sección (Fase B, listas=proyectos)
	 *  dentro de `list`; combinada con `list`, solo casa una sección de ESA
	 *  lista. Sin `list`, casa la primera sección con ese nombre en cualquiera. */
	section?: string;
	includeDone?: boolean;
	/** Incluye tareas archivadas. El servidor exige el literal
	 *  `includeArchived=true`; omitido conserva el comportamiento histórico. */
	includeArchived?: boolean;
	/** Tope de tareas a traer (la API lo capa a 500); NO expuesto como parámetro
	 *  de la tool `list_tasks`. */
	limit?: number;
	/** Parámetro HTTP `notes=` de `GET /api/tasks` (feature "notas en dos
	 *  fases", 2026-08-25): `'full'` (comportamiento de siempre, notas
	 *  enteras), `'length'` (solo `LumbreTask.notesLength`, sin texto) o
	 *  `'none'` (ni texto ni longitud). Deliberadamente DISTINTO del `notes`
	 *  (`NotesMode`) que recibe la tool `list_tasks` de cara al modelo
	 *  (`auto`/`none`/`preview`/`full`, ver `notes.ts`) — `index.ts` pasa el
	 *  objeto de entrada de la tool tal cual a `listTasks` para el resto de
	 *  campos, y un `input.notes` del modelo NUNCA debe colarse aquí sin
	 *  traducir. Sin indicar, el servidor sirve notas completas (igual que
	 *  antes de esta feature); un servidor VIEJO que no conoce el parámetro lo
	 *  ignora y devuelve las notas enteras igual — ver `listTasks`, que es
	 *  quien detecta esa situación. */
	notesQuery?: 'full' | 'length' | 'none';
}

/** Metadata de un adjunto (sin bytes ni `storageKey`); los bytes se piden aparte con `getAttachment`. */
export interface LumbreAttachment {
	id: string;
	filename: string;
	mime: string;
	size: number;
}

/** Una subtarea (checklist, #17) tal como la devuelve `GET /api/tasks?id=`
 *  dentro de `subtasks` de su tarea padre. El orden del array YA es el orden
 *  de la checklist; sus tags efectivos coinciden con los propios. */
export interface LumbreSubtask {
	id: string;
	content: string;
	done: boolean;
	tags?: string[];
	effectiveTags?: string[];
}

export interface LumbreTask {
	id: string;
	content: string;
	/** Tags propios de la tarea. Opcional para tolerar servidores anteriores. */
	tags?: string[];
	/** Tags propios más los heredados de sección/proyecto/área. */
	effectiveTags?: string[];
	/** Notas/descripción larga de la tarea, o null si no tiene. */
	notes: string | null;
	/** ISO 8601 de la última edición de la NOTA (derivada del HLC de su celda
	 *  CRDT), o `null` si la nota nunca se tocó — verificado en prod 2026-07-25:
	 *  125/125 notas con marca poblada, 0 tareas sin nota con marca. Es lo que
	 *  cierra el hueco de la capa 2 de `notes: 'auto'` (`src/notes.ts`): antes
	 *  se aproximaba con un hash local sin fecha, ahora la marca decide exacta,
	 *  sin ventana, en cuanto hay huella previa que comparar. Puede venir
	 *  ausente/`null` en tareas viejas o si la API cambia — trátalo siempre
	 *  como "desconocido", nunca falles por su ausencia (ver `decideAutoNoteRender`). */
	notesUpdatedAt?: string | null;
	/** Longitud (chars, TRAS `.trim()`) de la nota — SOLO presente cuando la
	 *  petición llevó `notes=length` (`ListTasksInput.notesQuery`/
	 *  `findTasksByIds`, feature "notas en dos fases", 2026-08-25): un número
	 *  si hay nota viva, o `null` con el MISMO gateo que traía `notes` en modo
	 *  `full` (p. ej. nota borrada). En cualquier OTRA respuesta (modo `full`
	 *  de siempre, o un servidor que aún no conoce `notes=`) esta clave está
	 *  AUSENTE del todo — ni siquiera `null` — y esa ausencia (comprobar con
	 *  `'notesLength' in t`, NUNCA `t.notesLength !== undefined`, que no
	 *  distingue "ausente" de "presente pero null") es justo la señal que usa
	 *  `list_tasks` (`index.ts`) para detectar un servidor VIEJO que ignoró el
	 *  parámetro y ya ha devuelto la nota entera igualmente — en ese caso no
	 *  hay que pedirla una segunda vez. */
	notesLength?: number | null;
	done: boolean;
	/** ISO 8601 del archivado, o `null` si sigue visible. La API moderna
	 *  siempre incluye la clave; opcional para tolerar servidores anteriores. */
	archivedAt?: string | null;
	/** ISO 8601 de la cancelación ("no se hizo ni se hará"), o `null` si no
	 *  está cancelada. Una cancelada viaja TAMBIÉN con `done: true` (la app
	 *  reutiliza el flag), así que este campo es lo único que la distingue de
	 *  una hecha. `serializeTask` (`/api/tasks` en el repo principal) lo manda
	 *  siempre desde el 26 jul 2026; hasta el 23 sep 2026 este tipo esperaba
	 *  una clave `cancelled` que la API nunca mandó, y toda cancelada salía
	 *  como hecha (MC4 del audit de paridad). Opcional para tolerar un
	 *  servidor anterior. */
	cancelledAt?: string | null;
	/** Regla de repetición ya parseada, o `null` si la tarea no repite.
	 *  Ausente en un servidor anterior al 26 jul 2026: trátalo como
	 *  «desconocida», no como «sin regla» (ver `mergeRecurrencePatch`). */
	recurrence?: IngestRecurrence | null;
	/** Serie a la que pertenece: `=== id` en la SEMILLA, otro id en una
	 *  ocurrencia, `null` si no es de ninguna serie. */
	seriesId?: string | null;
	priority: 1 | 2 | 3 | null;
	date: string | null;
	/** Hora "HH:MM" (24h) de la tarea, o `null` si no tiene — `GET /api/tasks`
	 *  la serializa como `time` (`src/routes/api/tasks/+server.ts`, junto a
	 *  `deadline`). La API de hoy siempre incluye la clave; opcional para
	 *  tolerar un servidor anterior que aún no la mande. */
	time?: string | null;
	deadline: string | null;
	list: string | null;
	/** Id de la lista de "Algún día" a la que pertenece, o null. */
	somedayListId?: string | null;
	/** Nombre de la sección (Fase B, listas=proyectos) dentro de `list`, o null. */
	section?: string | null;
	/** Id de esa sección, o null. */
	sectionId?: string | null;
	createdAt: string;
	/** Adjuntos vivos de la tarea; leer sus bytes con `getAttachment(id)`. */
	attachments?: LumbreAttachment[];
	/** Subtareas vivas (checklist, #17), SOLO presente cuando esta tarea llegó
	 *  vía `findTaskById`/`GET /api/tasks?id=` y es de PRIMER NIVEL — el
	 *  listado (`listTasks`/`list_tasks`) NUNCA lo trae (mismo criterio que ese
	 *  endpoint: las subtareas no aparecen en el listado). Una subtarea nunca
	 *  trae `subtasks` propio (anidamiento de UN nivel). */
	subtasks?: LumbreSubtask[];
	/** Id de la tarea PADRE si ESTA tarea es una subtarea, o `null` si es de
	 *  primer nivel (el listado SIEMPRE trae `null`, ver `GET /api/tasks`; solo
	 *  el lookup por `id` puede traerlo informado). Es la señal que
	 *  `requireTaskExists`/`allowSubtask` (`index.ts`) usa para decidir, tool
	 *  por tool, si una operación aplica a una subtarea (code-review 🟠: antes
	 *  de esto, ampliar `findTaskById` a subtareas dejaba que CUALQUIER tool de
	 *  mutación aceptara un `subtaskId`, incluidas las de residencia/agenda que
	 *  no tienen sentido ahí). */
	parentId?: string | null;
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

/**
 * Mensaje de un 401 de la API de Lumbre, según `config.authMode` — ÚNICO sitio
 * que decide ese texto (tarea 0a717ae9), reutilizado por `request`,
 * `getAttachment` y `uploadAttachment`. Antes las tres funciones repetían el
 * mismo literal a mano y siempre nombraban `LUMBRE_TOKEN`, aunque el proceso
 * corriera en modo OAuth (`http.ts`, token resuelto de un access token OAuth
 * 2.1 vía `resolveAccessToken`) — ahí ese nombre no significa nada para quien
 * lo lee (nunca configuró ningún `LUMBRE_TOKEN`) ni le dice cómo arreglarlo:
 * el problema no es un env var suyo, es la autorización OAuth con Lumbre.
 */
function unauthorizedApiError(config: LumbreConfig): LumbreApiError {
	if (config.authMode === 'oauth') {
		return new LumbreApiError(
			'La autorización OAuth de Lumbre no es válida o fue revocada. Vuelve a conectar Lumbre desde tu cliente.',
			401
		);
	}
	return new LumbreApiError(
		'Token inválido o no configurado (LUMBRE_TOKEN). Consíguelo en Ajustes → email entrante de Lumbre.',
		401
	);
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
			throw unauthorizedApiError(config);
		}
		if (res.status === 429) {
			throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
		}
		const detail = extractMessage(body) ?? (typeof body === 'string' ? body : JSON.stringify(body));
		throw new LumbreApiError(`Lumbre respondió ${res.status}: ${detail}`, res.status);
	}

	return body;
}

/** `notices` de una respuesta de la app: solo las cadenas, `[]` si no hay o
 *  si la forma no encaja (un servidor anterior no manda la clave). */
function readNotices(body: unknown): string[] {
	const raw = (body as { notices?: unknown }).notices;
	return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : [];
}

/** Lo que devuelve `addTask`: los avisos de la app sobre la tarea creada. */
export interface AddTaskResult {
	/** `notices` de `/api/ingest`: desvíos que la app aplicó al materializar
	 *  (p. ej. la lista pedida no existía y la tarea fue a la Bandeja). */
	notices: string[];
}

/** `POST /api/ingest`: crea una tarea. La app la encola y la materializa en
 *  el servidor en la misma petición; los dispositivos la reciben al
 *  sincronizar. Devuelve los `notices` para que la tool se los cuente al
 *  modelo (MC1 del audit de paridad: antes se tiraban). */
export async function addTask(config: LumbreConfig, input: AddTaskInput): Promise<AddTaskResult> {
	const body = await request(config, '/api/ingest', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	});
	if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
		throw new LumbreApiError('Lumbre no confirmó la ingesta (respuesta inesperada).');
	}
	return { notices: readNotices(body) };
}

/** `GET /api/tasks`: lee las tareas del usuario dueño del token. */
export async function listTasks(config: LumbreConfig, input: ListTasksInput): Promise<LumbreTask[]> {
	const params = new URLSearchParams();
	if (input.scope) params.set('scope', input.scope);
	if (input.days !== undefined) params.set('days', String(input.days));
	if (input.list) params.set('list', input.list);
	if (input.section) params.set('section', input.section);
	if (input.includeDone) params.set('includeDone', 'true');
	if (input.includeArchived) params.set('includeArchived', 'true');
	if (input.limit) params.set('limit', String(input.limit));
	if (input.notesQuery) params.set('notes', input.notesQuery);
	const qs = params.toString();
	const body = await request(config, `/api/tasks${qs ? `?${qs}` : ''}`);
	if (!Array.isArray(body)) {
		throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks.');
	}
	return body as LumbreTask[];
}

/** Cierre de un proyecto (hecho/cancelado, con su marca de tiempo epoch ms);
 *  SIEMPRE `null` en un área (`docs/20-contrato-lista.md` del repo principal).
 *  Mismo shape que `ProjectClosure` de ese repo (`src/lib/types.ts`),
 *  pass-through sin reinterpretar. */
export interface LumbreListClosure {
	v: 1;
	id: string;
	at: number;
	as: 'done' | 'cancelled';
}

/** Resumen de un proyecto o área (`GET /api/tasks?includeLists=1`). */
export interface LumbreListSummary {
	id: string;
	name: string;
	/** Tags propios y efectivos del proyecto/área; opcionales por compatibilidad. */
	tags?: string[];
	effectiveTags?: string[];
	/** Nº de tareas de primer nivel vivas en la lista; 0 es un valor legítimo
	 *  (lista recién creada, o vaciada) — NO significa que la lista no exista. */
	taskCount: number;
	/** `'project'` o `'area'`; opcional por compatibilidad con un servidor
	 *  anterior a este campo (no debería faltar ya, ver `+server.ts` del repo
	 *  principal, que lo manda siempre con `?? 'project'`). */
	kind?: 'project' | 'area';
	/** Id del proyecto o área padre, o `null` si es de primer nivel; opcional
	 *  por compatibilidad, mismo criterio que `kind`. */
	parentListId?: string | null;
	/** Cierre del proyecto, o `null` si sigue abierto; SIEMPRE `null` en un
	 *  área. Opcional por compatibilidad, mismo criterio que `kind`. */
	closure?: LumbreListClosure | null;
	/** `true` si el proyecto está aparcado ("Algún día"); SIEMPRE `false` en
	 *  un área. Opcional por compatibilidad, mismo criterio que `kind`. */
	someday?: boolean;
	/** Fecha programada del proyecto (`YYYY-MM-DD`), o `null`; SIEMPRE `null`
	 *  en un área. Opcional por compatibilidad, mismo criterio que `kind`. */
	date?: string | null;
	/** Nota íntegra del proyecto/área en markdown, o `null` si no tiene.
	 *  AUSENTE del todo (ni siquiera `null`) en un servidor anterior a esta
	 *  feature (tarea 827a7878) — a diferencia de `LumbreTask.notes`, que
	 *  siempre trae texto o `null`, aquí solo puede faltar la CLAVE. */
	notes?: string | null;
	/** Epoch ms de la última edición de la nota (derivado del HLC de su celda
	 *  CRDT, mismo origen que `LumbreTask.notesUpdatedAt` pero en epoch ms en
	 *  vez de ISO — contrato de la tarea 827a7878), o `null` si la nota nunca
	 *  se tocó. Ausente si el servidor no expone la marca para listas; trátalo
	 *  siempre como "desconocido", nunca falles por su ausencia. */
	notesUpdatedAt?: number | null;
}

/** Vínculo de un proyecto o área (`GET /api/list-links?listId=`).
 * `url` se conserva literal: puede ser una URL web o `obsidian://`, que el
 * MCP solo presenta como vínculo; nunca lee ni interpreta su contenido. */
export interface LumbreListLink {
	id: string;
	listId: string;
	kind: string;
	targetKey: string;
	url: string;
	label: string;
	updatedAt: string;
}

/** Destino de nota que acepta `POST /api/list-links`. La API exige también
 * `label` al desvincular, aunque solo usa `url` como identidad del destino. */
export interface ListNoteLinkInput {
	listId: string;
	url: string;
	label: string;
}

export interface LinkListNoteResult {
	ok: true;
	type: 'link';
	listId: string;
	/** La lista estaba en la papelera, pero el vínculo se escribió igualmente. */
	deleted: boolean;
	link: LumbreListLink;
}

export interface UnlinkListNoteResult {
	ok: true;
	type: 'unlink';
	listId: string;
	/** La lista estaba en la papelera al procesar la petición. */
	deleted: boolean;
	/** `false` es éxito idempotente: el vínculo ya no estaba registrado. */
	removed: boolean;
}

/**
 * `GET /api/tasks?includeLists=1`: enumera TODOS los proyectos y áreas
 * vivos del usuario, INCLUIDOS los que no tienen ninguna tarea todavía. Sin
 * esto, un contenedor con 0 tareas es invisible para el MCP — `list_tasks` solo
 * puede "verlo" a través de las tareas que contiene, así que un proyecto
 * recién creado (por la app o por `create_list`) no aparece en ningún
 * sitio hasta que se le añade la primera tarea (bug real, b00303b5).
 */
export async function listLists(config: LumbreConfig): Promise<LumbreListSummary[]> {
	const body = await request(config, '/api/tasks?includeLists=1');
	if (!body || typeof body !== 'object' || !Array.isArray((body as { lists?: unknown }).lists)) {
		throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks?includeLists=1.');
	}
	return (body as { lists: LumbreListSummary[] }).lists;
}

/**
 * `GET /api/list-links?listId=`: lee los vínculos configurados para UN proyecto o área.
 * Un destino sin vínculos devuelve `[]`; no se consulta ni se expone contenido
 * del destino, incluidos los targets con esquema `obsidian://`.
 */
export async function getListLinks(config: LumbreConfig, listId: string): Promise<LumbreListLink[]> {
	const params = new URLSearchParams({ listId });
	const body = await request(config, `/api/list-links?${params.toString()}`);
	if (!body || typeof body !== 'object' || !Array.isArray((body as { links?: unknown }).links)) {
		throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/list-links?listId=.');
	}
	return (body as { links: LumbreListLink[] }).links;
}

function isListLink(value: unknown, listId: string, url: string, label: string): value is LumbreListLink {
	if (!value || typeof value !== 'object') return false;
	const link = value as Partial<LumbreListLink>;
	return (
		typeof link.id === 'string' &&
		link.listId === listId &&
		link.kind === 'obsidian' &&
		link.targetKey === url &&
		link.url === url &&
		link.label === label &&
		typeof link.updatedAt === 'string'
	);
}

/** Escritura síncrona e idempotente de un vínculo de nota de Obsidian. */
export async function linkListNote(config: LumbreConfig, input: ListNoteLinkInput): Promise<LinkListNoteResult> {
	const url = input.url.trim();
	const label = input.label.trim();
	const body = await request(config, '/api/list-links', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			type: 'link',
			listId: input.listId,
			target: { kind: 'obsidian', url, label }
		})
	});
	if (
		!body ||
		typeof body !== 'object' ||
		(body as { ok?: unknown }).ok !== true ||
		(body as { type?: unknown }).type !== 'link' ||
		(body as { listId?: unknown }).listId !== input.listId ||
		typeof (body as { deleted?: unknown }).deleted !== 'boolean' ||
		!isListLink((body as { link?: unknown }).link, input.listId, url, label)
	) {
		throw new LumbreApiError('Lumbre no confirmó el vínculo de lista (respuesta inesperada).');
	}
	return body as LinkListNoteResult;
}

/** Retirada síncrona e idempotente de un vínculo de nota de Obsidian. */
export async function unlinkListNote(
	config: LumbreConfig,
	input: ListNoteLinkInput
): Promise<UnlinkListNoteResult> {
	const url = input.url.trim();
	const label = input.label.trim();
	const body = await request(config, '/api/list-links', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			type: 'unlink',
			listId: input.listId,
			target: { kind: 'obsidian', url, label }
		})
	});
	if (
		!body ||
		typeof body !== 'object' ||
		(body as { ok?: unknown }).ok !== true ||
		(body as { type?: unknown }).type !== 'unlink' ||
		(body as { listId?: unknown }).listId !== input.listId ||
		typeof (body as { deleted?: unknown }).deleted !== 'boolean' ||
		typeof (body as { removed?: unknown }).removed !== 'boolean'
	) {
		throw new LumbreApiError('Lumbre no confirmó la retirada del vínculo de lista (respuesta inesperada).');
	}
	return body as UnlinkListNoteResult;
}

/**
 * Busca UNA tarea por `id` vía `GET /api/tasks?id=` (lookup directo, no
 * listado — ver ese endpoint en el repo principal) y la devuelve, o
 * `undefined` si no existe/no es del usuario del token. A diferencia del
 * viejo enfoque (barrer `scope=all` con `list_tasks` y filtrar aquí), este
 * endpoint busca entre TODAS las tareas vivas del usuario — de primer nivel
 * Y SUBTAREAS —, así que:
 *
 * - No hay tope de cuenta (antes una cuenta con más de 500 tareas vivas de
 *   primer nivel podía dar un falso "no existe" para un id real fuera de esa
 *   ventana; el lookup por `id` no pagina).
 * - Encuentra el id de una SUBTAREA, que `list_tasks`/`scope=all` nunca
 *   exponen — precondición para poder comprobar la existencia de una
 *   subtarea antes de completarla (ver `complete_subtask` en `index.ts`).
 *
 * `opts.includeArchived` reenvía `includeArchived=true`, la única excepción
 * a los filtros que normalmente ignora el lookup por id. Sin indicarlo, las
 * archivadas siguen sin aparecer (comportamiento histórico).
 *
 * La usan tanto `get_task` (para devolver la tarea completa, con sus
 * subtareas si las tiene) como el chequeo de existencia de las tools de
 * mutación (ver `requireTaskExists` en `index.ts`): un `taskId` mal
 * transcrito (bug real, ver la tarea que motiva este fichero) hoy se
 * encolaba igual y se perdía en silencio al drenar.
 */
export async function findTaskById(
	config: LumbreConfig,
	taskId: string,
	opts: { includeArchived?: boolean } = {}
): Promise<LumbreTask | undefined> {
	const params = new URLSearchParams({ id: taskId });
	if (opts.includeArchived) params.set('includeArchived', 'true');
	const body = await request(config, `/api/tasks?${params.toString()}`);
	if (!Array.isArray(body)) {
		throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks?id=.');
	}
	return (body as LumbreTask[])[0];
}

/** Tope de ids por petición que impone `GET /api/tasks?ids=` en el servidor
 *  (ver su JSDoc en el repo principal) — `findTasksByIds` trocea por encima
 *  de esto en vez de mandar un `ids=` que el servidor rechazaría. */
const MAX_IDS_PER_REQUEST = 200;

/**
 * Busca VARIAS tareas de golpe vía `GET /api/tasks?ids=` (feature batch —
 * espejo de `findTaskById`, pero para un LOTE): UNA sola petición (o varias
 * en TROCEADO de `MAX_IDS_PER_REQUEST` si `ids` se pasa de ese tope, ver
 * abajo) → un `Map` por `id`, en vez de una `findTaskById` por cada
 * `taskId`/`subtaskId` a comprobar. Pensado tanto para `mutate_tasks`
 * (`index.ts`, existencia de todo el lote en una sola llamada de red — o
 * pocas, si se trocea) como para la FASE 2 de `list_tasks({notes:'auto'})`
 * (traer el texto íntegro solo de las notas que la fase 1 decidió íntegras,
 * ver `notesQuery`/el bloque de `list_tasks` en `index.ts`). Ids sin
 * coincidencia (no existen, ajenas al token, o repetidos) simplemente no
 * tienen entrada en el `Map` — el llamante lo distingue con `.get(id)` →
 * `undefined`, mismo criterio que `findTaskById` devolviendo `undefined`.
 * `ids: []` no llama a la red (`Map` vacío directo).
 *
 * `notesQuery` (mismo significado que `ListTasksInput.notesQuery`): sin
 * indicar, el servidor sirve notas completas (comportamiento de siempre) —
 * la fase 2 de `list_tasks` lo manda explícito (`'full'`) por claridad, pese
 * a que ya sea el default del servidor. `includeArchived` se usa en esa misma
 * fase cuando el listado inicial incluyó archivadas: sin propagarlo, una nota
 * de una tarea archivada desaparecería entre `notes=length` y `notes=full`.
 */
export async function findTasksByIds(
	config: LumbreConfig,
	ids: string[],
	opts: { notesQuery?: 'full' | 'length' | 'none'; includeArchived?: boolean } = {}
): Promise<Map<string, LumbreTask>> {
	if (ids.length === 0) return new Map();
	const map = new Map<string, LumbreTask>();
	for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
		const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
		const params = new URLSearchParams({ ids: chunk.join(',') });
		if (opts.notesQuery) params.set('notes', opts.notesQuery);
		if (opts.includeArchived) params.set('includeArchived', 'true');
		const body = await request(config, `/api/tasks?${params.toString()}`);
		if (!Array.isArray(body)) {
			throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks?ids=.');
		}
		for (const t of body as LumbreTask[]) map.set(t.id, t);
	}
	return map;
}

/**
 * Error uniforme para un `taskId`/`subtaskId` que no aparece entre las
 * tareas visibles del usuario — ver `assertTaskUsable`.
 *
 * El mensaje dice SOLO lo que este chequeo sabe de verdad: que el id no
 * salió en `GET /api/tasks?id=`. NO afirma que la tarea "no existe" a
 * secas — `findTaskById` (ver su JSDoc) filtra las tareas ARCHIVADAS
 * incluso pidiendo `includeDone=true`, así que un id de una tarea archivada
 * cae exactamente por esta misma rama, y "no existe" sería falso en ese
 * caso. Antes decía justo eso y empujaba a la hipótesis equivocada
 * ("¿se transcribió mal?"): dos sesiones dieron por hecho que unas tareas
 * NUNCA habían existido, cuando estaban archivadas. `includeArchived` ya se
 * puede pedir en `list_tasks`/`get_task`; el mensaje propone ese siguiente
 * paso sin afirmar que el id sea inexistente.
 */
export function taskNotFoundError(taskId: string): Error {
	return new Error(
		`El id ${taskId} no está entre las tareas (ni subtareas) que devuelve el servidor para este ` +
			'usuario. Puede que se transcribiera mal (resuélvelo de nuevo con list_tasks), que sea una ' +
			'subtarea (usa get_task sobre la tarea padre) o que esté ARCHIVADA: reintenta list_tasks/' +
			'get_task con includeArchived:true. No se ha encolado ninguna mutación.'
	);
}

/**
 * Error uniforme para un `listId` que no aparece entre los proyectos/áreas
 * vivos del usuario (`get_list`) — mismo criterio que `taskNotFoundError`:
 * dice SOLO lo que este chequeo sabe (no salió en `GET /api/tasks?includeLists=1`),
 * sin afirmar que "no existe" a secas, y propone el siguiente paso.
 */
export function listNotFoundError(listId: string): Error {
	return new Error(
		`El id ${listId} no está entre los proyectos/áreas que devuelve el servidor para este usuario. ` +
			'Puede que se transcribiera mal (resuélvelo de nuevo con list_lists) o que se haya borrado. ' +
			'No se ha encolado ninguna mutación.'
	);
}

/**
 * Error uniforme cuando `taskId` SÍ existe pero es una subtarea y la tool no
 * aplica ahí — ver `assertTaskUsable`.
 *
 * Solo lo ven ya las ops que siguen CERRADAS a una subtarea, así que el texto
 * nombra el motivo REAL de cada una (residencia) en vez del viejo «es de
 * residencia/agenda/edición»: desde que `op:"update"` acepta un `subtaskId`,
 * decir «edición» era falso y empujaba al modelo a rendirse en un caso que sí
 * funciona. Nombra OPS, no tools (2026-09-19): las nueve tools sueltas de
 * mutación individual ya no existen y citarlas mandaba al modelo a llamar
 * algo que no está en `tools/list`.
 */
export function subtaskNotAllowedError(taskId: string): Error {
	return new Error(
		`El id ${taskId} es de una SUBTAREA y esta operación no aplica ahí: una subtarea no tiene ` +
			'lista ni sección propias — vive en la checklist de su padre (docs/18-que-es-una-tarea.md ' +
			'§2.5, prohibidos en subtarea: `somedayListId`, `sectionId`). Eso deja fuera move_to_list y ' +
			'set_section. Si querías cambiar de lista o de sección lo que la contiene, resuelve el id de ' +
			'la tarea PADRE con list_tasks y opera sobre él. Sobre la SUBTAREA sí valen las ops update ' +
			'(texto, notas, prioridad, hora), reschedule (darle fecha o quitársela con date:null), ' +
			'complete/complete_subtask, cancel y add_subtask de mutate_tasks, y delete de organize. No ' +
			'se ha encolado ninguna mutación.'
	);
}

/**
 * Error uniforme cuando `add_subtask` targetea una tarea que YA es una
 * subtarea (MC2 del audit de paridad, 23 sep 2026): el anidamiento es de UN
 * solo nivel («Naturaleza», docs/18-que-es-una-tarea.md §2.5: «subtarea →
 * padre, nunca subcadena»), una regla DISTINTA de la de residencia que
 * cierra `set_section`/`move_to_list` (por eso no reutiliza
 * `subtaskNotAllowedError`, que hablaría de lista/sección sin venir a
 * cuento). Hasta esa fecha el servidor la descartaba en SILENCIO (`break` en
 * el case `addSubtask` de `inbound-materialize.ts`) y aun así devolvía
 * `applied`; se corta aquí, ANTES de encolar, en vez de fiarse de ese
 * resultado — ver `buildBatchFromOps`.
 */
export function nestedSubtaskNotAllowedError(taskId: string): Error {
	return new Error(
		`El id ${taskId} es de una SUBTAREA: no se le pueden añadir subtareas propias — el anidamiento ` +
			'es de UN solo nivel (docs/18-que-es-una-tarea.md §2.5, «subtarea → padre, nunca subcadena»). ' +
			'Añade la subtarea nueva sobre la tarea PADRE (resuélvela con list_tasks/get_task). No se ha ' +
			'encolado ninguna mutación.'
	);
}

/**
 * Error uniforme cuando `set_section` targetea una tarea que no pertenece a
 * ningún proyecto o área (MC2 del audit de paridad, 23 sep 2026): una
 * sección solo existe DENTRO de una lista, así que asignarla —o quitarla— no
 * tiene destino. Hasta esa fecha el servidor la ignoraba en SILENCIO (`if
 * (!t.somedayListId) break` en el case `setSection` de
 * `inbound-materialize.ts`) y aun así devolvía `applied`; se corta aquí,
 * ANTES de encolar — ver `buildBatchFromOps`.
 */
export function taskWithoutListNotAllowedError(taskId: string): Error {
	return new Error(
		`La tarea ${taskId} no pertenece a ningún proyecto o área, así que no puede tener sección. ` +
			'Muévela primero con move_to_list (organize) y repite set_section. No se ha encolado ninguna ' +
			'mutación.'
	);
}

/**
 * Decide si una tool puede operar sobre `task` (YA resuelto por
 * `findTaskById`, o `undefined` si no existe): lanza `taskNotFoundError` si
 * no existe, o `subtaskNotAllowedError` si es una subtarea (`parentId`
 * informado) y `opts.allowSubtask` es `false` (default). Función PURA — sin
 * red — a propósito: separada de `requireTaskExists` (`index.ts`, el fino
 * wrapper que la conecta con `findTaskById`) para poder testear la matriz de
 * decisión (qué tool acepta/rechaza un `subtaskId`) sin mockear `fetch` — ver
 * `lumbre-client.test.ts`.
 *
 * `allowSubtask` (default `false`, code-review 🟠 — hallazgo tras la 1ª
 * versión de esta feature): ampliar `findTaskById` para que resuelva
 * subtareas (precondición de `complete_subtask`) dejaba, de rebote, que
 * CUALQUIER tool de mutación aceptara un `subtaskId`, incluidas las que
 * corromperían la ley de residencia escribiendo `somedayListId`/`sectionId`
 * en la fila de una subtarea.
 *
 * QUÉ CAMBIÓ (2026-09-04): aquella primera versión cerró las cuatro de golpe
 * («residencia/agenda/edición») apoyándose en que `task-ops.moveTask` no
 * tenía guard de `parentId`. Esa premisa YA NO ES CIERTA y el conjunto de
 * campos lo fija ahora un contrato normativo, no esta matriz:
 * `docs/18-que-es-una-tarea.md` §2.5 «Subtareas [DECIDIDO 2 sep 2026]»
 * PERMITE en una subtarea `content`, `notes`, `priority`, `time`, `date`,
 * `daypart`, `done`, `position`/`dayPosition` y tags, y PROHÍBE
 * `somedayListId`, `sectionId`, `reminders`, `deadline` y `recurrence`. Los
 * cinco campos de `update_task` son exactamente cinco de los permitidos, y
 * el guard de residencia vive HOY en la app (`src/lib/sync/task-ops.ts`:
 * `moveTask` solo adopta en la Bandeja si `src.parentId === undefined`,
 * `moveTaskToList` es no-op sobre una subtarea, `reconcileTaskInvariants`
 * solo repara primer nivel) — no aquí.
 *
 * La política, op por op (`TASK_TARGET_ALLOW_SUBTASK`, más abajo, es la tabla
 * viva; desde el 2026-09-19 no hay tools sueltas de mutación, solo ops de
 * `mutate_tasks`/`organize`, y `add_attachment` es la única tool que sigue
 * llamando a `requireTaskExists` por su cuenta):
 *  - `allowSubtask: true` — `complete`, `cancel`, `delete`,
 *    `complete_subtask`, `add_subtask` (no tocan residencia) y, desde
 *    2026-09-04, `update`: sus cinco campos son accidentales PERMITIDOS
 *    en subtarea (§2.5) y su camino en el servidor está medido como
 *    subtask-safe — `inbound-materialize.ts` case `'update'` solo escribe
 *    celdas (`editTaskContent`/`setTaskNotes`/`setTaskPriority`) y, para
 *    `time` sin día, llama a `moveTask` con `date !== null`, la rama que NO
 *    escribe `somedayListId`. También `reschedule`, SIN condición sobre el
 *    payload desde 2026-09-04 (ver más abajo).
 *    `get_task` ni siquiera pasa por aquí, pero acepta un `subtaskId` igual.
 *  - `allowSubtask: false` (default) — `set_section` y `move_to_list`
 *    (escriben `sectionId`/`somedayListId`, PROHIBIDOS en subtarea por §2.5);
 *    y `add_attachment`, que queda fuera del alcance de §2.5 y conserva su
 *    criterio anterior.
 *
 * `reschedule` estuvo CONDICIONADO al payload (sí con fecha, no con
 * `date: null`) mientras `task-ops.unscheduleTask` de la app no tuvo guard de
 * `parentId` y desagendar una subtarea le escribía `somedayListId` y le pisaba
 * `position`. Esa condición de salida se CUMPLIÓ: el guard entró en la app en
 * `a745235a` (desplegado; `unscheduleTask` abre con
 * `if (t.parentId !== undefined) { unscheduleSubtask(store, t); return; }`, y
 * `unscheduleSubtask` solo limpia fecha y hora). El guard vive en
 * `unscheduleTask` misma, que es la que llama el gemelo headless
 * `inbound-materialize.ts` —el camino que recorre una mutación del MCP—, no
 * solo la fachada cliente; por eso `reschedule` pasó a `true` a secas y se
 * retiraron `rescheduleSubtaskDecision`, `subtaskDecisionFor` y
 * `subtaskUnscheduleNotAllowedError`.
 *
 * Los dos cerrados por §2.5 lo están a propósito y en voz alta: hoy
 * `moveTaskToList` se los tragaría como no-op MUDO, así que este error es lo
 * único que le dice al modelo que no pasó nada.
 */
export function assertTaskUsable(
	task: LumbreTask | undefined,
	taskId: string,
	opts: SubtaskDecision = {}
): asserts task is LumbreTask {
	if (!task) throw taskNotFoundError(taskId);
	if (!opts.allowSubtask && task.parentId) throw subtaskNotAllowedError(taskId);
}

/**
 * Qué puede hacer una tool/op con un `subtaskId`: es lo que `assertTaskUsable`
 * recibe como `opts` y lo que pasa cada `requireTaskExists(...)` de
 * `index.ts`. Un objeto con nombre, y no un booleano suelto, porque
 * `{ allowSubtask: true }` en la llamada dice QUÉ decide ese flag y un `true`
 * pelado no.
 *
 * Tuvo también un `subtaskError` inyectable, que existía solo para el caso
 * condicional de `reschedule` (`date: null`); retirado el 2026-09-04 con él
 * — ver el JSDoc de `assertTaskUsable`. Hoy el rechazo es siempre
 * `subtaskNotAllowedError`.
 */
export interface SubtaskDecision {
	allowSubtask?: boolean;
}

/** Adjunto ya descargado: tipo MIME (de la respuesta) + bytes. */
export interface DownloadedAttachment {
	contentType: string;
	bytes: Buffer;
}

/**
 * `GET /api/attachments/:id`: descarga los bytes de un adjunto propio. Mismo
 * token que el resto (`Authorization: Bearer`); ese endpoint solo sirve el
 * adjunto si pertenece al dueño del token (anti-IDOR server-side, ver el
 * endpoint en el repo principal). No pasa por `request()` porque la respuesta
 * no es JSON.
 */
export async function getAttachment(config: LumbreConfig, id: string): Promise<DownloadedAttachment> {
	const url = `${config.baseUrl.replace(/\/$/, '')}/api/attachments/${id}`;
	let res: Response;
	try {
		res = await fetch(url, { headers: { authorization: `Bearer ${config.token}` } });
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new LumbreApiError(
			`No se pudo conectar con Lumbre en ${config.baseUrl} (${cause}). ¿Es correcto LUMBRE_BASE_URL?`
		);
	}
	if (!res.ok) {
		if (res.status === 401) {
			throw unauthorizedApiError(config);
		}
		if (res.status === 404) {
			throw new LumbreApiError(`Adjunto ${id} no encontrado (o no pertenece al dueño del token).`, 404);
		}
		if (res.status === 429) {
			throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
		}
		throw new LumbreApiError(`Lumbre respondió ${res.status} al pedir el adjunto ${id}.`, res.status);
	}
	return {
		contentType: res.headers.get('content-type') ?? 'application/octet-stream',
		bytes: await readBoundedBody(res, id)
	};
}

/**
 * Lee el cuerpo de la descarga con el tope de `MAX_ATTACHMENT_BYTES` (25 MiB,
 * el mismo límite AUTORITATIVO del servidor al SUBIR, ver `attachments.ts`):
 * si nada puede subir más de 25 MiB, nada legítimo puede bajar más.
 *
 * Hasta ahora era un `res.arrayBuffer()` a pelo, sin tope: el tamaño de lo que
 * se materializa en memoria lo decidía el otro lado de la conexión. Con este
 * conector corriendo en un VPS compartido (`http.ts`), una respuesta enorme
 * —una Lumbre comprometida, un proxy intermedio, un `LUMBRE_BASE_URL` mal
 * puesto apuntando a cualquier otra cosa— se convertía en memoria del proceso.
 *
 * Dos comprobaciones, como en el resto del repo (`readBoundedJson` del
 * backchannel): el `content-length` declarado ANTES de leer nada, y la cuenta
 * real mientras llega, porque esa cabecera puede faltar o mentir. Al pasarse
 * se CANCELA el stream: no se sigue descargando algo que ya se ha descartado.
 */
async function readBoundedBody(res: Response, id: string): Promise<Buffer> {
	const tooLarge = (): LumbreApiError =>
		new LumbreApiError(
			`El adjunto ${id} supera el tope de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB y no se ha descargado.`
		);
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
		await res.body?.cancel().catch(() => undefined);
		throw tooLarge();
	}
	if (!res.body) return Buffer.alloc(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_ATTACHMENT_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw tooLarge();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

/**
 * `DELETE /api/attachments/:id`: retira un adjunto propio. El endpoint aplica
 * el borrado de metadata antes de responder y oculta por igual un id ajeno o
 * inexistente (404 anti-IDOR). Usa `request()` porque la respuesta sí es JSON
 * (`{ ok: true }`); solo especializa el 404 para que el modelo sepa que debe
 * volver a resolver el id desde `get_task`, sin afirmar si existía para otra
 * cuenta.
 */
export async function deleteAttachment(config: LumbreConfig, id: string): Promise<void> {
	let body: unknown;
	try {
		body = await request(config, `/api/attachments/${id}`, { method: 'DELETE' });
	} catch (err) {
		if (err instanceof LumbreApiError && err.status === 404) {
			throw new LumbreApiError(`Adjunto ${id} no encontrado (o no pertenece al dueño del token).`, 404);
		}
		throw err;
	}
	if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
		throw new LumbreApiError('Lumbre no confirmó el borrado del adjunto (respuesta inesperada).');
	}
}

/** Metadata que devuelve `POST /api/attachments` al subir un adjunto —
 *  `createdAt` es epoch ms (a diferencia del resto de fechas del cliente,
 *  siempre ISO 8601: es lo que manda ESE endpoint, ver su JSDoc en el repo
 *  principal). */
export interface UploadedAttachment {
	id: string;
	taskId: string;
	filename: string;
	mime: string;
	size: number;
	storageKey: string;
	createdAt: number;
}

/**
 * Cabecera con el mime REAL del adjunto (`x-lumbre-content-type`) — MISMA
 * constante, mismo nombre, que `ATTACHMENT_CONTENT_TYPE_HEADER` en el repo
 * principal (`src/lib/attachment-upload-parse.ts:43`, leída en
 * `src/routes/api/attachments/+server.ts:177`; desplegado, comprobado contra
 * prod el 2026-08-27: `content-type: application/octet-stream` +
 * `x-lumbre-content-type: image/png` → 200 con `"mime":"image/png"`). Ver el
 * JSDoc de `uploadAttachment` para el porqué de mandar el mime aquí y no en
 * `Content-Type`.
 */
export const ATTACHMENT_CONTENT_TYPE_HEADER = 'x-lumbre-content-type';

/**
 * `POST /api/attachments?taskId=<uuid>`: sube los bytes de un fichero y lo
 * deja adjunto y ENLAZADO a esa tarea — a diferencia de `addTask`/`mutateTask`
 * (encolan, se aplican al sincronizar), este endpoint escribe la metadata al
 * CRDT él mismo antes de responder 200: cuando responde, el adjunto YA está
 * visible, sin esperar a ningún sync (ver `add_attachment` en `index.ts`).
 *
 * No pasa por `request()`: el cuerpo no es JSON (son los bytes crudos del
 * fichero) y la cabecera del nombre necesita ir URL-encodeada, nunca en la
 * query (acabaría en los access-logs). `Content-Type` viaja SIEMPRE fijo a
 * `application/octet-stream`, y el mime real de `input.mime` va aparte, en
 * `ATTACHMENT_CONTENT_TYPE_HEADER` — hasta 2026-08-26 `Content-Type` llevaba
 * el mime real (degradado a mano en `mimeForFilename` para los cuatro que
 * SvelteKit intercepta, ver abajo); desde que el servidor sabe leer
 * `x-lumbre-content-type` (comprobado contra prod, ver el JSDoc de la
 * constante) ya no hace falta esa degradación NI arriesgarse a que un mime
 * futuro que no esté en la lista cuele un 403 mudo: `application/octet-stream`
 * nunca es, por construcción, ninguno de los cuatro Content-Type que
 * `is_form_content_type` (`@sveltejs/kit` 2.66.0, `src/utils/http.js:93`,
 * llamada desde `src/runtime/server/respond.js:83`; el cuarto sale de
 * `src/runtime/form-utils.js:69`) intercepta ANTES de nuestro handler cuando
 * la petición no trae `Origin` (el caso de este MCP, que corre fuera del
 * navegador) — ese sigue siendo el guardarraíl real (ver el test que lo
 * comprueba en `lumbre-client.test.ts`), solo cambia DÓNDE viaja el mime.
 */
export async function uploadAttachment(
	config: LumbreConfig,
	input: { taskId: string; filename: string; mime: string; bytes: Buffer }
): Promise<UploadedAttachment> {
	const params = new URLSearchParams({ taskId: input.taskId });
	const url = `${config.baseUrl.replace(/\/$/, '')}/api/attachments?${params.toString()}`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.token}`,
				'content-type': 'application/octet-stream',
				[ATTACHMENT_CONTENT_TYPE_HEADER]: input.mime,
				'x-lumbre-filename': encodeURIComponent(input.filename)
			},
			// `Buffer<ArrayBufferLike>` vs el `BodyInit` de los tipos DOM de fetch:
			// Buffer ES un Uint8Array en runtime (Node lo implementa así), el cast
			// es solo para el checker de tipos.
			body: input.bytes as unknown as BodyInit
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
			throw unauthorizedApiError(config);
		}
		if (res.status === 404) {
			throw new LumbreApiError(extractMessage(body) ?? 'La tarea no existe, está borrada o archivada.', 404);
		}
		if (res.status === 413) {
			// DOS causas distintas (fichero > 25 MiB, o cuota agregada de la cuenta
			// agotada) — el servidor ya las distingue en su mensaje, así que se
			// propaga TAL CUAL en vez de generalizar a "demasiado grande".
			throw new LumbreApiError(
				extractMessage(body) ?? 'Lumbre rechazó el adjunto (413): demasiado grande, o cuota agotada.',
				413
			);
		}
		if (res.status === 429) {
			throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
		}
		const detail = extractMessage(body) ?? (typeof body === 'string' ? body : JSON.stringify(body));
		throw new LumbreApiError(`Lumbre respondió ${res.status} al subir el adjunto: ${detail}`, res.status);
	}

	if (!body || typeof body !== 'object' || typeof (body as { id?: unknown }).id !== 'string') {
		throw new LumbreApiError('Lumbre no confirmó la subida del adjunto (respuesta inesperada).');
	}
	return body as UploadedAttachment;
}

/**
 * `POST /api/sync/flush`: fuerza el flush del sync ANTES de leer (bug:
 * ventana de debounce del persister — ver ese endpoint en el repo
 * principal). Sin cuerpo. Útil justo antes de un `listTasks` cuando importa
 * ver el estado más reciente posible; NO recupera cambios de un cliente que
 * esté offline y nunca los haya mandado por WS (límite server-side).
 */
export async function refreshSync(config: LumbreConfig): Promise<void> {
	const body = await request(config, '/api/sync/flush', { method: 'POST' });
	if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
		throw new LumbreApiError('Lumbre no confirmó el flush del sync (respuesta inesperada).');
	}
}

// ── Fase 2: mutar una tarea existente (ver PHASE2.md) ──────────────────────

export type MutationKind =
	| 'complete'
	| 'update'
	| 'reschedule'
	| 'delete'
	| 'setSection'
	| 'moveToList'
	| 'cancel'
	| 'restore'
	| 'addSubtask'
	| 'removeSection'
	| 'createList'
	| 'nestList'
	| 'renameList'
	| 'removeList'
	| 'setListNotes'
	| 'createBrlEntry'
	| 'updateBrlEntry'
	| 'removeBrlEntry';

export interface CompleteMutationPayload {
	done: boolean;
}
export interface UpdateMutationPayload {
	content?: string;
	notes?: string;
	/** Reemplazo completo de tags propios. `[]` los quita; ausente no los toca. */
	tags?: string[];
	/** Nivel `1|2|3` (p1–p3), o `null` para quitar la prioridad (p4/ninguna).
	 *  El tool `update_task` traduce el `'p1'..'p4'` de cara al modelo a este
	 *  nivel antes de llamar aquí (ver `index.ts`). */
	priority?: 1 | 2 | 3 | null;
	/** Hora "HH:MM" (24h); si no hay día, se agenda hoy. `null` la quita. */
	time?: string | null;
	/** Regla ENTERA que sustituye a la actual (`setTaskRecurrence` de la app
	 *  reemplaza, no fusiona: la fusión con la regla vigente la hace
	 *  `mergeRecurrencePatch` antes de llegar aquí), o `null` para apagarla. */
	recurrence?: IngestRecurrence | null;
}
export interface RescheduleMutationPayload {
	/** `YYYY-MM-DD`, o `null` para mandar la tarea a "Algún día"/Bandeja. */
	date: string | null;
}
export type DeleteMutationPayload = Record<string, never>;
/** Quita el tombstone de la tarea `MutateTaskInput.taskId` (la saca de la
 *  Papelera). Sin campos: `restore` del servidor valida el payload como `{}`. */
export type RestoreMutationPayload = Record<string, never>;
/** `section: "<nombre>"` mueve la tarea a esa sección (se crea si no existe)
 *  dentro de SU PROPIA lista/proyecto (resuelta client-side, no viaja aquí);
 *  `section: null` la saca de su sección. Espejo, para tareas existentes, del
 *  `section` que ya admite `addTask`/`/api/ingest` al crear una tarea. No
 *  aplica (se ignora en silencio) si la tarea no pertenece a ninguna lista. */
export interface SetSectionMutationPayload {
	section: string | null;
}
/** Mueve una tarea existente a otra lista de "Algún día" (lote 2 — identidad
 *  de listas): por `listId` ESTABLE (preferente, inmune a renames) o por
 *  `list` (nombre, se crea si no existe — mismo criterio que `list` en
 *  `add_task`/`/api/ingest`); `listId: null` explícito la desvincula de su
 *  lista actual. Manda solo uno de los dos campos (el tool `move_to_list`
 *  decide cuál según lo que reciba). */
export interface MoveToListMutationPayload {
	listId?: string | null;
	list?: string;
}
/** `cancelled: true` (default, ver `cancel_task` en `index.ts`) cancela la
 *  tarea; `false` la restaura (uncancel). Espejo de `CompleteMutationPayload`,
 *  pero para la marca `cancelledAt` (mutuamente excluyente con `completedAt`
 *  — la invariante la aplica la fachada del cliente de Lumbre al drenar, no
 *  este payload, que solo viaja tal cual hasta `/api/mutations`). */
export interface CancelMutationPayload {
	cancelled: boolean;
}
/** Subtareas a añadir a una tarea EXISTENTE (espejo, para tareas ya creadas,
 *  del `subtasks` que ya admite `addTask`/`/api/ingest` al crear). El
 *  servidor sanea cada texto (recorte a 500 caracteres, tope de 50 elementos —
 *  mismo criterio que `add_task.subtasks`). */
export interface AddSubtaskMutationPayload {
	subtasks: string[];
}
/** Borra (tombstone) una sección de lista — el ÚNICO `kind` cuyo objetivo NO
 *  es una tarea: `MutateTaskInput.taskId` transporta el `sectionId` (repetido
 *  aquí en el payload por forma; ver `remove_section` en `index.ts`). Sus
 *  tareas NUNCA se borran, solo pierden `sectionId` (quedan sueltas dentro de
 *  la misma lista). Espejo de `RemoveSectionPayload`
 *  (`$lib/server/repos/mutations.ts` en el repo principal). */
export interface RemoveSectionMutationPayload {
	sectionId: string;
}
/** Crea una lista de "Algún día" nueva (paridad UI↔MCP): `name` obligatorio,
 *  `color`/`icon` opcionales. El id REAL de la lista nueva viaja en
 *  `MutateTaskInput.taskId` (lo genera el llamante, ver `create_list` en
 *  `index.ts`), no aquí — mismo criterio que `removeSection` con
 *  `sectionId`, pero para una CREACIÓN en vez de un target existente. Espejo
 *  de `CreateListPayload` (`$lib/server/repos/mutations.ts` en el repo
 *  principal). */
export interface CreateListMutationPayload {
	name: string;
	color?: string | null;
	icon?: string | null;
}
/** Fija (`parentId: uuid`) o quita (`parentId: null`) el padre de la lista
 *  `MutateTaskInput.taskId` — anida/desanida. Espejo de `NestListPayload`. */
export interface NestListMutationPayload {
	parentId: string | null;
}
/** Renombra la lista `MutateTaskInput.taskId`. Espejo de `RenameListPayload`. */
export interface RenameListMutationPayload {
	name: string;
}
/** Borra la lista `MutateTaskInput.taskId`. Sin campos — espejo de
 *  `RemoveListPayload`. */
export type RemoveListMutationPayload = Record<string, never>;
/** Contrato de `setListNotes` del servidor: reemplaza la nota de una
 * lista de "Algún día". `null` o una cadena vacía indican borrado; `revive:
 * true` restaura una nota borrada previamente. */
export interface SetListNotesMutationPayload {
	notes: string | null;
	revive?: boolean;
}
/** Crea una entrada de registro (BRL, add-on experimental): `date` el día al
 *  que pertenece y `entry` su texto —`- …` nota, `= …` pensamiento; sin
 *  marcador es una nota—. El id de la entrada nueva viaja en
 *  `MutateTaskInput.taskId` (lo genera el llamante, ver `add_brl_entry` en
 *  `index.ts`), no aquí — MISMO criterio que `createList`. `time` (`HH:MM`,
 *  24h) es OPCIONAL: para volcar apuntes tomados en papel a la hora que de
 *  verdad marcaban. Sin ella, el servidor la sella al encolar (hora del reloj
 *  si es el día en curso del usuario, sin hora si no). Espejo de
 *  `CreateBrlEntryPayload` (`$lib/server/repos/mutations.ts` en el repo
 *  principal). */
export interface CreateBrlEntryMutationPayload {
	date: string;
	entry: string;
	time?: string;
}
/** Reemplaza el texto de una entrada de registro existente. El símbolo forma
 *  parte del texto: mandar `= …` sobre una nota la convierte en pensamiento. */
export interface UpdateBrlEntryMutationPayload {
	entry: string;
}
/** Borra la entrada de registro `MutateTaskInput.taskId`. Sin campos. */
export type RemoveBrlEntryMutationPayload = Record<string, never>;

export interface MutateTaskInput {
	taskId: string;
	kind: MutationKind;
	payload:
		| CompleteMutationPayload
		| UpdateMutationPayload
		| RescheduleMutationPayload
		| DeleteMutationPayload
		| RestoreMutationPayload
		| SetSectionMutationPayload
		| MoveToListMutationPayload
		| CancelMutationPayload
		| AddSubtaskMutationPayload
		| RemoveSectionMutationPayload
		| CreateListMutationPayload
		| NestListMutationPayload
		| RenameListMutationPayload
		| RemoveListMutationPayload
		| SetListNotesMutationPayload
		| CreateBrlEntryMutationPayload
		| UpdateBrlEntryMutationPayload
		| RemoveBrlEntryMutationPayload;
}

/**
 * `outcome` de `POST /api/mutations` (contrato del repo principal, ver el JSDoc
 * de esa ruta): `applied` cambió algo, `noop` se aplicó sin cambiar nada,
 * `not-found` el objetivo no existe en el store del usuario, `quarantined`
 * quedó RETENIDA por el cortacircuitos de borrado masivo (pendiente de
 * revisión en `/admin`, DR-F1 M3) y `queued` quedó aceptada pero sin
 * materializar por otro motivo (un fallo de ese ítem en el drenaje).
 *
 * `quarantined` es un valor NUEVO (commit `4e86db536`, 24 sep 2026): hasta
 * entonces `/api/mutations` la disfrazaba de `queued` y quien pedía borrar no
 * se enteraba de que su lote estaba retenido por seguridad, no simplemente
 * pendiente de un drenaje. `POST /api/batch` ya distinguía los dos casos en
 * su `materialization` (ver `DrainItemStatus`); esto alinea `/api/mutations`
 * (la vía de `mutateTask`, usada hoy por `mutate_brl`).
 */
export type MutationOutcome = 'applied' | 'noop' | 'not-found' | 'quarantined' | 'queued';

const MUTATION_OUTCOMES: readonly string[] = ['applied', 'noop', 'not-found', 'quarantined', 'queued'];

/** Lo que devuelve `mutateTask`. */
export interface MutateTaskResult {
	/** `undefined` solo si el servidor es anterior al campo (3 sep 2026) o
	 *  manda un valor que este cliente no conoce: la tool lo informa como
	 *  «encolada sin confirmar», nunca como aplicada. */
	outcome?: MutationOutcome;
	notices: string[];
}

/**
 * `POST /api/mutations`: encola UNA mutación y la app la drena en el servidor
 * en la misma petición. Devuelve el `outcome` real y los `notices` (MC1 del
 * audit de paridad: hasta el 23 sep 2026 se miraba solo `ok`, que significa
 * «validada y encolada», y un `not-found` salía como éxito).
 */
export async function mutateTask(config: LumbreConfig, input: MutateTaskInput): Promise<MutateTaskResult> {
	const body = await request(config, '/api/mutations', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	});
	if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
		throw new LumbreApiError('Lumbre no confirmó la mutación (respuesta inesperada).');
	}
	const outcome = (body as { outcome?: unknown }).outcome;
	return {
		...(typeof outcome === 'string' && MUTATION_OUTCOMES.includes(outcome)
			? { outcome: outcome as MutationOutcome }
			: {}),
		notices: readNotices(body)
	};
}

// ── BRL (add-on experimental): registro del día ────────────────────────────

/** Una entrada del registro tal y como la devuelve
 *  `GET /api/brl/:date?format=json`. `time` es `''` cuando la entrada nació sin
 *  hora (se captura para un día que no es hoy) — se pinta `--:--`. */
export interface LumbreBrlEntry {
	id: string;
	time: string;
	/** Texto CANÓNICO, con su marcador: `- …` nota, `= …` pensamiento. */
	entry: string;
}

/**
 * `GET /api/brl/:date?format=json`: entradas del registro de un día CON SU ID.
 *
 * Es la única forma de resolver el id que necesitan `update_brl_entry`/
 * `delete_brl_entry`: la representación por defecto de ese endpoint es la nota
 * completa en Markdown, que deliberadamente NO lleva ids (es la nota que lee el
 * usuario, no un formato de máquina). 403 si el add-on BRL está apagado en la
 * cuenta.
 */
export async function listBrlEntries(
	config: LumbreConfig,
	date: string
): Promise<LumbreBrlEntry[]> {
	const body = await request(config, `/api/brl/${date}?format=json`);
	if (!body || typeof body !== 'object' || !Array.isArray((body as { entries?: unknown }).entries)) {
		throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/brl/:date.');
	}
	return (body as { entries: LumbreBrlEntry[] }).entries;
}

/** Traduce `'p1'..'p4'` (de cara al modelo) al nivel numérico que espera
 *  `/api/mutations`/`/api/batch` para `kind: 'update'`: `p4` = quitar la
 *  prioridad (`null`). Vive aquí (no en `index.ts`) porque `translateOp`
 *  (más abajo) también la necesita, y `lumbre-client.ts` no depende de
 *  `index.ts` (evita el ciclo). */
export function priorityToLevel(p: 'p1' | 'p2' | 'p3' | 'p4'): 1 | 2 | 3 | null {
	return p === 'p4' ? null : (Number(p[1]) as 1 | 2 | 3);
}

// ── Feature batch (`plan-batch.md`): N operaciones en UNA petición ─────────

/** Una op del `POST /api/batch` del servidor — espejo EXACTO de lo que acepta
 *  ese endpoint (ver su JSDoc en `src/routes/api/batch/+server.ts` del repo
 *  principal): `ingest` (crear, mismo shape que `AddTaskInput`) o `mutate`
 *  (mismo shape que `MutateTaskInput`). `runBatch` manda un array de estas. */
export type BatchOp =
	| { type: 'ingest'; task: AddTaskInput }
	| { type: 'mutate'; taskId: string; kind: MutationKind; payload: MutateTaskInput['payload'] };

/** Una entrada del informe que devuelve `POST /api/batch` — `index` es la
 *  posición DENTRO del array de `BatchOp` mandado (no del `ops` original de
 *  `mutate_tasks`: ver `originalIndexes` en `buildBatchFromOps`, que hace esa
 *  traducción). `id` es el `clientTaskId` (ingest) o el `taskId` (mutate). */
export interface BatchResultItem {
	index: number;
	type: 'ingest' | 'mutate' | 'unknown';
	/** «Validada y encolada», nada más: que se APLICÓ lo dice `materialization`. */
	ok: boolean;
	error?: string;
	id?: string;
	/** Qué pasó al drenarla en el servidor, solo en las `ok` (ver
	 *  `DrainItemStatus`). Ausente en un servidor anterior al campo. */
	materialization?: DrainItemStatus;
}

/**
 * Resultado del drenaje de una op de `/api/batch` (`DrainItemStatus` de
 * `$lib/server/sync/drain-report.ts` en el repo principal): `applied` cambió
 * algo, `noop` se aplicó sin cambiar nada, `failed` falló al aplicarse y la
 * fila queda reabierta para un drenaje posterior, `quarantined` la retuvo el
 * cortacircuitos de borrado masivo para revisión.
 */
export type DrainItemStatus = 'applied' | 'noop' | 'failed' | 'quarantined';

/** Respuesta completa de `POST /api/batch`. */
export interface BatchResponse {
	results: BatchResultItem[];
	/** Avisos de la app para TODO el lote (un solo drenaje, ya deduplicados). */
	notices: string[];
}

/**
 * `POST /api/batch`: encola TODAS las `ops` de golpe (el servidor las valida
 * y encola una por una, éxito PARCIAL — una op inválida no tumba las demás,
 * ver el JSDoc del endpoint) y drena UNA sola vez. Espejo de `addTask`/
 * `mutateTask`, pero para un LOTE entero en vez de una operación suelta — es
 * la vía PREFERENTE para `mutate_tasks` (`index.ts`) cuando hay varias
 * operaciones seguidas: 1 petición + 1 drenaje en vez de N.
 *
 * Devuelve también los `notices` (MC1 del audit de paridad, 23 sep 2026:
 * hasta entonces se devolvía solo `results` y los avisos se perdían).
 */
export async function runBatch(config: LumbreConfig, ops: BatchOp[]): Promise<BatchResponse> {
	const body = await request(config, '/api/batch', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ops })
	});
	if (
		!body ||
		typeof body !== 'object' ||
		(body as { ok?: unknown }).ok !== true ||
		!Array.isArray((body as { results?: unknown }).results)
	) {
		throw new LumbreApiError('Lumbre no confirmó el batch (respuesta inesperada).');
	}
	return { results: (body as { results: BatchResultItem[] }).results, notices: readNotices(body) };
}

/**
 * Una operación de las tools de lote `mutate_tasks`/`organize`
 * (`tools/batch.ts`): discriminada por `op`, con las 16 variantes de
 * siempre — el reparto en dos tools (2026-09-19) no cambió ninguna forma, solo
 * quién las acepta (`TASK_OP_TOOL` en `tools/shared.ts`), más `restore`
 * (2026-09-24, sacar de la Papelera). Separado en un tipo
 * TS plano (sin
 * zod) para poder testear `buildBatchFromOps` sin depender del SDK de MCP —
 * los zod `discriminatedUnion` de `tools/batch.ts` producen valores
 * estructuralmente iguales a este tipo.
 */
export type MutateTasksOp =
	| ({ op: 'add_task' } & AddTaskInput)
	| { op: 'complete'; taskId: string; done?: boolean }
	| { op: 'cancel'; taskId: string; cancelled?: boolean }
	/** Saca de la Papelera una tarea borrada (quita su tombstone). Su objetivo
	 *  NO es una tarea viva, así que no entra en la comprobación de existencia
	 *  (ver `TASK_TARGET_ALLOW_SUBTASK`): decide el servidor, `applied` o `noop`
	 *  con el aviso `restore-purged` si el GC ya purgó la fila. */
	| { op: 'restore'; taskId: string }
	| {
			op: 'update';
			taskId: string;
			content?: string;
			notes?: string;
			tags?: string[];
			priority?: 'p1' | 'p2' | 'p3' | 'p4';
			time?: string | null;
			/** `null` apaga la regla, también en una semilla ARCHIVADA (la app lo
			 *  resuelve antes de su guard de tarea viva). Un objeto es un cambio
			 *  PARCIAL: se fusiona con la regla actual (`mergeRecurrencePatch`). */
			recurrence?: RecurrencePatch | null;
	  }
	| { op: 'reschedule'; taskId: string; date: string | null }
	| { op: 'delete'; taskId: string }
	| { op: 'set_section'; taskId: string; section: string | null }
	| { op: 'move_to_list'; taskId: string; listId?: string | null; list?: string }
	| { op: 'add_subtask'; taskId: string; subtasks: string[] }
	| { op: 'complete_subtask'; subtaskId: string; done?: boolean }
	| { op: 'remove_section'; sectionId: string }
	| {
			op: 'create_list';
			name: string;
			color?: string | null;
			icon?: string | null;
			/** Id (uuid) PRE-GENERADO por el llamante, opcional (code-review 🟠 #3b
			 *  — encadenado intra-lote): si viene, `translateOp` lo usa TAL CUAL
			 *  en vez de generar uno con `randomUUID()`, así el modelo puede
			 *  targetear ESA MISMA lista desde otra op del MISMO `mutate_tasks`
			 *  (p. ej. `move_to_list`/`nest_list` con ese `listId`, sin depender
			 *  de una llamada previa para conocerlo). Ausente → se genera como
			 *  hasta ahora (mismo criterio que la tool individual `create_list`).
			 *  Desde el fix del incidente 071553 (lote con `create_list` + N
			 *  `add_task` con ese `listId`, ver `planBatchPhases` más abajo), esto
			 *  TAMBIÉN habilita encadenar con un `add_task` del mismo lote: el
			 *  servidor materializa TODAS las ingestas antes que TODAS las
			 *  mutaciones (`src/routes/api/batch/+server.ts` en el repo principal),
			 *  así que un `add_task` con este `listId` en el MISMO array llegaría
			 *  con la lista aún inexistente si viajaran juntos en una sola petición;
			 *  el cliente lo detecta y parte la llamada en dos (mutaciones primero,
			 *  altas después) — transparente para quien escribe `ops`. */
			listId?: string;
	  }
	| { op: 'nest_list'; listId: string; parentId: string | null }
	| { op: 'rename_list'; listId: string; name: string }
	| { op: 'remove_list'; listId: string }
	| { op: 'set_list_notes'; listId: string; notes: string | null; revive?: boolean };

/**
 * `allowSubtask` por `op`, SOLO para las 9 variantes cuyo target es una
 * TAREA (`taskId`/`subtaskId`) — mismo criterio, MISMOS valores, que la
 * matriz que aplica `requireTaskExists` (ver el JSDoc de
 * `assertTaskUsable` para el porqué completo). Las ops de PROYECTO/ÁREA/SECCIÓN
 * (`remove_section`/`create_list`/`nest_list`/`rename_list`/`remove_list`/
 * `set_list_notes`) y
 * `add_task` NO están aquí: no targetean una tarea, así que no comprueban
 * existencia. La PRESENCIA de una clave es la señal de "esta op
 * necesita comprobación de existencia" (ver `collectExistenceCheckIds`/
 * `buildBatchFromOps`).
 *
 * Quién decide cada valor: el contrato `docs/18-que-es-una-tarea.md` §2.5
 * («Subtareas [DECIDIDO 2 sep 2026]»), no esta tabla — una op vale sobre una
 * subtarea si los campos que escribe están entre los ACCIDENTALES PERMITIDOS
 * ahí. `update` pasó a `true` el 2026-09-04 porque sus cinco campos
 * (`content`/`notes`/`tags`/`priority`/`time`) son cinco de los permitidos, y
 * `reschedule` ese mismo día (`date` también es de los permitidos) en cuanto
 * la app cerró su único agujero, el desagendar sin guard de `parentId` —
 * `task-ops.unscheduleTask`, arreglado en `a745235a`, ver `assertTaskUsable`.
 * `set_section` y `move_to_list` siguen en `false` porque escriben
 * `sectionId`/`somedayListId`, PROHIBIDOS. El porqué completo, con el camino
 * de servidor medido de cada una, en el JSDoc de `assertTaskUsable`.
 *
 * `restore` targetea una tarea y aun así NO está aquí, a propósito: su
 * objetivo es una tarea BORRADA, que `findTasksByIds` nunca devuelve, así que
 * la comprobación de existencia la rechazaría siempre. Viaja sin comprobar y
 * el servidor decide (`applied`, o `noop` + aviso `restore-purged`).
 *
 * La tabla es la ÚNICA fuente de la decisión: la leen `buildBatchFromOps`
 * (para el `allowSubtask` que pasa a `assertTaskUsable`) y
 * `collectExistenceCheckIds` (solo por la PRESENCIA de la clave: qué ops
 * necesitan comprobación de existencia). Ninguna op depende ya del PAYLOAD;
 * si alguna volviera a depender, no se refina aquí a mano en cada consumidor
 * —eso es justo lo que abre un agujero por una superficie y no por la otra—
 * sino en una función compartida por las dos, como fue
 * `rescheduleSubtaskDecision` hasta el 2026-09-04.
 */
const TASK_TARGET_ALLOW_SUBTASK: Partial<Record<MutateTasksOp['op'], boolean>> = {
	complete: true,
	cancel: true,
	delete: true,
	add_subtask: true,
	complete_subtask: true,
	update: true,
	reschedule: true,
	set_section: false,
	move_to_list: false
};

/** `taskId`/`subtaskId` de una op que targetea una tarea, o `undefined` si es
 *  de lista/sección/creación (ver `TASK_TARGET_ALLOW_SUBTASK`). */
function targetIdOf(op: MutateTasksOp): string | undefined {
	if ('taskId' in op) return op.taskId;
	if ('subtaskId' in op) return op.subtaskId;
	return undefined;
}

/**
 * Ids que `mutate_tasks` debe resolver con `findTasksByIds` ANTES de mandar
 * el lote — deduplicados (varias ops pueden targetear la misma tarea). Pura,
 * sin red: separada de la llamada real para poder testearla sola.
 */
export function collectExistenceCheckIds(ops: MutateTasksOp[]): string[] {
	const ids = new Set<string>();
	for (const op of ops) {
		if (TASK_TARGET_ALLOW_SUBTASK[op.op] === undefined) continue;
		const id = targetIdOf(op);
		if (id !== undefined) ids.add(id);
	}
	return [...ids];
}

/** Validación local (sin red) de una op, previa a la comprobación de
 *  existencia — mismos guards que hacían `update_task`/`move_to_list`
 *  ANTES de llamar a `requireTaskExists` en `index.ts` (ver esas tools):
 *  `update` necesita al menos un campo a cambiar; `move_to_list` necesita
 *  `listId` o `list`. `null` si la op pasa (nada que reportar aquí). */
function localValidationError(op: MutateTasksOp): string | null {
	if (op.op === 'update') {
		if (
			op.content === undefined &&
			op.notes === undefined &&
			op.tags === undefined &&
			op.priority === undefined &&
			op.time === undefined &&
			op.recurrence === undefined
		) {
			return 'update: indica al menos un campo a cambiar (content, notes, tags, priority, time o recurrence).';
		}
	}
	if (op.op === 'move_to_list' && op.listId === undefined && op.list === undefined) {
		return 'move_to_list: indica `listId` o `list` (la lista destino).';
	}
	return null;
}

/** `MutateTasksOp` → `BatchOp` — MISMA traducción, campo a campo, que
 *  construían las tools individuales para su `mutateTask`/`addTask` antes de
 *  retirarse (2026-09-19): cada rama de este `switch` es el equivalente de
 *  una de ellas. `create_list` usa el `listId` PRE-GENERADO
 *  por el llamante si vino (encadenado intra-lote), o genera uno con
 *  `randomUUID()` si no — ver el JSDoc de `MutateTasksOp['create_list']`. */
function translateOp(op: MutateTasksOp): BatchOp {
	switch (op.op) {
		case 'add_task': {
			const { op: _discard, ...task } = op;
			return { type: 'ingest', task };
		}
		case 'complete':
			return {
				type: 'mutate',
				taskId: op.taskId,
				kind: 'complete',
				payload: { done: op.done ?? true }
			};
		case 'cancel':
			return {
				type: 'mutate',
				taskId: op.taskId,
				kind: 'cancel',
				payload: { cancelled: op.cancelled ?? true }
			};
		case 'restore':
			return { type: 'mutate', taskId: op.taskId, kind: 'restore', payload: {} };
		case 'update':
			return {
				type: 'mutate',
				taskId: op.taskId,
				kind: 'update',
				payload: {
					...(op.content !== undefined ? { content: op.content } : {}),
					...(op.notes !== undefined ? { notes: op.notes } : {}),
					...(op.tags !== undefined ? { tags: op.tags } : {}),
					...(op.priority !== undefined ? { priority: priorityToLevel(op.priority) } : {}),
					...(op.time !== undefined ? { time: op.time } : {}),
					// Ya fusionada con la regla vigente en `buildBatchFromOps`
					// (`mergeRecurrencePatch`), así que aquí es una regla entera o `null`.
					...(op.recurrence !== undefined ? { recurrence: op.recurrence as IngestRecurrence | null } : {})
				}
			};
		case 'reschedule':
			return { type: 'mutate', taskId: op.taskId, kind: 'reschedule', payload: { date: op.date } };
		case 'delete':
			return { type: 'mutate', taskId: op.taskId, kind: 'delete', payload: {} };
		case 'set_section':
			return {
				type: 'mutate',
				taskId: op.taskId,
				kind: 'setSection',
				payload: { section: op.section }
			};
		case 'move_to_list':
			return {
				type: 'mutate',
				taskId: op.taskId,
				kind: 'moveToList',
				payload: op.listId !== undefined ? { listId: op.listId } : { list: op.list! }
			};
		case 'add_subtask':
			return {
				type: 'mutate',
				taskId: op.taskId,
				kind: 'addSubtask',
				payload: { subtasks: op.subtasks }
			};
		case 'complete_subtask':
			return {
				type: 'mutate',
				taskId: op.subtaskId,
				kind: 'complete',
				payload: { done: op.done ?? true }
			};
		case 'remove_section':
			return {
				type: 'mutate',
				taskId: op.sectionId,
				kind: 'removeSection',
				payload: { sectionId: op.sectionId }
			};
		case 'create_list':
			// `listId` PRE-GENERADO por el llamante (encadenado intra-lote, ver el
			// JSDoc de `MutateTasksOp['create_list']`) si vino; si no, uno nuevo —
			// MISMO criterio que la tool individual `create_list`.
			return {
				type: 'mutate',
				taskId: op.listId ?? randomUUID(),
				kind: 'createList',
				payload: {
					name: op.name,
					...(op.color !== undefined ? { color: op.color } : {}),
					...(op.icon !== undefined ? { icon: op.icon } : {})
				}
			};
		case 'nest_list':
			return {
				type: 'mutate',
				taskId: op.listId,
				kind: 'nestList',
				payload: { parentId: op.parentId }
			};
		case 'rename_list':
			return {
				type: 'mutate',
				taskId: op.listId,
				kind: 'renameList',
				payload: { name: op.name }
			};
		case 'remove_list':
			return { type: 'mutate', taskId: op.listId, kind: 'removeList', payload: {} };
		case 'set_list_notes':
			return {
				type: 'mutate',
				taskId: op.listId,
				kind: 'setListNotes',
				payload: {
					notes: op.notes,
					...(op.revive !== undefined ? { revive: op.revive } : {})
				}
			};
	}
}

/** Resultado de `buildBatchFromOps` — ver su JSDoc. */
export interface BuildBatchResult {
	/** Ops YA traducidas a `BatchOp`, listas para `runBatch`, en el MISMO
	 *  orden en que se mandan (índice de este array = índice que devolverá
	 *  `results` del servidor). */
	batchOps: BatchOp[];
	/** `originalIndexes[i]` = índice en el `ops` ORIGINAL (el que pasó el
	 *  modelo) del elemento `batchOps[i]` — la traducción entre el índice que
	 *  ve el servidor y el que tiene sentido reportar de vuelta al modelo. */
	originalIndexes: number[];
	/** Ops descartadas ANTES de mandar el batch (validación local o
	 *  existencia), con su índice en el `ops` ORIGINAL y el motivo — NUNCA
	 *  viajan en `batchOps` (no gastan cupo de rate-limit ni round-trip). */
	skipped: { index: number; error: string }[];
}

/**
 * Fusiona el cambio PARCIAL de regla que pide el modelo con la regla VIGENTE
 * de la tarea y devuelve la regla ENTERA que hay que mandar (la app la
 * sustituye completa: `setTaskRecurrence` no fusiona). Pura, sin red.
 *
 * Por qué existe (MC3 del audit de paridad, 23 sep 2026): mandar solo lo que
 * el modelo cambió borraba el resto, y sin `streak` la app desengancha el
 * hábito. Ahora un campo no enviado se conserva; se quita solo si el parche lo
 * pide de forma explícita (`null` en `byWeekday`/`until`/`count`,
 * `streak: false`, `mode: 'calendar'`).
 *
 * `current` distingue dos ausencias: `null` = la tarea no tiene regla (el
 * parche tiene que traer `freq`, y se usa tal cual) y `undefined` = no se sabe
 * (servidor anterior a exponer `recurrence`): ahí solo se acepta un parche con
 * `freq`, sabiendo que lo no enviado no se puede conservar.
 *
 * `byWeekday` se descarta si la regla resultante no es semanal de calendario:
 * la app lo ignora en ese caso, y dejarlo haría creer que sigue vigente.
 */
export function mergeRecurrencePatch(
	patch: RecurrencePatch,
	current: IngestRecurrence | null | undefined
): { rule: IngestRecurrence } | { error: string } {
	const base: RecurrencePatch = current ?? {};
	const merged: RecurrencePatch = { ...base, ...patch };
	const freq = merged.freq;
	if (freq === undefined) {
		return {
			error:
				current === undefined
					? 'no se pudo leer la regla actual de la tarea; manda la regla completa, con freq.'
					: 'la tarea no repite; para ponerle regla indica al menos freq.'
		};
	}
	const rule: IngestRecurrence = { freq };
	if (merged.mode === 'afterCompletion') rule.mode = 'afterCompletion';
	if (merged.interval !== undefined) rule.interval = merged.interval;
	if (
		merged.byWeekday !== undefined &&
		merged.byWeekday !== null &&
		merged.byWeekday.length > 0 &&
		freq === 'weekly' &&
		rule.mode !== 'afterCompletion'
	) {
		rule.byWeekday = merged.byWeekday;
	}
	if (merged.until !== undefined && merged.until !== null) rule.until = merged.until;
	if (merged.count !== undefined && merged.count !== null) rule.count = merged.count;
	if (merged.streak === true) rule.streak = true;
	return { rule };
}

/** Campos de `update` distintos de `recurrence` (ver CX7 en `buildBatchFromOps`). */
const UPDATE_EXTRA_FIELDS = ['content', 'notes', 'tags', 'priority', 'time'] as const;

/** Id de la semilla si `task` es una OCURRENCIA de una serie (su `seriesId`
 *  apunta a otra fila); `null` si es la semilla o no es de ninguna serie.
 *  Mismo criterio que `isSeriesOccurrence` en el repo principal. */
function seriesSeedIdOf(task: LumbreTask | undefined): string | null {
	const seriesId = task?.seriesId;
	return seriesId && seriesId !== task.id ? seriesId : null;
}

/**
 * Regla contra la que fusionar un parche parcial de `recurrence` sobre
 * `taskId` (CX6): la de su SEMILLA si es una ocurrencia y la semilla está en
 * `existing`, la de la propia fila en otro caso. Sin semilla legible (borrada)
 * se usa la de la fila: la app no escribe una regla nueva en una serie sin
 * semilla viva, así que el resultado no puede pisar nada.
 */
function currentSeriesRule(
	existing: Map<string, LumbreTask>,
	taskId: string
): IngestRecurrence | null | undefined {
	const row = existing.get(taskId);
	const seedId = seriesSeedIdOf(row);
	const seed = seedId === null ? undefined : existing.get(seedId);
	return seed !== undefined ? seed.recurrence : row?.recurrence;
}

/**
 * Ids de SEMILLA que `mutate_tasks` debe leer (con archivadas incluidas) antes
 * de `buildBatchFromOps` (CX6): los de las ocurrencias con un parche parcial
 * de `recurrence` cuya semilla no está ya en `existing`. Deduplicados.
 */
export function collectSeriesSeedIds(
	ops: MutateTasksOp[],
	existing: Map<string, LumbreTask>
): string[] {
	const ids = new Set<string>();
	for (const op of ops) {
		if (op.op !== 'update' || op.recurrence === undefined || op.recurrence === null) continue;
		const seedId = seriesSeedIdOf(existing.get(op.taskId));
		if (seedId !== null && !existing.has(seedId)) ids.add(seedId);
	}
	return [...ids];
}

/**
 * Núcleo PURO (sin red) de `mutate_tasks`: valida localmente cada op
 * (`localValidationError`) y, si targetea una tarea, comprueba su existencia
 * contra `existing` (`assertTaskUsable`, con el `allowSubtask` que le toque —
 * ver `TASK_TARGET_ALLOW_SUBTASK`); lo que pasa ambos filtros se traduce a
 * `BatchOp` (`translateOp`). Separado de la llamada real (`findTasksByIds` +
 * `runBatch`, en `index.ts`) para poder testearlo sin mockear `fetch` — mismo
 * patrón que `assertTaskUsable`/`lumbre-client.test.ts`.
 */
export function buildBatchFromOps(
	ops: MutateTasksOp[],
	existing: Map<string, LumbreTask>
): BuildBatchResult {
	const batchOps: BatchOp[] = [];
	const originalIndexes: number[] = [];
	const skipped: { index: number; error: string }[] = [];

	ops.forEach((op, index) => {
		const localError = localValidationError(op);
		if (localError !== null) {
			skipped.push({ index, error: localError });
			return;
		}
		// `undefined` = la op no targetea una tarea (lista/sección/`add_task`):
		// no comprueba existencia. Mismo criterio, MISMA tabla, que
		// `collectExistenceCheckIds`.
		const allowSubtask = TASK_TARGET_ALLOW_SUBTASK[op.op];
		if (allowSubtask !== undefined) {
			const targetId = targetIdOf(op)!;
			try {
				assertTaskUsable(existing.get(targetId), targetId, { allowSubtask });
			} catch (err) {
				skipped.push({ index, error: err instanceof Error ? err.message : String(err) });
				return;
			}
		}
		// MC2 del audit de paridad (23 sep 2026): dos ramas del materializador de
		// la app descartan la op en SILENCIO y aun así devuelven `applied`
		// (`inbound-materialize.ts`, cases `setSection`/`addSubtask`) — se
		// rechaza aquí, ANTES de encolar, en los dos casos que el cliente ya
		// puede saber de antemano que no van a aplicarse (ver los JSDoc de
		// `taskWithoutListNotAllowedError`/`nestedSubtaskNotAllowedError`). No
		// toca la cola ni el drenaje: los sigue tratando tal como responden hoy.
		if (op.op === 'set_section' && !existing.get(op.taskId)?.somedayListId) {
			skipped.push({ index, error: taskWithoutListNotAllowedError(op.taskId).message });
			return;
		}
		if (op.op === 'add_subtask' && existing.get(op.taskId)?.parentId) {
			skipped.push({ index, error: nestedSubtaskNotAllowedError(op.taskId).message });
			return;
		}
		// CX7: sobre una tarea ARCHIVADA la app solo aplica el apagado de la
		// regla (`clearArchivedSeedRecurrence`, antes de su guard de tarea
		// viva); el resto de campos del mismo `update` nunca se aplicaba y el
		// informe los daba por hechos. Se rechaza la op entera, nombrando los
		// campos, para que el modelo los mande aparte si la desarchiva.
		if (op.op === 'update' && op.recurrence === null) {
			const target = existing.get(op.taskId);
			const extra = UPDATE_EXTRA_FIELDS.filter((field) => op[field] !== undefined);
			if (target?.archivedAt && extra.length > 0) {
				skipped.push({
					index,
					error:
						`update: la tarea ${op.taskId} está archivada y sobre ella solo se aplica ` +
						`recurrence:null; manda recurrence:null a solas (sobran: ${extra.join(', ')}).`
				});
				return;
			}
		}
		// La app SUSTITUYE la regla entera en un `update`; el modelo manda un
		// cambio parcial. Se fusiona aquí con la regla VIGENTE, para que un
		// campo no enviado (`streak`, `byWeekday`…) no se pierda por omisión.
		// La vigente es la de la SEMILLA (CX6): la app escribe la regla de una
		// ocurrencia en toda su serie (`setSeriesRuleFromOccurrence`), y una
		// ocurrencia CERRADA conserva la copia de la regla que tenía al cerrarse.
		if (op.op === 'update' && op.recurrence !== undefined && op.recurrence !== null) {
			const merged = mergeRecurrencePatch(op.recurrence, currentSeriesRule(existing, op.taskId));
			if ('error' in merged) {
				skipped.push({ index, error: `update: ${merged.error}` });
				return;
			}
			batchOps.push(translateOp({ ...op, recurrence: merged.rule }));
			originalIndexes.push(index);
			return;
		}
		batchOps.push(translateOp(op));
		originalIndexes.push(index);
	});

	return { batchOps, originalIndexes, skipped };
}

// ── Reparto en dos fases (incidente 071553, 3 sep 2026) ─────────────────────
//
// `POST /api/batch` del repo principal mete las ops `ingest` y `mutate` en
// DOS colas separadas y drena SIEMPRE todas las `ingest` antes que TODAS las
// `mutate` (`materializeBatch`, `src/lib/server/sync/drain.ts` en ese repo;
// documentado en `src/routes/api/batch/+server.ts:69-76`). NO es un descuido:
// es una garantía DELIBERADA, en la dirección contraria — así una tarea creada
// y mutada en el MISMO lote funciona (la mutación siempre encuentra la tarea
// ya materializada). Esa misma garantía deja sin cubrir la pareja opuesta: un
// `create_list` seguido de un alta que depende de él. Con un solo
// `mutate_tasks` `[{op:'create_list',...}, ...N×{op:'add_task', listId: <esa
// lista>}]`, las altas se materializan con la lista TODAVÍA inexistente:
// `resolveInboundListId` devuelve `''` y la tarea nace SIN lista y con fecha
// de HOY (le ensucia el Día al usuario). Reordenar el array en el MCP no
// arregla nada — el servidor no mira ese orden, mira el TIPO de op — así que
// el arreglo va aquí: partir la llamada en DOS peticiones cuando (y SOLO
// cuando) hay esa dependencia.
//
// La pareja alta→mutación (la que SÍ cubre el servidor) no hace falta
// partirla porque hoy es INEXPRESABLE en `mutate_tasks`: un `add_task` no
// lleva id de cliente (`translateOp` manda `{type:'ingest', task}`; el id lo
// asigna el servidor y solo se conoce en la respuesta), y las 9 ops que
// targetean una tarea (`TASK_TARGET_ALLOW_SUBTASK`) comprueban su existencia
// contra el servidor ANTES de mandar el batch (`collectExistenceCheckIds` +
// `assertTaskUsable`, en `index.ts`) — una mutación sobre una tarea creada en
// el mismo lote ya se descarta ahí, con o sin este fix.

/** Una fase del reparto: sus `BatchOp` ya traducidas y, paralelo a ellas, el
 *  índice ORIGINAL (en el `ops` que pasó el modelo) de cada una — mismo
 *  criterio que `BuildBatchResult.originalIndexes`. */
export interface BatchPhase {
	ops: BatchOp[];
	originalIndexes: number[];
}

/** Resultado de `planBatchPhases` — ver su JSDoc. */
export interface BatchPhasePlan {
	/** `true` si hubo que partir (hay dependencia intra-lote por `listId`:
	 *  alguna op `ingest` referencia el `taskId` de un `create_list` del MISMO
	 *  array). `false` → una sola fase, comportamiento de siempre. */
	split: boolean;
	/** Fases en el orden en que hay que mandarlas. Sin partir, un único
	 *  elemento con TODAS las `batchOps` (mismas referencias que se pasaron). */
	phases: BatchPhase[];
	/** Por cada op `ingest` dependiente de un `create_list` del lote: su índice
	 *  ORIGINAL y el `listId` (= `taskId` del `createList`) del que depende.
	 *  Vacío si `split` es `false`. La usa `filterPhase2AfterPhase1` para
	 *  decidir, YA con el resultado real de la fase 1, qué altas se descartan. */
	dependents: { index: number; listId: string }[];
}

/**
 * Detecta si `batchOps` (YA traducidas, ver `buildBatchFromOps`) tiene
 * dependencia intra-lote — una op `ingest` cuyo `task.listId` coincide con el
 * `taskId` de una op `mutate`/`createList` del MISMO array — y, si la hay,
 * reparte `batchOps` en DOS fases (`mutate` primero, `ingest` después) en vez
 * de una. Pura, sin red: separada de la llamada real (`runBatch` × 1 o 2, en
 * `index.ts`) para poder testearla sin mockear `fetch`.
 *
 * Sin dependencia (incluida una op `ingest` con un `listId` de una lista YA
 * EXISTENTE, que no se crea en este lote): `split: false`, una sola fase con
 * `batchOps` tal cual — CERO cambio de comportamiento ni coste extra de red
 * frente a antes de este fix.
 *
 * Con dependencia: fase 1 = TODAS las ops `mutate` del lote (no solo los
 * `createList` de los que depende alguna alta: el resto de mutaciones viaja
 * igual, no hay motivo para retrasarlas), en su orden original; fase 2 = TODAS
 * las ops `ingest` del lote, en su orden original. Qué altas de la fase 2
 * sobreviven de verdad (una vez se sabe si su `createList` salió `ok`) lo
 * decide `filterPhase2AfterPhase1`, DESPUÉS de mandar la fase 1 — este
 * planificador no toca red, así que no puede saberlo todavía.
 */
export function planBatchPhases(batchOps: BatchOp[], originalIndexes: number[]): BatchPhasePlan {
	// `taskId` de cada `create_list` del lote — la lista que "nace" en esta
	// misma llamada.
	const createdListIds = new Set<string>();
	for (const op of batchOps) {
		if (op.type === 'mutate' && op.kind === 'createList') createdListIds.add(op.taskId);
	}

	const dependents: { index: number; listId: string }[] = [];
	if (createdListIds.size > 0) {
		batchOps.forEach((op, i) => {
			if (op.type === 'ingest' && op.task.listId && createdListIds.has(op.task.listId)) {
				dependents.push({ index: originalIndexes[i], listId: op.task.listId });
			}
		});
	}

	if (dependents.length === 0) {
		return { split: false, phases: [{ ops: batchOps, originalIndexes }], dependents: [] };
	}

	const mutatePhase: BatchPhase = { ops: [], originalIndexes: [] };
	const ingestPhase: BatchPhase = { ops: [], originalIndexes: [] };
	batchOps.forEach((op, i) => {
		const phase = op.type === 'mutate' ? mutatePhase : ingestPhase;
		phase.ops.push(op);
		phase.originalIndexes.push(originalIndexes[i]);
	});

	return { split: true, phases: [mutatePhase, ingestPhase], dependents };
}

/**
 * Segundo paso del reparto, YA con el resultado real de la fase 1 (`runBatch`
 * de `plan.phases[0].ops`): decide qué ops de la fase 2 (`plan.phases[1]`) se
 * mandan de verdad y cuáles se descartan por depender de un `create_list` que
 * NO salió `ok` — nunca se manda una alta huérfana con fecha de HOY (el
 * síntoma del incidente 071553). Pura, sin red: separada de `mutate_tasks`
 * para poder testearla sin mockear `fetch`. Con `plan.split` en `false`
 * devuelve todo vacío — no hay fase 2 que filtrar.
 *
 * El mensaje de cada descarte cita el índice ORIGINAL de la op `create_list`
 * causante (`ver el fallo de la op [N]`), para que el modelo pueda leer su
 * error concreto en el mismo informe sin tener que adivinar cuál era. Si DOS
 * `create_list` del lote comparten el mismo `listId` (raro, pero el schema no
 * lo impide), la promesa solo se da por cumplida si TODAS salieron `ok`; el
 * mensaje cita la que falló con el índice ORIGINAL más bajo — antes (code
 * review 🔴) un `Map` simple se quedaba con la ÚLTIMA, y podía citar una op
 * equivocada o dar la lista por creada con una hermana rota.
 */
export function filterPhase2AfterPhase1(
	plan: BatchPhasePlan,
	phase1Results: BatchResultItem[]
): { ops: BatchOp[]; originalIndexes: number[]; skipped: { index: number; error: string }[] } {
	if (!plan.split || plan.phases.length < 2) {
		return { ops: [], originalIndexes: [], skipped: [] };
	}
	const [phase1, phase2] = plan.phases;

	// `listId` → TODAS las entradas {índice ORIGINAL, ok} de los `create_list`
	// de la fase 1 que la prometen (normalmente una sola).
	const entriesByListId = new Map<string, { originalIndex: number; ok: boolean }[]>();
	phase1.ops.forEach((op, i) => {
		if (op.type === 'mutate' && op.kind === 'createList') {
			const entries = entriesByListId.get(op.taskId) ?? [];
			entries.push({ originalIndex: phase1.originalIndexes[i], ok: phase1Results[i]?.ok === true });
			entriesByListId.set(op.taskId, entries);
		}
	});

	const dependentListIdByIndex = new Map(plan.dependents.map((d) => [d.index, d.listId]));

	const ops: BatchOp[] = [];
	const originalIndexes: number[] = [];
	const skipped: { index: number; error: string }[] = [];
	phase2.ops.forEach((op, i) => {
		const origIndex = phase2.originalIndexes[i];
		const listId = dependentListIdByIndex.get(origIndex);
		if (listId !== undefined) {
			const entries = entriesByListId.get(listId) ?? [];
			const allOk = entries.length > 0 && entries.every((e) => e.ok);
			if (!allOk) {
				const firstFailing = entries
					.filter((e) => !e.ok)
					.sort((a, b) => a.originalIndex - b.originalIndex)[0];
				skipped.push({
					index: origIndex,
					error:
						`la lista ${listId} no se pudo crear en este lote` +
						(firstFailing !== undefined ? ` (ver el fallo de la op [${firstFailing.originalIndex}])` : '') +
						'; la tarea no se ha creado'
				});
				return;
			}
		}
		ops.push(op);
		originalIndexes.push(origIndex);
	});

	return { ops, originalIndexes, skipped };
}

/** El `create_list` que prometía un `listId` (agujero 🔴, code review sobre
 *  este mismo commit): índice ORIGINAL de la op y su error, cuando esa
 *  promesa se rompió ANTES de tocar red — forma inválida (`.strict()` la
 *  rechaza, p. ej. sin `name`) o validación local — así que ese `create_list`
 *  NUNCA llegó a `batchOps`/`planBatchPhases`, que solo ven lo que SOBREVIVIÓ
 *  al filtro. Ver `excludeIngestForBrokenListPromises`. */
export interface BrokenListPromise {
	index: number;
	error: string;
}

/**
 * Filtra de `batchOps` (recién traducidas por `buildBatchFromOps`, ANTES de
 * `planBatchPhases`) las ops `ingest` cuyo `task.listId` referencia un
 * `create_list` del MISMO lote que YA falló sin llegar a mandarse
 * (`brokenListIds`, ver `BrokenListPromise`) — nunca las manda, en NINGUNA
 * fase, y las reporta como fallo con su índice ORIGINAL, citando la op
 * `create_list` causante.
 *
 * El agujero que esto cierra (🔴, revisión sobre el commit que introdujo
 * `planBatchPhases`): ese planificador solo ve `batchOps`, que es la SALIDA
 * de `buildBatchFromOps` — un `create_list` descartado por forma inválida
 * (p. ej. `{op:'create_list', listId:'L'}` sin `name`) nunca entra ahí, así
 * que `planBatchPhases` no encontraba ninguna dependencia y el `add_task`
 * dependiente viajaba SOLO, en una única petición, con la lista inexistente
 * — exactamente el síntoma del incidente 071553, solo que disparado por un
 * `create_list` mal formado en vez de uno bien formado que aún no se ha
 * mandado. La promesa de un `listId` (que el lote pretende crear ESA lista)
 * la hace la FORMA de la op (`op:'create_list'`, con ese `listId`), no que
 * haya sobrevivido a la validación — así que este filtro corre ANTES,
 * sobre `batchOps`+`brokenListIds` (que el llamante construye a partir de
 * los descartes por forma y por validación local, ANTES de traducir), y dejar
 * a `planBatchPhases` la parte que SÍ puede resolver por red (fase 1).
 *
 * Pura, sin red: separada de `mutate_tasks` (`index.ts`, que construye
 * `brokenListIds`) para poder testearla sin mockear `fetch`.
 */
export function excludeIngestForBrokenListPromises(
	batchOps: BatchOp[],
	originalIndexes: number[],
	brokenListIds: Map<string, BrokenListPromise>
): { batchOps: BatchOp[]; originalIndexes: number[]; skipped: { index: number; error: string }[] } {
	if (brokenListIds.size === 0) {
		return { batchOps, originalIndexes, skipped: [] };
	}
	const filteredOps: BatchOp[] = [];
	const filteredIndexes: number[] = [];
	const skipped: { index: number; error: string }[] = [];
	batchOps.forEach((op, i) => {
		if (op.type === 'ingest' && op.task.listId) {
			const broken = brokenListIds.get(op.task.listId);
			if (broken !== undefined) {
				skipped.push({
					index: originalIndexes[i],
					error:
						`la lista ${op.task.listId} no se pudo crear en este lote ` +
						`(ver el fallo de la op [${broken.index}]); la tarea no se ha creado`
				});
				return;
			}
		}
		filteredOps.push(op);
		filteredIndexes.push(originalIndexes[i]);
	});
	return { batchOps: filteredOps, originalIndexes: filteredIndexes, skipped };
}
