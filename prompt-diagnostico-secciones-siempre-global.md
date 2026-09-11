Objective:
Diagnóstico previo (sin código funcional) para confirmar si el bug encontrado hoy en `maquinaria_*` (permiso guardado con `proyecto_id` de una obra específica en vez de `NULL`, invisible para endpoints globales por faltar en `SECCIONES_SIEMPRE_GLOBAL`) se repite en otras secciones — específicamente `avance`, `insumos`, y cualquier otra sección cuyo endpoint real sea global/cross-obra pero no esté en esa lista. Podría explicar 5 sugerencias de usuarios reportadas entre julio y agosto, todas con el mismo síntoma: "le di el permiso en la matriz y no se refleja."

Starting State:
- Bug ya confirmado y corregido para las 6 secciones `maquinaria_*` en PR #193 — causa raíz: `SECCIONES_SIEMPRE_GLOBAL` (public/app.js) es la lista que fuerza a que ciertas secciones se guarden siempre con `proyecto_id=NULL` en la matriz de permisos, sin importar qué obra estuviera seleccionada en el dropdown al momento de otorgar el permiso. Si una sección falta en esa lista pero su endpoint real es global (sin `/projects/:id/` en la ruta), un permiso otorgado con una obra específica seleccionada queda invisible para ese endpoint.
- Sugerencias de usuarios con el síntoma exacto ("otorgué el permiso, no se refleja"): Efren Monico/nóminas (23 jul), Rodolfo/avance+programa (13 jul), Raúl Méndez/insumos ×2 (13 jul), Raúl Méndez confirmando que "ya fueron autorizados y siguen sin verse" (13 jul).
- El bug es viejo (desde antes de julio, según las fechas de las sugerencias) — mucho más antiguo que el hallazgo de hoy en maquinaria.

Target State (solo investigación, reportar en texto/markdown — tabla comparativa):

1. Listar TODAS las secciones que existen hoy en `SECCIONES_PERMISOS` (o el catálogo equivalente).
2. Para cada una, determinar: ¿su endpoint(s) real en el backend es global (sin scope de proyecto en la ruta, ej. `GET /api/avance-por-cliente` o similar) o está scoped por obra (`/api/projects/:id/...`)?
3. Cruzar contra `SECCIONES_SIEMPRE_GLOBAL`: ¿las secciones con endpoint global están efectivamente en esa lista? Marcar cada desalineación encontrada — son candidatas al mismo bug.
4. Para las secciones marcadas como sospechosas (especialmente `avance`, `insumos`, `nominas` si no fue cubierta ya por otro fix, `programa` si existe como sección separada), confirmar con una prueba directa (otorgar el permiso con una obra específica seleccionada en el matriz vía UI o simulando la escritura, y verificar si el endpoint real lo reconoce) — no asumir solo por inspección de código, replicar el bug real como se hizo con maquinaria.
5. Reportar en tabla: Sección | Endpoint real (global/scoped) | ¿Está en SECCIONES_SIEMPRE_GLOBAL? | ¿Reproduce el bug? | ¿Coincide con alguna de las 5 sugerencias?
6. No proponer el fix todavía — solo el diagnóstico, para decidir alcance antes de tocar código (podría ser un fix de una lista, o podría revelar que varias secciones tienen un problema más profundo).

Allowed Actions:
- Leer public/app.js (`SECCIONES_PERMISOS`, `SECCIONES_SIEMPRE_GLOBAL`), server/app.js (todos los endpoints y sus rutas).
- Reproducir el bug en Preview otorgando permisos de prueba con una obra específica seleccionada, y verificando si el endpoint real los reconoce — sin dejar datos de prueba sin limpiar.
- Reportar en texto/markdown con la tabla comparativa como entregable principal.

Forbidden Actions:
- NO modificar SECCIONES_SIEMPRE_GLOBAL ni ningún archivo de código todavía — esto es diagnóstico puro.
- NO tocar producción bajo ninguna circunstancia.
- NO dejar datos de prueba sin limpiar en Preview.
