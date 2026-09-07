# Índice — Cambios de los últimos 20 días de App-CP para portar a App-CP-Demo

Generado a partir de `git log`/diffs reales de App-CP (Control-Presupuestario), rama `main`,
PRs mergeados entre **2026-08-18 y 2026-09-07** (74 entradas: 73 PRs mergeados + 1 feature sin
PR propio + 1 PR abierto sin mergear documentado por su relevancia directa). Cubre el alcance
completo de 20 días, no solo el subconjunto que mencionaba el prompt original (esa lista estaba
mal calibrada — copiada de un prompt anterior sobre "2 semanas").

Cada uno de los 9 archivos fue escrito por un agente distinto, cada uno verificando el diff real
de sus PRs asignados (no solo el título/nombre de rama). Este índice NO repite el contenido de
cada entrada — para el detalle completo (título, problema, causa raíz/diseño, archivos tocados,
fragmento de código, clasificación de aplicabilidad, dependencias) ir al archivo de módulo
correspondiente.

## Cómo usar este changelog si trabajas en App-CP-Demo

1. Lee primero la sección **"Correcciones y hallazgos cruzados"** de este índice — hay PRs
   mal encasillados en el módulo "equivocado" (documentados ahí de todas formas, por instrucción,
   pero hay que saber dónde buscarlos) y al menos un caso de un PR que resultó no aportar nada
   funcional propio.
2. Ve al archivo del módulo que te interesa portar.
3. Respeta el orden de **Dependencias** que cada entrada declara — varios PRs no tienen sentido
   aplicados solos (ver especialmente la saga Zafiro en el módulo 09).
4. Ningún archivo contiene nombres reales de clientes/proveedores/personas ni montos reales —
   donde hiciera falta un ejemplo, se usaron placeholders genéricos. Dos casos detectados y
   redactados por los agentes: un nombre de cliente real en comentarios/fixtures (módulo 02) y
   un id de usuario real hardcodeado en un gate de permisos (módulo 07) — ambos ya anonimizados
   en los archivos, pero si portas el código real desde App-CP directamente (no desde estos
   archivos), revisa tú mismo esos 2 puntos antes de copiar.

## Módulos

| # | Archivo | Módulo | PRs cubiertos | Rango de fechas |
|---|---------|--------|----------------|------------------|
| 1 | [01-clientes-galeria-avance.md](01-clientes-galeria-avance.md) | Clientes, Galería y Avance de Obra | #151, #152, #167, #168, #172, #201, #203 | 2026-08-18 → 09-02 |
| 2 | [02-costos-fondo-garantia.md](02-costos-fondo-garantia.md) | Sección de Costos, Fondo de Garantía y Finanzas de Maquinaria | #153, #154, #155, #159, #161, #162, #163, #171, #192, #198, #199 | 2026-08-18 → 09-01 |
| 3 | [03-nomina-maquinaria.md](03-nomina-maquinaria.md) | Nómina y Maquinaria | #156, #160, #164, #173, #175, #193, #194, #195, #205, #206, #212 | 2026-08-18 → 09-04 |
| 4 | [04-oc-requisiciones.md](04-oc-requisiciones.md) | Órdenes de Compra y Requisiciones | #157, #207, #209, #210, #211, #214 | 2026-08-18 → 09-04 |
| 5 | [05-catalogo-maestro-matrices.md](05-catalogo-maestro-matrices.md) | Catálogo Maestro y Matrices de Destajo | #165, #166, #176, #177, #178, #179, #180, #181, #182, #183, #184, #213, #215 | 2026-08-19 → 09-04 |
| 6 | [06-ventas.md](06-ventas.md) | Ventas (Catálogo Comercial, Contrato, Cobranza, Entregas) | #186, #187, #188, #189, #190 | 2026-08-25 → 08-26 |
| 7 | [07-sugerencias-notificaciones.md](07-sugerencias-notificaciones.md) | Sugerencias y Notificaciones | #191, #196, #197 | 2026-08-28 → 08-29 |
| 8 | [08-financiero-cfdi-backup.md](08-financiero-cfdi-backup.md) | Financiero: IVA, Acceso, CFDI, Cierre Mensual y Backup | #158, #202, #204, #216, #217, #218, #222 | 2026-08-19 → 09-06 |
| 9 | [09-visual-ux-infra-cache.md](09-visual-ux-infra-cache.md) | Visual/UX, Permisos Varios, Infraestructura y Cache (incluye la saga completa de la paleta Zafiro) | #169, #170, #174, #185, #200, #208, #219, #221, #223, #224, #225 (abierto) + feature Zafiro sin PR propio | 2026-08-20 → 09-07 |

