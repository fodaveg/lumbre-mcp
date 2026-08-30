---
name: lumbre
description: >-
  Consulta y gestiona tareas, listas y backlog en Lumbre mediante su MCP, incluido
  un flujo opcional para desarrollo y release. Usar para leer o cambiar datos de
  Lumbre; los estados @acked/@wip/@done/@not-done solo se activan con la extensión
  de desarrollo.
---

# Lumbre

Skill pública y global para operar Lumbre mediante el MCP configurado por el
cliente. Selecciona el modo menos mutante que satisfaga la petición. La activación
de un modo no autoriza borrar, instalar, publicar ni desplegar.

## Elegir modo base y extensiones

Elige primero el modo base menos mutante que satisfaga la petición:

- **Lectura**: buscar, listar, resumir o inspeccionar. Es estrictamente no mutante.
  Lee [references/read.md](references/read.md).
- **Gestión cotidiana**: crear, editar, fechar, priorizar, completar o cancelar
  tareas con propiedades nativas. Lee [references/daily.md](references/daily.md).
- **Triaje/backlog**: clasificar, agrupar, mover o reorganizar tareas, listas y
  secciones. Lee [references/backlog.md](references/backlog.md).

Añade solo las extensiones necesarias:

- **Desarrollo**: gestionar trabajo de implementación con estados de agente, lotes,
  evidencia y checkpoints. Está apagado por defecto; se activa por petición
  explícita, al continuar o gestionar trabajo de una tarea ya adherida al flujo, o
  por una regla vigente del repo. Leer o resumir esa tarea sigue siendo lectura.
  Lee [references/development.md](references/development.md).
- **Proyecto/release**: relacionar tareas con git, gates, revisión, documentación o
  despliegue. Lee primero las reglas vivas del repo y después
  [references/project-release.md](references/project-release.md).

Una petición tiene un modo base y puede añadir ambas extensiones. Mover una tarea de
desarrollo, por ejemplo, usa triaje como base y desarrollo como extensión. Consultar
una tarea con estado no activa desarrollo; implementar y preparar un release puede
añadir desarrollo y proyecto/release a la gestión cotidiana.

Ejemplos rápidos:

- «¿Qué tengo hoy?» → lectura.
- «Aplaza esta tarea al lunes» → gestión cotidiana.
- «Ordena este backlog» → triaje, con vista previa si hay que inferir taxonomía.
- «Empieza esta tarea de código» → gestión cotidiana + desarrollo.
- «Prepara el release sin cambiar Lumbre» → lectura + proyecto/release.

## Límite de mutación

| Selección | Puede mutar |
|---|---|
| Lectura | Nada. |
| Gestión cotidiana | Solo los campos de las tareas solicitadas. |
| Triaje/backlog | Solo el conjunto y la estructura expresamente indicados. |
| + Desarrollo | Solo estados y checkpoints del flujo cuando esté activada. |
| + Proyecto/release | No concede por sí misma mutaciones adicionales en Lumbre. |

Si la petición enumera cambios exactos, aplícalos sin ceremonia adicional. Si exige
inferir alcance o taxonomía, muestra primero una propuesta breve.

## Reglas compartidas

1. Antes de mutar, identifica por id la tarea o lista exacta. Si una lista vacía
   puede confundirse con una inexistente, enumera las listas antes de concluir.
2. Para reeditar contenido o notas, obtén primero la versión íntegra. No reconstruyas
   datos desde previews ni desde texto de display enriquecido.
3. Conserva los campos no solicitados. Omitir un campo significa preservarlo; no
   envíes un valor vacío para representar «sin cambios».
4. Antes de cualquier escritura o configuración de conexión, lee
   [references/mcp-safe-operations.md](references/mcp-safe-operations.md). Agrupa
   operaciones compatibles y verifica el resultado sin atribuir a una respuesta
   aceptada una consistencia que el servidor no garantice.
5. Confirma inmediatamente antes de borrar o de otra acción difícil de recuperar,
   salvo autorización inequívoca para ese objetivo concreto.
6. Usa la autorización segura del cliente MCP. Nunca pongas tokens en URLs, tareas,
   notas, logs ni documentación.
7. Las reglas del repositorio y la petición mandan sobre perfiles locales. La skill
   no amplía autoridad ni instala, retira o reemplaza otras skills al activarse.

Los límites personales de autonomía, herramientas privadas, superficies externas y
papeleo específico pertenecen a perfiles opcionales. No los conviertas en requisitos
universales.
