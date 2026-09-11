# Prompt — Filtro Cliente → Contrato y buscador en Catálogo de conceptos (Costos)

**Estimado:** Claude Code + Sonnet 5, esfuerzo Medio (~2h, incluye Fase 0 diagnóstica)

```
Objective:
En Costos → Catálogo de conceptos, agregar un filtro en cascada (primero Cliente, luego Contrato/Obra dentro de ese cliente) y un buscador de texto libre, para que el usuario pueda acotar los 237+ conceptos cruzados entre obras a solo lo que necesita ver.

Starting State:
- Pantalla actual: selector "Cliente" (dropdown, default "Todos los clientes (global)"), botones "Exportar a Excel" y "Generar presupuesto con este catálogo", y tabla con columnas Código/Concepto/Grupo-Capítulo/Unidad/Precio unitario (más reciente)/Obra de origen/Fecha.
- No existe actualmente ningún filtro adicional por contrato/obra dentro de un cliente, ni buscador de texto.
- No se conoce aún si este módulo "Costos" pertenece al mismo repo/codebase que App-CP (PWA de Grupo Roforb) o es un panel distinto (posiblemente parte de NYRA como SaaS multi-cliente) — a confirmar en Fase 0.
- No se conoce el significado exacto de "contrato" en este contexto: podría referirse a la tabla `contratos` (1:1 con proyecto, solo PDF) o simplemente ser el término coloquial que usa Paul para "obra/proyecto" (la tabla ya muestra columna "Obra de origen") — a confirmar en Fase 0 antes de asumir.

Target State:

1. FASE 0 — DIAGNÓSTICO (obligatorio antes de codear):
   - Confirmar en qué repo/codebase vive esta pantalla "Costos" (¿mismo repo de App-CP, o proyecto separado?)
   - Confirmar si el selector "Cliente" actual filtra del lado del servidor (nueva query) o del lado del cliente (ya tiene los 237 conceptos cargados y solo oculta filas)
   - Confirmar qué significa "contrato" para este filtro: si la intención real es filtrar por obra/proyecto (columna "Obra de origen" ya visible en la tabla), usar esa entidad; si de verdad se requiere filtrar por la tabla `contratos` literal, reportarlo porque esa tabla no tiene relación directa con conceptos/precios
   - Reportar hallazgos antes de implementar

2. FILTRO EN CASCADA:
   - Selector "Cliente" (ya existe) — al cambiar, poblar el segundo selector "Contrato/Obra" solo con las obras de ese cliente (deshabilitado o "Todas las obras" cuando Cliente = "Todos los clientes")
   - Selector "Contrato/Obra" — al seleccionar una obra específica, la tabla muestra solo conceptos cuyo "Obra de origen" coincide
   - Ambos selectores combinables con el buscador de texto (punto 3)

3. BUSCADOR:
   - Campo de búsqueda de texto libre, filtra en tiempo real por Código o Concepto (case-insensitive, idealmente insensible a acentos)
   - Aplica en conjunto con los filtros de Cliente/Contrato, no de forma exclusiva
   - Sin resultados: mensaje claro ("No se encontraron conceptos que coincidan")

4. CONSISTENCIA CON EXPORTAR/GENERAR PRESUPUESTO:
   - Confirmar en Fase 0 si "Exportar a Excel" y "Generar presupuesto con este catálogo" deben respetar los filtros activos (exportar/generar solo lo filtrado) o siempre operan sobre el catálogo completo — recomendado: que respeten los filtros activos, para consistencia con lo que el usuario está viendo en pantalla

Allowed Actions:
- Modificar el componente de esta pantalla (frontend) para agregar los selectores y el buscador
- Si el filtro por Cliente ya es server-side, extender el endpoint correspondiente para aceptar parámetro de obra/contrato adicional
- Si es client-side, agregar la lógica de filtrado en el mismo lugar donde ya se filtra por Cliente

Forbidden Actions:
- NO modificar el cálculo de "precio unitario más reciente por código" ni la lógica de cruce entre obras — solo agregar capas de filtro sobre el resultado ya calculado
- NO tocar los botones "Exportar a Excel" / "Generar presupuesto con este catálogo" más allá de lo necesario para que respeten los filtros (si así se confirma en Fase 0)
- NO asumir que "contrato" = tabla `contratos` sin confirmarlo en Fase 0

Stop Conditions:
Pausar y reportar si:
- "Contrato" en este contexto no tiene una entidad clara en el modelo de datos (ni obra/proyecto ni tabla `contratos` calzan con lo que Paul quiere filtrar) — preguntar directamente en vez de asumir
- El catálogo cruzado de 237+ conceptos requiere una query nueva costosa cada vez que cambia el filtro (evaluar si conviene cachear del lado del cliente en vez de refetch constante)

Checkpoints:
✅ Fase 0 reportada con confirmación de repo, tipo de filtrado actual (server/client-side), y significado confirmado de "contrato"
✅ Filtro en cascada Cliente → Contrato/Obra funcional, verificado con al menos 2 clientes distintos (ej. VINTE, CALLI_DEZ)
✅ Buscador filtra correctamente por código y por texto de concepto, combinable con los filtros de cliente/obra
✅ Exportar/Generar presupuesto verificados con filtros activos, comportamiento confirmado según lo decidido en el punto 4
✅ Lista final de archivos modificados con resumen de cada cambio
```
