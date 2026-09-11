Objective:
Fase 0 (inventario + plan, sin implementar todavía): revisar todos los cambios mergeados a `main` de App-CP (Control-Presupuestario) en las últimas 2 semanas, clasificarlos entre "aplica a la demo" (fixes visuales, de UX, o de bugs genéricos) y "no aplica" (lógica específica de negocio real — Kalia, Grupo Roforb, datos financieros de clientes reales), y comparar contra el estado actual de App-CP-Demo para identificar qué ya tiene, qué le falta, y qué requeriría adaptación antes de portarlo.

Starting State:
- App-CP (repo real) tiene ~2 semanas de PRs mergeados a `main` cubriendo: fixes visuales (paleta de colores, contraste de links, glow de donut), features de negocio (archivar/completar clientes, backup diario, avance físico, fusión de Trabajadores/Nóminas, buscador en Requisiciones/OC, reasignar proveedor en OC, visibilidad y bloqueo de sobre-orden en OC, integridad del importador de matrices con 2 casos resueltos, vinculación de CFDI a pagos con vista de cierre mensual), y fixes de bugs (colisión de nombres de funciones, selector CSS de wrapper, permisos de admin en Maquinaria, emparejamiento de duplicados en actualización de presupuesto).
- App-CP-Demo es un repo separado, con datos ficticios, sin conexión a clientes reales — ya se confirmó en una sesión previa que carece de al menos una paleta (`Tema ZAFIRO`) que sí tiene App-CP.
- No asumir que esta lista de memoria es completa ni exacta — el primer paso de este prompt es obtener el registro real de `git log`/PRs de App-CP, no confiar en este resumen.

Target State:
1. INVENTARIO REAL DE APP-CP:
   - `git log --oneline` (o `gh pr list --state merged` con fecha) de App-CP, filtrado a las últimas 2 semanas — lista completa y real, no la de memoria de arriba.
   - Para cada PR/commit relevante, una línea de qué hace y si es (a) visual/UX genérico, (b) fix de bug genérico, o (c) lógica de negocio específica de clientes reales.

2. COMPARACIÓN CONTRA APP-CP-DEMO:
   - Para cada ítem categorizado como (a) o (b): revisar si App-CP-Demo ya lo tiene (puede haber sido portado manualmente antes) o le falta.
   - Para ítems (c): evaluar si existe una versión "genérica" que tendría sentido en la demo (ej. el concepto de "archivar cliente" sí podría aplicar a la demo aunque los datos reales de Kalia no), y marcarlos como "adaptar" en vez de "portar tal cual" o "no aplica", según corresponda.

3. PLAN DE IMPLEMENTACIÓN (sin ejecutar todavía):
   - Proponer un orden de lotes para portar los ítems aprobados — priorizar los visuales/UX primero (menor riesgo, mayor impacto en percepción de la demo), luego los fixes de bugs genéricos, y al final cualquier feature de negocio adaptada.
   - Para cada lote, estimar estamos hablando de cuántos archivos toca y complejidad relativa.

Allowed Actions:
- Leer `git log`, PRs, y código de ambos repos (App-CP y App-CP-Demo) si Claude Code tiene acceso a ambos en este entorno — si NO tiene acceso a uno de los 2, reportarlo explícitamente en vez de asumir o inventar contenido.
- Producir el documento de inventario + plan — NO implementar ni portar código todavía.

Forbidden Actions:
- NO implementar ningún cambio en App-CP-Demo todavía — esto es solo inventario y plan.
- NO portar datos ni lógica específica de clientes reales (Kalia, Grupo Roforb) a la demo bajo ninguna circunstancia, ni siquiera "de ejemplo" — la demo debe seguir siendo genérica.
- NO tocar App-CP (el repo real) en absoluto en este prompt.

Stop Conditions:
- Si Claude Code no tiene acceso al repo de App-CP-Demo desde este entorno (puede estar en otra carpeta/máquina) — reportarlo y detenerse, no inventar qué contiene basándose en suposiciones.

Checkpoints:
✅ Lista real y completa de cambios de las últimas 2 semanas en App-CP (no la de memoria del prompt).
✅ Clasificación (a)/(b)/(c) de cada uno.
✅ Comparación contra el estado real de App-CP-Demo, con evidencia (no asumido).
✅ Plan de lotes propuesto, con estimado de esfuerzo por lote.

Estimado: ~30-40 min con Claude Code (Sonnet 5, esfuerzo Medio) — depende del volumen real de cambios encontrado.
