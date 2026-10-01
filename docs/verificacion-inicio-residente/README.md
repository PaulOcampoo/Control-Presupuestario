# Inicio residente: accesos y navegación restrictiva

Rama local `fix/inicio-residente-accesos`, base `origin/main 94ab477`. PowerShell, backend local, login real y base Preview `ep-noisy-shadow`. Sin push, PR, merge ni Producción.

El [diagnóstico previo](../verificacion-inicio-residente-phase0/README.md) se conserva como registro histórico de la parada. Paul autorizó posteriormente la corrección restrictiva de nav-tabs y la alineación visual de simulación.

Archivos existentes modificados (cuatro, uno de backend):
- public/app.js: accesos de Inicio desde seccionesVisiblesParaRol/tabsVisiblesDeSeccion y excepciones del sidebar; tarjeta vacía; aislamiento individual de widgets y del endpoint común; simulación residente alineada al perfil real típico. El preset del editor de permisos conserva su resultado original (test comparativo).
- public/styles.css: únicamente clases nuevas del bloque. La regla .ui-v2 .inicio-secciones { display: none; } permanece: el bloque nuevo reemplaza esas secciones cuando no hay widgets; con widgets se conserva el HTML previo.
- server/app.js: solo nav-tabs y helper tabTieneLectura. Filtra la lista anterior usando auth.tienePermiso, la misma comprobación usada por checkPermiso. Los endpoints globales usan contexto sin obra; Almacén permite la sección de entradas o salidas. No cambia auth.allow/checkPermiso, TAB_A_SECCION, endpoints ni permisos existentes.
- public/sw.js: CACHE v552 → v556; máximo histórico git log --all antes del commit: v555.

Evidencia literal:
- [Regresión contra el handler de origin/main](nav-origin-red.txt): dos fallos esperados, ninguno recibe ordenes y solo-avance recibe avance/ordenes. Se compiló git show origin/main:server/app.js en memoria; no se reemplazó el código del worktree.
- [Vitest corregido](tests-green.txt): perfiles típico, un módulo y ninguno; HTTP por módulo; diffs admin/desarrollador; permisos globales vs específicos de obra; HTML/estado vacío/excepciones y preset sin ampliación.
- [Playwright](ui.txt): Chromium1280 y WebKit390; tabs, tiles y sidebar; clics reales y respuestas HTTP; simulación vs residente real; métricas de contraste, tamaño, columnas y safe-area; widgets parciales y HTTP500; comparación PNG byte a byte del Inicio admin/desarrollador contra origin/main, dark/light.
- [Diff literal](diff.patch): cuatro archivos existentes.

Las capturas del Inicio de admin/desarrollador comparan #view. El origen se sirve interceptando app.js/styles.css obtenidos con git show, con el mismo usuario/proyecto/datos de Preview. Los dos roles conservan el mismo endpoint y tabs. No se modifican sidebar, topbar, barra inferior ni selección de obra.

Límite de la comprobación de HTTP: los endpoints de lectura que abren los módulos ofrecidos devuelven 200. Existe un 403 auxiliar preexistente al cargar Catálogo de maquinaria: GET /api/maquinaria/operadores exige maquinaria.puede_editar, mientras GET /api/maquinaria/equipos exige puede_ver y devuelve200. El frontend existente captura ese 403 con .catch(() => []); el módulo de lectura funciona. Se conserva la evidencia literal; no se afirma que todas las peticiones secundarias sean200 ni se amplía el permiso de edición.

La simulación es por rol, con los permisos típicos comprobados del residente; no simula permisos personalizados de un usuario concreto. Los perfiles solo-avance y ninguno se verifican mediante usuarios reales.

Los errores globales de consola/CSP preexistentes se conservan en los logs. El bloque nuevo no genera atributos style inline. No se afirma consola absolutamente limpia.

Pendiente: dispositivos físicos iPhone/iOS Safari y Android; comportamiento instalado de PWA/cache; datos y operación reales en Producción. No se ejecutó la suite completa ni los tres tests ajenos excluidos por el prompt.

Resultado ejecutado: Vitest 11 passed (2 files). Recorrido completo en ambos motores; ocho comparaciones PNG idénticas; foco visible solid/3px; objetivos mínimos76px; contraste14.9226:1 dark y16.4833:1 light. WebKit390: dos columnas y barra visible;640: tres columnas. Sin scroll horizontal. [Auditoría de fixtures](limpieza.txt): ambos prefijos QA con usuarios0/proyectos0/clientes0.

[Capturas](capturas):28 PNG. Revisadas a ojo las actuales chromium_tipico_dark, webkit_tipico_light, webkit_ninguno_dark, webkit_solo_dark y chromium_admin_dark_actual. Las restantes se comprobaron mediante métricas o comparación automática, sin revisión visual manual.

Reproducir: `npx vitest run tests/inicio-accesos.test.js tests/nav-tabs-restrictivo.test.js --reporter=verbose`; `node --env-file=.env tests/inicio-accesos-playwright.cjs`. Para reproducir únicamente los dos fallos de origin/main, usar QA_NAV_BASELINE=1 y filtrar los tests residente sin permisos/residente solo avance (PowerShell: variable de entorno temporal). Los scripts guardan fixtures propios con marcador y los limpian al finalizar.

Revisión independiente: las dos observaciones importantes (contexto global Proveedores/Cumplimiento y aislamiento individual) se corrigieron; sin observaciones importantes pendientes.
