# Destinos: dónde va cada cosa

Cárgala cuando el encargo produce un documento (audit, spec, plan), un relevo o changelog,
o una decisión que hay que guardar. Lo que el usuario o el repositorio digan sobre dónde guardar manda sobre
esta tabla.

## Detección

Mira las tools que expone la sesión, no lo instalado en la máquina. Hebra está
disponible si la sesión expone tools de nombre base `hebra_…` (por ejemplo
hebra_search o hebra_read_note), sea cual sea el prefijo del conector. Si no está,
dilo y sigue por la columna «Sin Hebra»; no bloquees el encargo.

## Tabla

| Artefacto | Con tools de Hebra | Sin tools de Hebra |
|---|---|---|
| Tareas | Lumbre | Lumbre |
| Audit, spec, plan | Nota de Hebra; vínculo al proyecto o área de destino con `link_list_note` y `hebra://note/<uuid>`, comprobado con `get_list_links` | Si hay disco y repositorio: fichero donde el repo guarde esos documentos, y en la nota de la tarea principal del lote la ruta y el commit. Si no hay disco: adjunto `.md` a la principal (`add_attachment`). La entrega dice que no hay nota vinculada |
| Decisiones | La nota de decisiones que el usuario o el repo designen, en Hebra | El mecanismo persistente que el repo o el runtime declaren (fichero de instrucciones o de decisiones del repo, memoria del agente). Sin almacenamiento escribible: en la respuesta y en la nota de la tarea afectada. Nunca como tarea nueva |
| Relevos, changelogs y documentos efímeros (partes de estado, notas de trabajo de un lote, borradores que se van a tirar) | La carpeta que el usuario o el repo designen para notas efímeras de agentes. Si la biblioteca usa Johnny.Decimal: nota directamente en la carpeta `.05` de la categoría del proyecto (por ejemplo `21.05 memoria de agentes para productos de software/`), sin subcarpetas y nunca en la carpeta del ID del proyecto, con las reglas de su nota léeme si la hay; si la categoría no tiene `.05`, no la crees: avisa al usuario. Sin destino designado ni Johnny.Decimal: pregunta al usuario dónde, sin crear tú una carpeta. La marca "Ocultar del listado general" y el resto, en el apartado "Relevos, changelogs y documentos efímeros" de la skill `hebra`. Lo que dura no va ahí: decisiones a su nota, audits a su destino de esta tabla | El sitio donde el repo o el runtime guarden relevos (fichero de relevo del repo, memoria del agente). Sin almacenamiento escribible: en la nota de la tarea principal del lote. Nunca en la carpeta de audits ni como tarea nueva |

## Tareas que salen de un audit

Las tareas de un audit, una spec o un plan nacen ya como lotes, con la regla «Siempre en
lotes» de [daily.md](daily.md): una tarea principal por área o apartado del documento,
que nombra el resultado, y los hallazgos de ese apartado como sus subtareas (`add_task`
con `subtasks`, o `add_subtask` sobre la principal abierta del mismo lote). No se crean
sueltas por sección. Un hallazgo que necesite deadline, recordatorios o repetición queda
como principal propia, porque las subtareas no los admiten.

Si el alta se reparte en varias llamadas por tamaño, el tamaño de cada tanda no define el
lote: las subtareas de una principal pueden llegar en llamadas distintas (`add_subtask`
con su id), y una tanda no se convierte en principal ni en sección.

## Vincular la nota de Hebra

Si se crea un proyecto o se añaden tareas que salen de un audit, la nota de Hebra de ese
encargo (el audit, la spec o el plan) se vincula con `link_list_note` al proyecto o área
donde caen las tareas: el proyecto nuevo del encargo gordo, o el principal que contiene
la sección.

- La `url` es el deep link `hebra://note/<uuid>`, con el id que da Hebra al buscar o
  crear la nota; el `label` es el título de la nota.
- Si el audit solo existe en un fichero temporal, guárdalo antes como nota nueva de
  Hebra, en la carpeta donde el proyecto guarde sus audits, y vincula esa nota.
- Comprueba el vínculo con `get_list_links`.
- Salvo ese vínculo de origen, vincular o desvincular notas solo se hace con petición
  expresa.
- El vínculo lo hace el coordinador: los subagentes de la skill no tienen
  `link_list_note`.
