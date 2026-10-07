# Destinos: dónde va cada cosa

Cárgala cuando el encargo produce un documento (audit, spec, plan) o una decisión que hay
que guardar. Lo que el usuario o el repositorio digan sobre dónde guardar manda sobre
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
