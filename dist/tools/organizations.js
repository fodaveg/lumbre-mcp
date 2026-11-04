import { getOrganizationsDirectory } from '../lumbre-client.js';
import { formatOrganizationsDirectory } from '../format.js';
import { errorResult, textResult } from './shared.js';
/**
 * Familia «organizaciones» (`docs/81` §4.7, `docs/80` §8g.3 del repo principal):
 * `list_organizations`, solo lectura. Un agente ve organizaciones, miembros y
 * espacios, pero el contenido se lee espacio por espacio con `spaceId` y solo si
 * la persona encendió el permiso (`granted`). Sin parámetros.
 */
export function registerOrganizationTools(server, ctx) {
    const listOrganizationsTool = server.registerTool('list_organizations', {
        annotations: { readOnlyHint: true },
        description: 'Organizaciones, miembros y espacios (spaceId, granted). Contenido: spaceId en ' +
            'list_tasks/list_lists si granted.',
        inputSchema: {}
    }, async () => {
        try {
            return textResult(formatOrganizationsDirectory(await getOrganizationsDirectory(ctx.config)));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return { listOrganizationsTool };
}
//# sourceMappingURL=organizations.js.map