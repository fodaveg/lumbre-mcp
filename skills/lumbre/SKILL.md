---
name: lumbre
description: >-
  Consulta y gestiona tareas, listas, triaje y flujos de desarrollo o release en
  Lumbre mediante su MCP. Úsala cuando el usuario pida leer o cambiar datos de
  Lumbre, organizar su backlog o emplearlo como gestor de tareas de un proyecto;
  el flujo @acked/@wip/@done es opcional y solo se activa para trabajo de desarrollo.
---

# Lumbre

Esta es la skill pública y global de Lumbre. Adapta el comportamiento al tipo de
trabajo en vez de imponer un único flujo. Usa el MCP de Lumbre configurado por el
cliente y respeta el alcance y las autorizaciones de la petición.

Esta revisión es una **baseline por unión previa a la optimización**. Conserva de
forma explícita variantes heredadas que todavía deben resolverse. No interpretes
la presencia de una variante como permiso para aplicarla fuera de su modo.

## Seleccionar el modo

Elige el modo menos mutante que satisfaga la petición. Si el usuario no ha pedido
un cambio, trabaja en lectura.

- **Lectura/consulta**: buscar, listar, resumir o inspeccionar sin modificar nada.
  Lee [references/read-and-daily.md](references/read-and-daily.md).
- **Día a día**: crear, editar, fechar, priorizar, completar o cancelar tareas con
  los campos nativos de Lumbre. Lee
  [references/read-and-daily.md](references/read-and-daily.md).
- **Triaje/backlog**: clasificar, agrupar, mover o reorganizar tareas, listas y
  secciones. Lee [references/backlog.md](references/backlog.md).
- **Desarrollo**: usar Lumbre como backlog de implementación con estados de agente,
  lotes, evidencia y checkpoints. Es **opt-in**: actívalo cuando el usuario lo pida,
  cuando una tarea ya use el flujo o cuando las reglas del repositorio lo exijan.
  Lee [references/development.md](references/development.md).
- **Proyecto/release**: integrar el seguimiento de Lumbre con las reglas, gates,
  documentación, git o despliegue de un repositorio. Lee primero las instrucciones
  del repositorio y después
  [references/project-release.md](references/project-release.md).

Una petición puede activar varios modos. Por ejemplo, implementar una tarea y
preparar su release activa desarrollo y proyecto/release; consultar qué hay hoy no.

## Reglas compartidas

1. Antes de operar, identifica la tarea o lista exacta. Si importa distinguir una
   lista vacía de una inexistente, enumera las listas antes de concluir.
2. Para reeditar contenido o notas, obtén primero la versión íntegra. No reconstruyas
   datos desde una representación truncada, enriquecida o anotada de display.
3. Conserva los campos no solicitados. En particular, omitir notas debe preservarlas;
   no envíes un valor vacío como sustituto de «sin cambios».
4. Agrupa operaciones compatibles cuando el MCP ofrezca una mutación batch.
5. Las mutaciones pueden ser asíncronas o eventualmente consistentes. Comprueba el
   resultado mediante la lectura/refresh apropiada antes de declararlo aplicado.
   Si el usuario prohíbe cambios y el refresh tiene efectos mutantes, no lo ejecutes.
6. Confirma inmediatamente antes de borrar o de ejecutar otra acción difícil de
   recuperar, salvo que la petición ya autorice de forma inequívoca ese objetivo.
7. Usa la autorización segura que proporcione el cliente. Nunca incrustes tokens en
   URLs, títulos, notas, logs ni documentación.
8. Las reglas del repositorio o proyecto prevalecen en gates, ownership, ramas,
   commits, documentación y despliegue. La skill no concede autoridad adicional.

Para la mecánica detallada y los límites de las herramientas, lee
[references/mcp-safe-operations.md](references/mcp-safe-operations.md) antes de una
mutación no trivial.

## Variantes heredadas pendientes

La unión conserva contradicciones sobre cuándo aplicar `@acked`, cuándo ejecutar la
revisión de código y cuánto automatizar entre lotes. Si una regla de proyecto resuelve
el punto, síguela. Si no, elige la variante menos mutante y deja constancia de la
ambigüedad en la respuesta o checkpoint ya autorizado; no crees otra mutación para
registrarla ni combines variantes incompatibles como si fueran una sola política.

Lee [references/source-variants.md](references/source-variants.md) al activar el modo
desarrollo o proyecto/release hasta que termine la fase de optimización.
