# Inicio residente — Phase 0 (registro histórico)

La parada descrita abajo fue resuelta por la autorización posterior de Paul. [Implementación y verificación final](../verificacion-inicio-residente/README.md).

Rama fix/inicio-residente-accesos desde origin/main94ab477. PowerShell/Node24.15, Preview ep-noisy-shadow. No se modificó ningún archivo existente, sin commit de implementación ni push/PR/merge.

[Salida literal](salida-literal.txt) contiene HTML completo de Inicio, allowedTabs/secciones/sidebar, errores de consola/página, HTTP y limpieza. [Código literal con líneas](codigo-literal.txt) identifica las causas y el modelo.

Causa principal (a): public/styles.css:5076 oculta .ui-v2 .inicio-secciones. renderInicio public/app.js:5933 y6131–6138 genera este bloque, pero para residente no genera dashboard porque no tiene resumen. El HTML contiene secciones y su display computado es none. No hubo pageerror en ninguno de los10 escenarios. Hubo mensajes CSP de estilos de la app, incluidos en evidencia; no se afirma consola limpia. Los residentes no llamaron /resumen: el vacío no viene de403/500 de ese endpoint.

Fuente reutilizable: seccionesVisiblesParaRol y tabsVisiblesDeSeccion public/app.js:1861–1870, mismos SECTION_DEFS/state.allowedTabs/excepciones usados por sidebar public/app.js:2235–2255. No hace falta lista paralela.

Condición de parada ejecutada: un módulo que ofrece el modelo devuelve403. GET nav-tabs conserva ordenes por rol en server/app.js:1250–1259, aunque ordenes_compra.puede_ver=false. GET ordenes exige ese permiso en9353. El perfil solo_avance recibió [avance,ordenes], avance200 y ordenes403; el perfil ninguno recibió [ordenes] y ordenes403. Reproducido en Chromium1280 y WebKit390. No se puede cumplir fuente única + ningún403 + perfilesuno/ninguno sin resolver esta discrepancia fuera del alcance permitido.

Simulación: solo desarrollador puede usar startSimulation (public/app.js:1350); el intento admin dejó simulado=null y conservó widgets. Se añadió un desarrollador QA para comprobar la simulación real. El residente simulado también ve Inicio vacío, pero su lista estática ROLE_TABS difiere del residente típico real (por ejemplo, simulación incluye infraVivienda y omite Maquinaria/Almacén). actualizarNavPorObra omite simulación en4328, por diseño existente. No se cambió este comportamiento.

Fixtures propios QA_RESINICIO_1790813227160: cliente796, proyecto1387, residentes5334/5335/5336 y desarrollador5337. Borrados después de verificar nombres con marcador: usuarios0,proyectos0,clientes0. Todos los login fueron reales con backend local y DB Preview.

20 capturas y10 JSON locales en .claude/inicio-residente-phase0/{chromium,webkit}_{tipico,solo_avance,ninguno,admin_simulado,dev_simulado}_{dark,light}.png y JSON porperfil/motor. WebKit390 mostró mobileVisible=true; Chromium1280false. Revisadas a ojo: webkit_tipico_dark.png y chromium_ninguno_light.png. Otras no revisadas a ojo.

No ejecutado: implementación/estilos/CACHE, tests Vitest del fix, aislamiento500, tiles funcionando, comparación de admin antes/después, iPhone/Android reales. El script tests/inicio-residente-phase0.cjs es el diagnóstico reproducible; sus salidas no se presentan como tests del fix.

Para continuar Paul debe resolver la parada del prompt: autorizar una corrección acotada de la resolución de navegación de ordenes y definir el alcance de la divergencia de simulación. No se relajó ningún permiso del backend.
