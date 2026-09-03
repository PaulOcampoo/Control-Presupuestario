-- SOLO LECTURA hasta el PASO 2. Correr manualmente en el Neon SQL Editor
-- contra `production` (host ep-divine-voice), NUNCA contra
-- ep-noisy-shadow-atld9gx0 (esa es Preview) — mismo criterio que el resto de
-- scripts/*-produccion.sql. Preparado por Claude Code, NO ejecutado contra
-- Producción (regla del proyecto: Paul lo corre él mismo).
--
-- Versión de Producción de scripts/fix-total-con-iva-desfasado-preview.sql —
-- MISMA lógica, ya verificada ahí (0 filas afectadas en Preview: los únicos
-- 2 proyectos reales de Kalia en Preview, 30 y 32, no tenían desfase porque
-- nunca se les corrió una actualización real desde el alta; el único
-- desfase real detectado en Preview, project_id 13, quedó correctamente
-- excluido por ser el caso "imposible" ya conocido — ver comentario abajo).
--
-- CONTEXTO (prompt-fix-calcular-total-con-iva.md): meta.total_sin_iva se
-- refresca en cada "Actualizar presupuesto" (aplicarCambiosConceptos), pero
-- antes de este fix meta.total_con_iva/iva_importe solo se escribían una vez
-- en el alta original (extractMeta) y quedaban congelados en cada
-- actualización posterior. Este script detecta y corrige esa desincronía:
-- recalcula total_con_iva/iva_importe = total_sin_iva * (1 + iva_pct/100),
-- exactamente el mismo cálculo que ya aplica el código corregido (ya
-- mergeado — a partir de la próxima "Actualizar presupuesto" de cada obra
-- esto se mantendría sincronizado solo; este script es solo para corregir
-- el histórico ya congelado).
--
-- EXCLUSIÓN DELIBERADA — cualquier proyecto donde con_iva guardado < sin_iva
-- (caso "imposible" que totalConIvaEsValido() ya detecta, server/
-- calculos.js:65-77, prompt-12-fix-totales-iva-invertidos.md): en Preview
-- ese caso era project_id 13 ("715 URBANIZACION AMANI"/VINTE) — confirma
-- primero si el mismo proyecto (o cualquier otro) también aparece así en
-- Producción con el PASO 1 antes de decidir. Ese es un dato mal capturado
-- que requiere revisión manual, decisión explícita de Paul en el prompt
-- original: "no tocar el valor guardado" sin confirmar antes. Este script
-- SOLO corrige el caso plausible-pero-desactualizado (con_iva > sin_iva,
-- solo el número está desfasado — ej. Amenidades, el caso real que motivó
-- este fix: $683,874.42 guardado vs $684,367.59 correcto).
--
-- project_id de "Amenidades" en Producción: NO CONFIRMADO — no existe en
-- Preview (no se pudo verificar ahí), así que el PASO 1 de abajo es
-- genérico (escanea TODOS los proyectos, no uno hardcodeado) — revisa el
-- resultado completo, no asumas cuál fila es Amenidades por nombre solo.

-- ============================================================================
-- PASO 1 — Corre esto SOLO primero. Revisa qué proyectos tienen desfase y de
-- cuánto, antes de corregir nada. Confirma en particular:
--   - Que "Amenidades" (o el nombre real de esa obra en Producción) aparece
--     con es_caso_plausible=true y el desfase esperado (~$493.17 en
--     total_con_iva, según lo reportado por Paul).
--   - Si aparece algún proyecto con es_caso_plausible=false, NO lo incluyas
--     en el PASO 2 sin decisión explícita de Paul (el PASO 2 ya lo excluye
--     automáticamente por el WHERE, pero igual revísalo aquí antes).
-- ============================================================================
SELECT
  s.project_id, p.nombre,
  s.total_sin_iva, s.iva_pct,
  s.iva_importe_guardado, ROUND((s.total_sin_iva * (s.iva_pct/100))::numeric, 2) AS iva_importe_calculado,
  s.total_con_iva_guardado, ROUND((s.total_sin_iva + s.total_sin_iva * (s.iva_pct/100))::numeric, 2) AS total_con_iva_calculado,
  (s.total_con_iva_guardado >= s.total_sin_iva) AS es_caso_plausible -- false = caso "imposible", excluir salvo decisión explícita
FROM (
  SELECT
    m1.project_id,
    m1.valor::numeric AS total_sin_iva,
    m2.valor::numeric AS iva_pct,
    m3.valor::numeric AS iva_importe_guardado,
    m4.valor::numeric AS total_con_iva_guardado
  FROM meta m1
  JOIN meta m2 ON m2.project_id = m1.project_id AND m2.clave = 'iva_pct'
  LEFT JOIN meta m3 ON m3.project_id = m1.project_id AND m3.clave = 'iva_importe'
  LEFT JOIN meta m4 ON m4.project_id = m1.project_id AND m4.clave = 'total_con_iva'
  WHERE m1.clave = 'total_sin_iva'
) s
JOIN proyectos p ON p.id = s.project_id
WHERE s.total_con_iva_guardado IS DISTINCT FROM ROUND((s.total_sin_iva + s.total_sin_iva * (s.iva_pct/100))::numeric, 2)
ORDER BY s.project_id;

-- ============================================================================
-- PASO 2 — Solo después de revisar el PASO 1 con Paul. Corrige SOLO los
-- casos plausibles (con_iva_guardado >= sin_iva) — el caso "imposible" se
-- excluye automáticamente vía el WHERE. Todo corre en una transacción —
-- revisa el resultado DESPUÉS antes de hacer COMMIT. NO ejecutar sin que
-- Paul lo corra él mismo.
-- ============================================================================

BEGIN;

WITH afectados AS (
  SELECT
    m1.project_id,
    m1.valor::numeric AS total_sin_iva,
    m2.valor::numeric AS iva_pct
  FROM meta m1
  JOIN meta m2 ON m2.project_id = m1.project_id AND m2.clave = 'iva_pct'
  LEFT JOIN meta m4 ON m4.project_id = m1.project_id AND m4.clave = 'total_con_iva'
  WHERE m1.clave = 'total_sin_iva'
    AND (m4.valor IS NULL OR m4.valor::numeric >= m1.valor::numeric) -- excluye el caso "imposible"
    AND m4.valor::numeric IS DISTINCT FROM ROUND((m1.valor::numeric + m1.valor::numeric * (m2.valor::numeric/100))::numeric, 2)
),
calc AS (
  SELECT
    project_id,
    ROUND((total_sin_iva * (iva_pct/100))::numeric, 2) AS iva_importe_nuevo,
    ROUND((total_sin_iva + total_sin_iva * (iva_pct/100))::numeric, 2) AS total_con_iva_nuevo
  FROM afectados
),
-- INSERT ... ON CONFLICT (no UPDATE plano): mismo patrón que ya usa el
-- código (aplicarCambiosConceptos) — si a algún proyecto le faltara la fila
-- iva_importe/total_con_iva en meta (nunca se escribió), un UPDATE plano no
-- haría nada; esto la crea si falta, la actualiza si ya existe.
filas AS (
  SELECT project_id, 'iva_importe' AS clave, iva_importe_nuevo::text AS valor FROM calc
  UNION ALL
  SELECT project_id, 'total_con_iva' AS clave, total_con_iva_nuevo::text AS valor FROM calc
)
INSERT INTO meta (project_id, clave, valor)
SELECT project_id, clave, valor FROM filas
ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor;

-- Verificación DESPUÉS: debe devolver 0 filas (ya no debe quedar ningún
-- proyecto plausible con desfase).
SELECT
  s.project_id, p.nombre, s.total_sin_iva, s.iva_pct,
  s.total_con_iva_guardado, ROUND((s.total_sin_iva + s.total_sin_iva * (s.iva_pct/100))::numeric, 2) AS total_con_iva_calculado
FROM (
  SELECT
    m1.project_id, m1.valor::numeric AS total_sin_iva, m2.valor::numeric AS iva_pct,
    m4.valor::numeric AS total_con_iva_guardado
  FROM meta m1
  JOIN meta m2 ON m2.project_id = m1.project_id AND m2.clave = 'iva_pct'
  LEFT JOIN meta m4 ON m4.project_id = m1.project_id AND m4.clave = 'total_con_iva'
  WHERE m1.clave = 'total_sin_iva'
) s
JOIN proyectos p ON p.id = s.project_id
WHERE s.total_con_iva_guardado >= s.total_sin_iva
  AND s.total_con_iva_guardado IS DISTINCT FROM ROUND((s.total_sin_iva + s.total_sin_iva * (s.iva_pct/100))::numeric, 2);

-- Revisa el resultado de arriba. Si devolvió 0 filas:
-- COMMIT;
-- Si algo no cuadra:
-- ROLLBACK;
