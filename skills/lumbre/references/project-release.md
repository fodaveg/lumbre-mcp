# Proyecto y release

Este modo enlaza Lumbre con un repositorio. Descubre y lee por completo `AGENTS.md`,
`CONTRIBUTING`, la documentación de workflow/release y los gates disponibles. Esas
fuentes vivas mandan; no copies una receta histórica sobre ellas.

Esta extensión no autoriza por sí misma ninguna mutación adicional en Lumbre: el modo
base y la petición siguen delimitando qué tareas o campos pueden cambiar.

## Autoridad y candidato

- Declara el rol de la sesión y el ownership antes de escribir.
- Usa la rama/worktree exigidos y preserva cambios ajenos. Aísla también puertos,
  bases de prueba y artefactos compartidos cuando haya escritores concurrentes.
- Prepara ownership, rama y worktree antes de implementar el candidato.
- No hagas commit, merge, push o deploy sin la autoridad requerida. Una tarea de
  Lumbre no concede permisos de release.
- Si el workflow exige un SHA y la petición autoriza implementar, el ownership de
  implementación permite crear el commit candidato en su worktree; no concede merge,
  push ni deploy.
- Gate, revisión y QA deben referirse a un candidato identificable. Si varios frentes
  se combinan, valida el árbol combinado.

## Fallback público de verificación

Si el repo no prescribe orden, gate y revisión pueden correr en paralelo sobre el
mismo candidato. Un hallazgo que cambia código crea otro candidato e invalida toda la
evidencia afectada; repítela sobre el nuevo árbol o SHA. Si el repo exige revisión al
final u otra secuencia, sigue esa regla.

Usa los checks normativos del proyecto y conserva sus exit codes y veredictos reales.
No llames gate a una prueba focal ni verde global a una suite parcial. Cuando el repo
distinga gate base, UI o documentación, comunica esa precisión.

Para UI o interacción, mide el síntoma en el estado, tema, tamaño y superficie
relevantes. Usa el modo demo o identidad de prueba documentados; una pantalla de login
no convierte QA pendiente en QA hecho.

## Entrega y cierre

- Un commit en un worktree no es integración; un push no demuestra despliegue.
- Descubre el canal solicitado y comprueba CI/deploy y el artefacto servido por
  contenido o candidato cuando el proyecto lo exija.
- Separa estado de agente, aceptación humana, integración y producción confirmada.
- Actualiza solo las superficies de documentación declaradas por el repo. Gestores
  externos, changelogs humanos y papeleo específico son perfiles opcionales.
- Cuando el riesgo lo justifique, entrega candidato/branch, árbol, gates, revisión,
  remoto/CI, producción, bloqueos y siguiente acción.

No fijes en la skill pública versiones de runtime, comandos, rutas, detalles de
framework ni landmines de una app concreta. Descubre sus equivalentes vivos en el repo.
