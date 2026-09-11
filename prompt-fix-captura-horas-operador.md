Objective:
Corregir dos bugs reportados por un usuario operador en la captura de reportes de horas (Maquinaria): (1) no se puede borrar/corregir lo ya escrito en los campos de fecha/hora, y (2) el selector de área de trabajo no permite elegir más de una opción cuando el operador trabajó en varias áreas el mismo día.

Starting State (diagnóstico primero, antes de codificar):
- Ubicar el formulario exacto de captura de horas de operador en Maquinaria (public/app.js) — confirmar qué componente maneja los campos de fecha/hora (¿input nativo, máscara custom, librería?) y el selector de área de trabajo (¿select simple, checkboxes?).
- Reproducir el bug 1: escribir una fecha/hora y luego intentar borrar con Backspace/Delete — documentar exactamente qué lo bloquea (¿un listener de keydown que intercepta la tecla? ¿una máscara que reescribe el valor completo en cada evento?).
- Confirmar cómo se almacena hoy "área de trabajo" en la base de datos (¿columna de texto único, no array?) — esto decide si el fix 2 es solo de UI o requiere cambio de schema.

Target State:
1. Fecha/hora: el usuario debe poder borrar caracteres normalmente (Backspace/Delete) para corregir un error de captura, sin perder el resto del valor ni comportarse de forma inesperada. Si hay una máscara de formato, debe permitir edición parcial, no solo escritura hacia adelante.
2. Área de trabajo: permitir seleccionar más de una opción cuando el trabajo del día cubrió varias áreas. Si el campo hoy es de un solo valor en DB, proponer y aplicar el cambio mínimo necesario (ej. columna de array, o tabla puente si ya existe un patrón similar en el proyecto) — usar el mismo criterio de tablas ya usado en otros módulos de captura N:N si aplica.
3. Verificar que el cambio no rompe reportes/exports existentes que lean "área de trabajo" como valor único — si algo más consume ese campo, adaptarlo o reportarlo como Stop Condition antes de proceder.

Allowed Actions:
- Modificar el componente de captura de fecha/hora en public/app.js.
- Modificar el selector de área de trabajo (UI) y, si hace falta, el schema (server/db.js) y el endpoint que guarda el reporte de horas.
- Bumpear SW_VERSION.
- Agregar tests que cubran: edición/borrado en el campo de fecha/hora, guardado con múltiples áreas de trabajo, y que reportes/exports existentes sigan funcionando.

Forbidden Actions:
- NO reescribir el componente de fecha/hora desde cero si el fix es puntual (ej. ajustar el listener que bloquea el borrado) — cambiar lo mínimo necesario.
- NO romper la captura de reportes ya existentes con una sola área de trabajo — debe seguir funcionando igual para el caso simple.

Stop Conditions:
- Si el cambio de "área de trabajo" a selección múltiple afecta reportes, exports, o cálculos ya existentes que asumen un solo valor, pausar y confirmar el alcance del ajuste antes de tocar esos otros lugares.
- Si el campo de fecha/hora usa una librería externa con un bug conocido de esa librería (no del código propio), pausar y reportar antes de decidir si se reemplaza la librería o se parcha localmente.

Checkpoints:
✅ Diagnóstico de ambos componentes documentado (qué los causaba).
✅ Prueba de edición/borrado en fecha/hora — captura o descripción confirmando que funciona.
✅ Prueba de selección múltiple de área de trabajo, con verificación de que se guarda correctamente.
✅ Confirmación de que ningún reporte/export existente se rompió.
✅ SW_VERSION bumpeado.
✅ Verificación visual tuya en dispositivo real — idealmente con el mismo usuario/rol operador que reportó el bug.
✅ Limpieza de datos de prueba verificada.

Estimado de ejecución (Claude Code + Sonnet 5, esfuerzo Medio): 2–3.5 horas (depende de si el fix de área de trabajo requiere cambio de schema).
