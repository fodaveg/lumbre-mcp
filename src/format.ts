import type { LumbreTask, TaskScope } from './lumbre-client.js';

/** Etiqueta corta de prioridad, o '' si p4/ninguna (mismo criterio que la app). */
function priorityLabel(priority: LumbreTask['priority']): string {
	return priority ? `p${priority}` : '';
}

/** Longitud máxima de las notas mostradas por tarea antes de truncar con "…". */
const NOTES_PREVIEW_LENGTH = 240;

/** Notas colapsadas a una línea (saltos de línea → espacio) y truncadas, para
 *  no romper el formato "una tarea, una línea" de `formatTask`. */
function notesPreview(notes: string): string {
	const collapsed = notes.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= NOTES_PREVIEW_LENGTH) return collapsed;
	return `${collapsed.slice(0, NOTES_PREVIEW_LENGTH)}…`;
}

/** Notas TAL CUAL (sin truncar NI colapsar saltos de línea) — para
 *  `fullNotes: true`/`get_task`: el caso de uso es reeditarlas con
 *  `update_task` (que REEMPLAZA la nota entera), así que hasta los saltos de
 *  línea importan; colapsarlos como hace `notesPreview` los destruiría. */
function notesFull(notes: string): string {
	return notes.trim();
}

/** Opciones de formateo de una tarea; hoy solo si mostrar las notas
 *  íntegras (ver `notesFull`) o el resumen truncado (`notesPreview`,
 *  default). */
interface FormatTaskOptions {
	fullNotes?: boolean;
}

/** Una tarea → una línea compacta y legible (NO JSON crudo, para no saturar al modelo). */
function formatTask(t: LumbreTask, opts: FormatTaskOptions = {}): string {
	const box = t.done ? '[x]' : '[ ]';
	const tags: string[] = [];
	const prio = priorityLabel(t.priority);
	if (prio) tags.push(prio);
	if (t.date) tags.push(t.date);
	if (t.deadline) tags.push(`⚑${t.deadline}`);
	// `createdAt` recortado a minuto (sin segundos/ms): sirve para desempatar
	// duplicados ("deja el más nuevo") sin alargar la línea de más.
	tags.push(`creada:${t.createdAt.slice(0, 16)}`);
	const suffix = ` (${tags.join(', ')})`;
	// El id (UUID) al final de la línea: TODAS las tools de mutación
	// (update_task, complete_task, reschedule_task, delete_task, set_section) lo
	// EXIGEN, y `list_tasks` es el único sitio donde el modelo puede obtenerlo.
	// Sin esto sus descripciones ("resuélvelo antes con list_tasks") eran
	// imposibles de cumplir y las mutaciones quedaban de facto inservibles.
	let line = `- ${box} ${t.content}${suffix}  · id: ${t.id}`;
	// Línea aparte con las notas (si las hay): truncadas y sin saltos de línea
	// por defecto (es solo el feedback que David deja en el detalle de la
	// tarea, no hace falta reproducirlo exacto); íntegras y verbatim con
	// `fullNotes` (o desde `get_task`), para poder reeditarlas sin destruir lo
	// que no cupiera en el resumen — ver `notesFull`.
	if (t.notes && t.notes.trim() !== '') {
		const notesText = opts.fullNotes ? notesFull(t.notes) : notesPreview(t.notes);
		line += `\n  notas: ${notesText}`;
	}
	if (!t.attachments || t.attachments.length === 0) return line;
	// Una línea aparte con los adjuntos (nombre + id): el modelo necesita el id
	// para pedir los bytes con la tool `read_attachment`.
	const attachmentsLine = `  📎 adjuntos: ${t.attachments
		.map((a) => `${a.filename} (id: ${a.id})`)
		.join(' · ')}`;
	return `${line}\n${attachmentsLine}`;
}

/**
 * Tarea → bloque legible con TODOS sus campos (para `get_task`, ver
 * `index.ts`): a diferencia de `formatTask` (pensado para listados, una línea
 * por tarea), este vuelca lista/sección/`createdAt` explícitos y las notas
 * SIEMPRE íntegras y verbatim (ver `notesFull`) — el caso de uso es leer una
 * tarea entera para poder reeditar su nota con `update_task` sin perder nada.
 *
 * `subtasks` (si la tarea es de primer nivel y tiene alguna, ver
 * `LumbreTask.subtasks`): una línea `[x]`/`[ ]` por subtarea, con SU id — es
 * el ÚNICO sitio donde el modelo puede obtener el id de una subtarea, para
 * poder pasárselo después a `complete_subtask`.
 */
export function formatTaskFull(t: LumbreTask): string {
	const lines = [
		`Tarea ${t.id}`,
		`- contenido: ${t.content}`,
		`- estado: ${t.done ? 'hecha' : 'pendiente'}`,
		`- prioridad: ${priorityLabel(t.priority) || '(ninguna)'}`,
		`- fecha: ${t.date ?? '(sin fecha)'}`,
		`- deadline: ${t.deadline ? `⚑${t.deadline}` : '(sin deadline)'}`,
		`- lista: ${t.list ? `"${t.list}"${t.somedayListId ? ` (listId: ${t.somedayListId})` : ''}` : '(sin lista)'}`,
		`- sección: ${t.section ? `"${t.section}"${t.sectionId ? ` (sectionId: ${t.sectionId})` : ''}` : '(sin sección)'}`,
		`- creada: ${t.createdAt}`
	];
	if (t.notes && t.notes.trim() !== '') {
		lines.push(`- notas:\n${notesFull(t.notes)}`);
	} else {
		lines.push('- notas: (sin notas)');
	}
	if (t.attachments && t.attachments.length > 0) {
		lines.push(
			`- 📎 adjuntos: ${t.attachments.map((a) => `${a.filename} (id: ${a.id})`).join(' · ')}`
		);
	}
	if (t.subtasks && t.subtasks.length > 0) {
		lines.push('- subtareas:');
		for (const s of t.subtasks) {
			lines.push(`  ${s.done ? '[x]' : '[ ]'} ${s.content}  · id: ${s.id}`);
		}
	}
	return lines.join('\n');
}

