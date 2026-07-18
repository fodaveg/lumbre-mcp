import { defineConfig } from 'vitest/config';

/**
 * Config MÍNIMA y propia: sin esto, vitest (sin config local) sube directorios
 * buscando una y encuentra el `vite.config.ts` de la app SvelteKit (repo raíz,
 * un nivel arriba) — que monta el plugin de SvelteKit y no tiene sentido aquí
 * (`mcp/` es un paquete Node independiente, sin `src/app.html` ni rutas). Este
 * fichero para esa subida y mantiene el test runner de `mcp/` aislado.
 */
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts']
	}
});
