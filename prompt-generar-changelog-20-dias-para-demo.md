Objective:
Generar un documento `.md` completo y detallado con todos los fixes y cambios reales de App-CP de los últimos 20 días (PRs mergeados a `main`), con el nivel de detalle técnico suficiente para que una sesión distinta de Claude Code (trabajando en el repo de App-CP-Demo) pueda leer este documento solo y aplicar cada cambio correctamente, sin necesitar volver a investigar desde cero.

Starting State:
- App-CP tiene ~20 días de PRs mergeados cubriendo: fixes visuales (paleta Zafiro + su fix de cache-busting, contraste de link 2FA, glow de donut), features de negocio (archivar/completar clientes, backup diario, avance físico, fusión de Trabajadores/Nóminas, buscador en Requisiciones/OC/Usuarios, reasignar proveedor en OC, visibilidad y bloqueo de sobre-orden en OC, integridad del importador de matrices con 2 casos resueltos, vinculación de CFDI a pagos con vista de cierre mensual), y fixes de bugs (colisión de nombres de funciones, selector CSS de wrapper, permisos de admin en Maquinaria, emparejamiento de duplicados en actualización de presupuesto, notificación de backup solo en runs reales).
- Ya existe un reporte previo de Fase 0 (sync App-CP → App-CP-Demo) que clasificó estos PRs por tipo (visual/UX, bug genérico, negocio real) y aplicabilidad a la demo — usar ese reporte como punto de partida si está disponible, pero verificar contra `git log`/PRs reales, no confiar solo en el resumen anterior.

Target State:
Generar `CAMBIOS-20-DIAS-PARA-DEMO.md` con, para cada PR/cambio relevante:
1. **Título y fecha** del PR.
2. **Qué problema resolvía** (1-2 líneas, en términos de comportamiento observable, no solo el nombre técnico).
3. **Causa raíz** (si fue un bug) o **diseño** (si fue una feature) — el "por qué" detrás del cambio, no solo el "qué".
4. **Archivos y funciones/líneas específicas tocadas** — lo suficientemente preciso para que alguien sin este contexto sepa exactamente dónde mirar en el código de la demo.
5. **Fragmento de código relevante** (antes/después, o solo el fix si es más claro) cuando el cambio sea puntual y corto — para los cambios grandes (features completas), describir la arquitectura en vez de pegar código completo.
6. **Clasificación de aplicabilidad a la demo**: (a) portar tal cual, (b) portar adaptado (quitar dependencia de datos reales de clientes), (c) no aplica (infraestructura real/datos de personas reales) — con una frase de por qué.
7. **Dependencias entre cambios** — si un fix requiere que otro ya esté aplicado antes (ej. el fix de cache-busting de Zafiro no tiene sentido sin que Zafiro ya exista).

Organizar el documento en el mismo orden cronológico en que se mergearon, agrupado por tema cuando varios PRs sean parte de la misma fase (ej. "OC por insumo: Fase 1A + Fase 2" juntos).

Allowed Actions:
- Leer `git log`, diffs reales de cada PR mergeado en las últimas 2-3 semanas de App-CP.
- Leer el reporte de Fase 0 ya existente (si aplica) como referencia, pero verificar contra el código real.
- Escribir el archivo `.md` — no tocar ningún código de App-CP.

Forbidden Actions:
- NO modificar código de App-CP.
- NO incluir datos reales de clientes/proveedores/montos como ejemplos en el documento — si hace falta un ejemplo, usar placeholders genéricos.
- NO inventar detalles de un PR que no se pueda verificar con el diff real — si algo no queda claro del historial, decirlo explícitamente en el documento en vez de rellenar con suposiciones.

Checkpoints:
✅ Documento `.md` generado, cubriendo todos los PRs reales de los últimos 20 días (lista verificada contra `git log`, no de memoria).
✅ Cada entrada tiene los 7 elementos pedidos (título, problema, causa/diseño, archivos, fragmento, aplicabilidad, dependencias).
✅ Organizado cronológicamente y agrupado por fase donde aplique.
✅ Ningún dato real de cliente incluido como ejemplo.

Estimado: ~30-40 min con Claude Code (Sonnet 5, esfuerzo Medio) — es documentación extensa, no código.
