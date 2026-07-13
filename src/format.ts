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

/** Una tarea → una línea compacta y legible (NO JSON crudo, para no saturar al modelo). */
function formatTask(t: LumbreTask): string {
	const box = t.done ? '[x]' : '[ ]';
	const tags: string[] = [];
	const prio = priorityLabel(t.priority);
	if (prio) tags.push(prio);
	if (t.date) tags.push(t.date);
	if (t.deadline) tags.push(`⚑${t.deadline}`);
	const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : '';
	// El id (UUID) al final de la línea: TODAS las tools de mutación
	// (update_task, complete_task, reschedule_task, delete_task, set_section) lo
	// EXIGEN, y `list_tasks` es el único sitio donde el modelo puede obtenerlo.
	// Sin esto sus descripciones ("resuélvelo antes con list_tasks") eran
	// imposibles de cumplir y las mutaciones quedaban de facto inservibles.
	let line = `- ${box} ${t.content}${suffix}  · id: ${t.id}`;
	// Línea aparte con las notas (si las hay), truncadas y sin saltos de línea:
	// es el feedback que David deja en el detalle de la tarea.
	if (t.notes && t.notes.trim() !== '') {
		line += `\n  notas: ${notesPreview(t.notes)}`;
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
 */
export function formatTaskList(tasks: LumbreTask[], scope: TaskScope): string {
	if (tasks.length === 0) return `Sin tareas (scope=${scope}).`;
	const header = `${tasks.length} tarea${tasks.length === 1 ? '' : 's'} (scope=${scope}):`;
	// Leyenda de listas primero (si alguna tarea tiene lista): da el `listId`
	// de cada una sin tocar el formato por-tarea, que se deja intacto para no
	// añadir ruido repetido línea a línea.
	const legend = listLegend(tasks);
	const prefix = legend.length > 0 ? [...legend, ''] : [];

	const hasAnySection = tasks.some((t) => t.section);
	if (!hasAnySection) {
		return [...prefix, header, ...tasks.map(formatTask)].join('\n');
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
	const body = groups.flatMap((g) => [`## ${g.label}`, ...g.tasks.map(formatTask)]);
	return [...prefix, header, ...body].join('\n');
}