73 PRs mergeados + 1 feature sin PR propio (Zafiro, bundleada en #218) + 1 PR abierto/pendiente
(#225) = 75 entradas de código distintas documentadas en total a lo largo de los 9 archivos.

## Correcciones y hallazgos cruzados (detectados por los agentes al verificar contra el diff real)

- **PR #151** (`feat/responsable-diario-equipo-menor`) quedó asignado al módulo 1
  (Clientes/Galería) por el nombre de rama, pero su diff real es 100% Maquinaria. Está
  documentado en `01-clientes-galeria-avance.md` (no se duplicó en el módulo 3) — si buscas todo
  lo de Maquinaria, no te olvides de revisar también el archivo 01 para este PR puntual.
- **PR #206** (`fix/rename-registrar-pago-modal`) quedó asignado al módulo 3 (Nómina/Maquinaria)
  pero es en realidad un fix de colisión de nombres de función en el flujo de Cobranza/OC.
  Documentado en `03-nomina-maquinaria.md`, con la discrepancia anotada ahí mismo.
- **PR #209** (`feat/zona-carga-archivos-lote1`) está en el módulo 4 (OC/Requisiciones) pero es
  en realidad un componente genérico de carga de archivos por drag-and-drop, aplicado a los
  flujos de presupuesto/contrato — no específico de OC. Ver nota en `04-oc-requisiciones.md`.
- **PR #170 vs #174**: ambos tocan visibilidad/bypass del rol "desarrollador" sobre
  clientes/proyectos. Según el módulo 9, #174 encontró que el mismo bug (IDOR en
  `verificarAccesoObra`) era más viejo y más amplio de lo que #170 había corregido — **no portar
  #170 solo; portar el estado final que deja #174**.
- **PR #217 vs #218**: ambos son merges de la misma rama `feature/fase2-cierre-mensual-pagos-oc`.
  Confirmado con `git log` en 2 módulos distintos (08 y 09) que **todo el trabajo real de cierre
  mensual está en #217** — el único contenido nuevo que aporta el merge de #218 es un commit
  completamente ajeno (la paleta Zafiro, ver abajo). Si vas a portar "cierre mensual de pagos de
  OC", con #217 alcanza.
- **Paleta Zafiro — 4 piezas que deben portarse juntas como una sola unidad atómica** (todas en
  `09-visual-ux-infra-cache.md`):
  1. Commit `ea52371` (sin PR propio, colado dentro del merge de PR #218): agrega la 5ª paleta
     "Tema ZAFIRO".
  2. PR #223: intento de arreglar que Zafiro no se veía en producción vía
     `Vercel-CDN-Cache-Control: no-store` — **documentado explícitamente como que NO funcionó**
     (evidencia real: `X-Vercel-Cache` seguía en `HIT` con `Age` creciendo). No portar esperando
     que resuelva nada.
  3. PR #224: el fix real — hash-busting de contenido (`app.<hash>.js`/`styles.<hash>.css`)
     generado solo en el `buildCommand` de Vercel.
  4. PR #225 (abierto, **todavía sin mergear** al momento de escribir este changelog): con el
     cache ya resuelto, Zafiro seguía sin aparecer en 2 de las 3 superficies de UI reales
     (`#galleryDrawer` y `#userPopover` en `index.html`, HTML estático nunca actualizado) — el fix
     agrega el botón faltante ahí.
  Sin las 4 piezas completas, portar cualquier subconjunto deja Zafiro visualmente roto o
  invisible en la demo.
- **Metodología de verificación** (para quien continúe este trabajo): varios agentes reportaron
  que diffear un merge commit como `git diff <merge>^1 <merge>^2` puede mostrar cambios
  engañosos (reverts falsos de features no relacionadas) cuando la rama del PR se creó antes de
  que otros PRs se mergearan a `main`. La técnica que usaron para corregirlo: `git diff
  $(git merge-base <merge>^1 <merge>^2) <merge>^2`, o directamente `git show` sobre el commit
  puntual cuando el PR es de un solo commit. Afectó a PRs #152, #157, #159, #160, #205 — ya
  corregido en los archivos correspondientes, pero queda anotado por si hace falta re-verificar
  algo.

## Orden sugerido para portar a la demo

Siguiendo el mismo criterio que ya proponía el prompt original de Fase 0 (menor riesgo y mayor
impacto de percepción primero):

1. **Visual/UX genérico primero** (módulo 09, excluyendo los PRs de permisos/infra de ese mismo
   archivo): checkbox circular, contraste del link de 2FA, scroll lateral de tablas, color del
   donut, selector de wrapper del botón confirmar, buscador de usuarios, y la saga completa de
   Zafiro (las 4 piezas juntas).
2. **Fixes de bugs genéricos** (aplican independientemente de si la demo tiene datos reales o
   no): #174 (IDOR de visibilidad, en vez de #170 solo), #198 (total inflado de presupuesto — motor
   de cálculo, no dato específico), #158 (saldo de IVA), #207 (emparejamiento de duplicados),
   #183 (distribución de destajo), #178 (parser de destajo).
2. **Features de negocio genéricas, adaptables sin datos reales**: sección de Costos (#161) y su
   cadena de fixes, Catálogo Maestro (#182) y su normalizador (#184), importador de Matrices
   (#166) y sus casos (#213, #215), Fondo de Garantía (#154), buscadores (#210, #221),
   reasignar proveedor en OC (#211), archivar/completar clientes (#203), avance físico (#201).
3. **No aplica / requiere decisión explícita antes de tocar**: todo el módulo de Ventas (06 —
   dominio de negocio específico de venta de vivienda, salvo los 2 patrones de ingeniería
   reusables que señala ese archivo), backup diario y su notificación (08 — infraestructura real
   contra Neon/Vercel Blob), alta de usuario real en whitelists (#202), y el feature base de
   Sugerencias si la demo no lo tiene ya (ver nota al inicio de `07-sugerencias-notificaciones.md`).

Cada archivo de módulo tiene el detalle PR-por-PR con su propia clasificación (a)/(b)/(c) y el
razonamiento — este orden es solo una guía de arranque, no reemplaza revisar cada entrada.
