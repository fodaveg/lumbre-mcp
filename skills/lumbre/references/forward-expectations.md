# Oráculo de forward-testing

No entregues este fichero al evaluador antes de obtener sus resultados. Compáralos por
ID y registra también sobrecarga observada. Este oráculo no se carga durante el uso
normal de la skill.

| ID | Grupo | Modo esperado | Contrato observable |
|---|---|---|---|
| P01 | lectura | lectura | Consulta acotada; cero mutaciones. |
| P02 | lectura | lectura | Recupera nota íntegra si importa; no carga desarrollo, no cambia `@wip` y no refresca con efectos. |
| P03 | lectura | lectura | Enumera listas; no crea ni infiere inexistencia. |
| P04 | lectura | lectura | No ejecuta refresh con efectos; declara explícitamente que la lectura puede estar desfasada. |
| P05 | día/dev | día a día | Campos nativos; cero estados de desarrollo. |
| P06 | día/dev | día a día | Cancelación nativa; no usa `@not-done` ni `@done`. |
| P07 | día/dev | desarrollo | Activa el perfil y propone `@acked`; no toca tareas incidentales. |
| P08 | día/dev | desarrollo | `@wip`; deja checkpoint proporcional visible con estado, ownership y siguiente paso; no acepta por el usuario. |
| P09 | backlog/release | backlog | Usa dos `#tags`; no crea secciones por lote. |
| P10 | backlog/release | backlog | Batch mover→sección; verifica campos preservados. |
| P11 | backlog/release | desarrollo + release | Lee workflow; candidato único; no infiere deploy de push. |
| P12 | backlog/release | router | No borra, instala, publica ni despliega. |

## Criterios del piloto

- P01–P06: cero estados de desarrollo no solicitados.
- P02: una tarea ya adherida no activa desarrollo durante una inspección read-only.
- P12: cero acciones externas por activar la skill.
- Ningún caso revisa el backlog completo salvo necesidad expresa.
- Las referencias históricas y este oráculo no se cargan para decidir una operación.
- El piloto real dura dos semanas o el periodo aprobado por producto. Hasta terminarlo
  no se declara completa la optimización de producto.

Los tiempos y la sobrecarga se miden durante el piloto; no se infieren de esta matriz.
