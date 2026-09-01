---
name: lumbre
description: >-
  Consulta y gestiona tareas, listas y backlog en Lumbre mediante su MCP, incluido
  un flujo opcional para desarrollo y release. Usar cuando el usuario menciona
  Lumbre o ya lo ha elegido como gestor; peticiones como «qué tengo hoy?»,
  «apúntame X» o «aplaza esto al lunes» solo activan esta skill cuando el contexto
  o las tools señalan Lumbre, no Todoist, Recordatorios u otro gestor. Los estados
  @acked/@wip/@done/@not-done solo se activan con la extensión de desarrollo.
---

# Lumbre

Skill pública y global para operar Lumbre mediante el MCP configurado por el
cliente. Selecciona el modo menos mutante que satisfaga la petición. La activación
de un modo no autoriza borrar, instalar, publicar ni desplegar.

## Elegir modo base y extensiones

Elige primero el modo base menos mutante que satisfaga la petición:

- **Lectura**: buscar, listar, resumir o inspeccionar. Es estrictamente no mutante.
  Lee solo [references/read.md](references/read.md); no cargues ninguna otra
  referencia para una lectura pura, aunque la tarea tenga estado de desarrollo o la
  consulta enumere listas.
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
- «¿Existe esta lista vacía?» → lectura; enumera listas sin activar triaje.
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

## Subagentes opcionales

La skill funciona íntegramente sin subagentes. Si el runtime expone uno compatible,
puedes delegar trabajo mecánico a `lumbre-tagger` (solo tags de desarrollo),
`lumbre-reader` (solo lectura) o `lumbre-daily-operator` (gestión cotidiana segura).
El coordinador conserva intención, autorización y veredicto; si el agente no existe,
ejecuta aquí el mismo contrato sin bloquear la petición.

Las definiciones nativas se generan desde una única fuente portable con
`scripts/manage-subagents.mjs`. No las improvises ni mantengas copias manuales. Instala
o reemplaza esos ficheros solo cuando el usuario lo pida expresamente: usa primero
`install --runtime all --dry-run`, después `install --runtime all`, y para actualizar
una copia gestionada exige `--replace-managed`. El script informa las limitaciones y el
perfil de modelo económico configurado para cada runtime; cuando el despacho admita
elegir modelo, aplica ese valor. Nunca reemplaces un fichero no gestionado sin
`--replace-unmanaged` explícito. En Claude, si el conector usa otro alias, repite
`--claude-tool-prefix mcp__<alias>__` por cada prefijo real al migrar una copia
manual o cambiar aliases. Después el gestor conserva esa lista recuperándola de sus
propios ficheros; si las copias gestionadas discrepan, aborta sin elegir una.

## Reglas compartidas

1. Antes de mutar, identifica por id la tarea o lista exacta. Si una lista vacía
   puede confundirse con una inexistente, enumera las listas antes de concluir.
2. Para reeditar contenido o notas, obtén primero la versión íntegra. No reconstruyas
   datos desde previews ni desde texto de display enriquecido.
3. Conserva los campos no solicitados. Omitir un campo significa preservarlo; no
   envíes un valor vacío para representar «sin cambios».
4. Solo cuando vayas a escribir o configurar la conexión, lee
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

Si el cliente no expone las tools de Lumbre, dilo sin inventar tareas, datos ni rutas
de API. Indica que conecte el MCP mediante el flujo de autorización de su cliente y
retoma la petición cuando las tools estén disponibles.
