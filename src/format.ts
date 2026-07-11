import type { LumbreTask, TaskScope } from './lumbre-client.js';

/** Etiqueta corta de prioridad, o '' si p4/ninguna (mismo criterio que la app). */
function priorityLabel(priority: LumbreTask['priority']): string {
	return priority ? `p${priority}` : '';
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
	return `- ${box} ${t.content}${suffix}`;
}

/** Lista completa → texto compacto con cabecera de recuento + alcance. */
export function formatTaskList(tasks: LumbreTask[], scope: TaskScope): string {
	if (tasks.length === 0) return `Sin tareas (scope=${scope}).`;
	const header = `${tasks.length} tarea${tasks.length === 1 ? '' : 's'} (scope=${scope}):`;
	return [header, ...tasks.map(formatTask)].join('\n');
}