/**
 * Leyenda de listas: una línea por lista de "Algún día" DISTINTA presente en
 * el lote (deduplicada por el par `(nombre, listId)`, no solo por nombre —
 * dos listas distintas pueden compartir nombre, ver el comentario de
 * `distinctLists` más abajo). Da al modelo el `listId` ESTABLE de cada lista
 * sin que tenga que inspeccionar tarea por tarea; lo necesita para `add_task`
 * (`listId`) y `move_to_list`. Tareas sin lista, o cuya lista aún no tenga
 * `somedayListId` resuelto, no aportan entrada. Devuelve `[]` si ninguna
 * tarea del lote tiene lista (el llamante omite la leyenda en ese caso).
 */
function listLegend(tasks: LumbreTask[]): string[] {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const t of tasks) {
		if (!t.list || !t.somedayListId) continue;
		const key = `${t.list} ${t.somedayListId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(`· lista "${t.list}" — listId: ${t.somedayListId}`);
	}
	return lines;
}

/**
 * Lista completa → texto compacto con cabecera de recuento + alcance,
 * agrupado por sección (Fase B, listas=proyectos): una cabecera `## <sección>`
 * por grupo, en el orden en que aparecen en la respuesta del servidor (ya
 * viene ordenada por fecha/posición). Las tareas sin sección van bajo
 * `## (sin sección)` — SOLO se muestra esa cabecera si hay alguna tarea CON
 * sección en el lote (si ninguna tarea tiene sección, listar secciones no
 * aporta nada y solo añade ruido). Esto ayuda al modelo a distinguir, p. ej.,
 * bugs de propuestas dentro del mismo proyecto sin tener que parsear el texto.
 *
 * El agrupado real es por el PAR `(list, section)`, no solo por `section`:
 * cuando se listan tareas de VARIAS listas a la vez (query sin `?list=`), dos
 * proyectos con secciones homónimas (p. ej. "Bugs" en dos listas distintas)
 * NO deben fusionarse bajo la misma cabecera. Si en el lote hay una única
 * lista distinta (o ninguna), la cabecera se queda como antes (`## <sección>`,
 * sin repetir el nombre de la lista, redundante en ese caso); si hay más de
 * una lista distinta, se antepone su nombre (`## <lista> · <sección>`).
 *
 * `opts.fullNotes` (default `false`) pasa a cada `formatTask`: con `true` las
 * notas de TODAS las tareas del lote salen íntegras y verbatim en vez de
 * truncadas a `NOTES_PREVIEW_LENGTH` — pensado para lotes ya acotados (p. ej.
 * `list` + `section`) donde perder detalle de la nota molesta más que el
 * texto extra en el contexto. Para leer una sola tarea completa sin acotar el
 * listado entero, mejor `get_task` (ver `index.ts`/`formatTaskFull`).
 */
export function formatTaskList(
	tasks: LumbreTask[],
	scope: TaskScope,
	opts: FormatTaskOptions = {}
): string {
	if (tasks.length === 0) return `Sin tareas (scope=${scope}).`;
	const header = `${tasks.length} tarea${tasks.length === 1 ? '' : 's'} (scope=${scope}):`;
	// Leyenda de listas primero (si alguna tarea tiene lista): da el `listId`
	// de cada una sin tocar el formato por-tarea, que se deja intacto para no
	// añadir ruido repetido línea a línea.
	const legend = listLegend(tasks);
	const prefix = legend.length > 0 ? [...legend, ''] : [];

	const hasAnySection = tasks.some((t) => t.section);
	if (!hasAnySection) {
		return [...prefix, header, ...tasks.map((t) => formatTask(t, opts))].join('\n');
	}

	// "Listas distintas" = valores de t.list no nulos, deduplicados. Si el lote
	// solo toca una (o ninguna, todas null), no hace falta desambiguar.
	const distinctLists = new Set(tasks.map((t) => t.list).filter((l): l is string => !!l));
	const showList = distinctLists.size > 1;

	const groups: { key: string; label: string; tasks: LumbreTask[] }[] = [];
	for (const t of tasks) {
		const sectionLabel = t.section ?? '(sin sección)';
		const listLabel = t.list ?? '(sin lista)';
		const label = showList ? `${listLabel} · ${sectionLabel}` : sectionLabel;
		// Clave de agrupación separada de la etiqueta visible: JSON.stringify
		// evita colisiones si un nombre de lista/sección contiene el separador.
		const key = JSON.stringify([showList ? listLabel : null, sectionLabel]);
		const group = groups.find((g) => g.key === key);
		if (group) group.tasks.push(t);
		else groups.push({ key, label, tasks: [t] });
	}
	const body = groups.flatMap((g) => [`## ${g.label}`, ...g.tasks.map((t) => formatTask(t, opts))]);
	return [...prefix, header, ...body].join('\n');
}
