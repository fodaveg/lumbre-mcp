/** Etiquetas compactas: las propias se pintan como `#tag`; las heredadas se
 * declaran aparte para que el modelo no las reescriba sobre la tarea. */
export function formatTags(own?: readonly string[], effective?: readonly string[]): string[] {
	const ownTags = own ?? [];
	const ownSet = new Set(ownTags);
	const inherited = (effective ?? []).filter((tag) => !ownSet.has(tag));
	return [
		...ownTags.map((tag) => `#${tag}`),
		...(inherited.length > 0 ? [`heredados:${inherited.map((tag) => `#${tag}`).join('+')}`] : [])
	];
}
