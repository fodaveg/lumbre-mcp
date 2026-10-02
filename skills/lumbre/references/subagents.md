# Subagentes opcionales

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
`--replace-unmanaged` explícito.

En Claude, el prefijo de tools por defecto cubre los tres alias habituales del conector
(`mcp__lumbre__`, `mcp__claude_ai_Lumbre__` y `mcp__claude_ai_lumbre__`). Si el tuyo es
otro, repite `--claude-tool-prefix mcp__<alias>__` por cada prefijo real al migrar una
copia manual o cambiar aliases. Después el gestor conserva esa lista recuperándola de
sus propios ficheros; si las copias gestionadas discrepan, aborta sin elegir una.
