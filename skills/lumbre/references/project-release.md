# Proyecto y release

Este modo enlaza una tarea de Lumbre con un repositorio. Primero descubre y lee por completo
`AGENTS.md`, `CONTRIBUTING`, la documentación de workflow/release y los gates del proyecto.
Esas fuentes mandan; no copies una receta histórica sobre una regla viva del repositorio.

## Autoridad y árbol de trabajo

- Declara el rol de la sesión y la propiedad de ficheros antes de escribir.
- Trabaja en la rama/worktree exigidos por el proyecto y preserva cambios ajenos.
- Escritores concurrentes no comparten árbol ni recursos mutables del proyecto como puertos,
  base de datos de prueba o artefactos, salvo que el workflow demuestre aislamiento.
- No hagas commit, merge, push o deploy sin la autoridad que requiera el repositorio y la
  petición. Una tarea de Lumbre no concede permisos de release.
- El gate autoritativo se ejecuta sobre el árbol o SHA candidato final. Si se combinan
  varios frentes, valida el árbol combinado. Cualquier cambio posterior invalida gate y
  revisión hasta volver a obtener evidencia sobre el candidato nuevo.
- No afirmes que un bug está arreglado sin una prueba que mida el síntoma exacto. No afirmes
  entrega o producción sin comprobar que el candidato llegó a la rama/canal correcto y que
  el artefacto servido contiene el cambio; un commit aislado en un worktree no es entrega.

## Gate conservado como perfil de origen

Las copias de origen incluían este gate específico para el repositorio principal de la app:

1. check de tipos, lint completo, tests, build y build del subsistema de sync;
2. QA visual por cada estado nuevo cuando hay UI, incluyendo variantes de tema y tamaño;
3. revisión de código obligatoria sobre el mismo candidato;
4. después de un push autorizado, observar CI y comprobar que el job real de despliegue
   termina con éxito; un push no prueba producción.

También conservaban estos invariantes: no filtrar el lint si CI ejecuta el repositorio
completo; comprobar exit codes sin pipes que los oculten; y no llamar «en producción» a
un cambio cuando un filtro de paths evitó el workflow.

No ejecutes esa lista por reflejo en otro repo. Traduce «check/lint/test/build/sync» a los
comandos normativos del proyecto actual.

Otra fuente, más específica, exigía usar el script normativo del repo en vez de reenumerar
sus pasos y leer su veredicto explícito, no el exit code oculto por una tubería. Conserva
ambas formulaciones: si existe script de gate, el workflow decide si sustituye o compone los
checks individuales. En esa fuente el script histórico era `pnpm gate`
(`scripts/gate.sh`) y emitía `GATE VERDE`/`GATE ROJO`; son datos de procedencia, no una
orden para repositorios que no ofrezcan ese contrato.

## Contradicción de revisión todavía abierta

- **Variante A — revisión final**: ejecutar la revisión después de que el resto del gate
  esté verde.
- **Variante B — revisión paralela**: iniciar gate y revisión sobre el mismo SHA candidato;
  si aparece un must-fix, crear un candidato nuevo y repetir la evidencia necesaria.

Sigue `docs/WORKFLOW.md` o su equivalente si existe. Si el repo no decide, no borres ninguna
variante de la baseline: elige una para esa ejecución, documenta cuál y no mezcles evidencia
de SHAs distintos.

Si una pantalla requiere autenticación, usa el modo demo o la identidad de prueba que el
repositorio documente; «pide login» no convierte una comprobación visual posible en QA hecho.

## Canales de despliegue divergentes

Las fuentes contienen tres afirmaciones históricas incompatibles: despliegue por push a
`main`, despliegue manual separado del push y verificación del job de CI posterior al push.
También distinguen web y varios canales nativos. No elijas una de memoria: descubre el
workflow actual, identifica el canal pedido y demuestra ese canal por contenido/SHA. Esta
contradicción no se resuelve en la baseline por unión.

## Cierre y documentación

- Actualiza únicamente las superficies de documentación que el proyecto declare: estado
  vivo, changelog, notas de release o documentación humana externa.
- Mantén las tareas de desarrollo en Lumbre si ese es el sistema configurado. Un gestor
  externo puede reservarse para bloqueos no pertenecientes al proyecto, pero es un perfil
  opcional, no una regla pública.
- Separa estado del agente (`@done`) de aceptación del usuario y de despliegue confirmado.
- Entrega SHA/branch, árbol limpio o cambios pendientes, gates, revisión, remoto/CI,
  producción, bloqueos y siguiente acción cuando el riesgo lo justifique.

Una fuente define cuatro etiquetas de cierre: `GATE BASE VERDE`, `GATE UI VERDE`,
`GATE DOCS VERDE` y `GATE ROJO`/`BLOQUEADO`. Conserva esa precisión si el repo usa esas
categorías; no llames verde global a una prueba focal o a un gate que no incluye e2e.

## Landmines locales preservadas como forma

Las copias heredadas incluían fallos concretos del repositorio principal. No fijes versiones,
rutas personales ni fechas en la skill pública; descubre sus equivalentes vivos:

- usar la versión de Node exigida por el repo ante errores del runtime del gestor;
- evitar APIs de entorno que el bundler no soporte en código de sync/servidor;
- respetar las restricciones sintácticas del compilador Svelte vigente;
- usar la escala de z-index del sistema de diseño, no valores arbitrarios;
- proteger popovers frente a nodos desconectados y propagación del clic de apertura;
- volver a verificar mutaciones MCP eventualmente consistentes.

Estos puntos permanecen para la matriz de unión, pero el contrato actual del repositorio es
la fuente de verdad y debe decidir si siguen aplicando.
