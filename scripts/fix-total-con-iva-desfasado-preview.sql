-- Correr manualmente en el Neon SQL Editor contra Preview (host
-- ep-noisy-shadow-atld9gx0), NUNCA contra `production` (host ep-divine-voice)
-- — mismo criterio que el resto de scripts/*-preview.sql.
--
-- CONTEXTO (prompt-fix-calcular-total-con-iva.md): meta.total_sin_iva se
-- refresca en cada "Actualizar presupuesto" (aplicarCambiosConceptos), pero
-- antes de este fix meta.total_con_iva/iva_importe solo se escribían una vez
-- en el alta original (extractMeta) y quedaban congelados en cada
-- actualización posterior. Este script detecta y corrige esa desincronía:
-- recalcula total_con_iva/iva_importe = total_sin_iva * (1 + iva_pct/100),
-- exactamente el mismo cálculo que ya aplica el código corregido.
--
-- EXCLUSIÓN DELIBERADA — project_id 13 ("715 URBANIZACION AMANI"): tiene un
-- desfase real y grande ($875,278.50), pero es el caso YA CONOCIDO y
-- documentado en server/calculos.js:65-77 (prompt-12-fix-totales-iva-
-- invertidos.md) — con_iva guardado ($1,876,426.39) es MENOR que sin_iva
-- ($2,372,159.39), el caso "imposible" que totalConIvaEsValido() ya detecta
-- y muestra como advertencia. Decisión explícita de Paul en ese prompt: "no
-- tocar el valor guardado" sin revisión manual — sigue aplicando aquí. Este
-- script solo corrige el caso NUEVO (con_iva plausible pero desactualizado,
-- ej. Amenidades: $683,874.42 guardado vs $684,367.59 real, ambos > sin_iva),
-- nunca el caso ya marcado como dato mal capturado.

-- ============================================================================
-- PASO 1 — Corre esto SOLO primero. Revisa qué proyectos tiene desfase y de
-- cuánto, antes de corregir nada.
-- ============================================================================
SELECT
  s.project_id, p.nombre,
  s.total_sin_iva, s.iva_pct,
  s.iva_importe_guardado, ROUND((s.total_sin_iva * (s.iva_pct/100))::numeric, 2) AS iva_importe_calculado,
  s.total_con_iva_guardado, ROUND((s.total_sin_iva + s.total_sin_iva * (s.iva_pct/100))::numeric, 2) AS total_con_iva_calculado,
  (s.total_con_iva_guardado >= s.total_sin_iva) AS es_caso_plausible -- false = caso "imposible" ya conocido, excluir
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
-- PASO 2 — Solo después de revisar el PASO 1. Corrige SOLO los casos
-- plausibles (con_iva_guardado >= sin_iva) — el caso "imposible" (project_id
-- 13, o cualquier otro que aparezca con es_caso_plausible=false) se excluye
-- automáticamente vía el WHERE, no hace falta excluirlo a mano cada vez.
-- Todo corre en una transacción — revisa el resultado DESPUÉS antes de hacer
-- COMMIT.
-- ============================================================================

BEGIN;

WITH afectados AS (
  SELECT
    m1.project_id,
    m1.valor::numeric AS total_sin_iva,
    m2.valor::numeric AS iva_pct
  FROM meta m1
  JOIN meta m2 ON m2.project_id = m1.project_id AND m2.clave = 'iva_pct'
  LEFT JOIN meta m3 ON m3.project_id = m1.project_id AND m3.clave = 'iva_importe'
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
