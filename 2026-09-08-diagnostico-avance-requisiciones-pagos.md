# Fase 0 — Diagnóstico: Avance sobre-presupuesto, corrección de requisición y pagos múltiples

Objective:
Diagnosticar (sin implementar todavía) tres hallazgos reportados en producción de App-CP: (A) el módulo de Avance permite capturar más cantidad de la presupuestada sin ningún candado; (B) el modal de corrección de requisición no persiste el cambio al guardar; (C) el flujo de pagos permite registrar múltiples pagos cuando debería permitir solo uno, y no existe forma de revertir un pago capturado por error. Para cada uno, identificar la causa raíz exacta (archivo, línea, función) antes de proponer cualquier fix.

Starting State:
- Evidencia visual (capturas de pantalla de producción):
  - Avance: modal "Avance físico por concepto — Semana 2", capturando cantidad ejecutada de "SUB TRAZO Y NIVELACION PARA INSTALACION TUBERIAS" (presup. 55 ML) y el sistema acepta 43 ML adicionales llegando a 86 ML acumulado = 156.4% del presupuesto, sin bloqueo ni advertencia. Mismo comportamiento en "SUM Y COL TUBO PVC HIDRAULICO RD 13.5" (26 M presupuestados, acumulado 40 M = 153.8%)
  - Requisiciones: modal "corrección" sobre una requisición ya autorizada (cambiar insumo/cantidad/precio con justificación obligatoria), botón "Guardar corrección" — al usarlo, el cambio no se refleja después (no se sabe aún si es error de UI, de red, o de que el backend no persiste)
  - Pagos: módulo no capturado en imagen, pero reportado que permite registrar múltiples pagos sobre el mismo concepto/registro cuando el negocio requiere solo uno, y no hay ninguna acción de reversión para un pago capturado por error
- No se conoce todavía en qué archivos/funciones viven estos tres flujos — parte de este Fase 0 es localizarlos
- Contexto de la app: Node.js/Express + PostgreSQL (Neon), frontend vanilla JS/CSS, arquitectura de archivo único (`server/app.js`, `server/auth.js`, `public/app.js`)
- Regla de datos ya establecida en el proyecto: no hay borrado físico de registros financieros, solo soft-delete (`activo=0`, `baja`, etc.) — cualquier mecanismo de reversión de pago debe respetar esto, no debe ser un DELETE físico

Target State:

1. PROMPT A — AVANCE SIN CANDADO DE PRESUPUESTO:
   - Localizar el endpoint que recibe "Ejecutado este periodo" del modal de Avance por concepto (buscar en `server/app.js` la ruta que actualiza avance semanal por concepto)
   - Confirmar si existe alguna validación de `acumulado_previo + ejecutado_este_periodo <= cantidad_presupuestada` en backend o si la validación es inexistente en ambos lados
   - Confirmar si el frontend (`public/app.js`) muestra el % de avance ya sobregirado (156.4%, 153.8%) como dato meramente informativo o si en algún punto sí impide el guardado
   - Reportar: ¿el candado debe ser un hard block (no permite guardar si excede) o un soft warning (permite guardar con confirmación explícita)? — esto requiere decisión de negocio, documentar como pregunta abierta, no asumir

2. PROMPT B — CORRECCIÓN DE REQUISICIÓN NO GUARDA:
   - Localizar el endpoint al que llama el botón "Guardar corrección" (buscar en `public/app.js` el handler del modal de corrección de requisición, y su endpoint correspondiente en `server/app.js`)
   - Reproducir el flujo: enviar una corrección de ejemplo (cambio de precio unitario o justificación) y capturar la respuesta HTTP real (status code, body) — no asumir que es un problema de frontend sin confirmar
   - Revisar si el error es: (a) el frontend no envía el request, (b) el backend responde error y no se muestra al usuario, (c) el backend responde 200 pero no ejecuta el UPDATE, o (d) el UPDATE se ejecuta pero contra el registro equivocado
   - Reportar la causa raíz exacta con evidencia literal (output de terminal/HTTP), no resumen en prosa

3. PROMPT C — PAGOS MÚLTIPLES Y SIN REVERSIÓN:
   - Localizar el modelo de datos y endpoints de registro de pagos (buscar tabla de pagos en `server/db.js` y endpoints POST relacionados en `server/app.js`)
   - Confirmar si existe alguna restricción de unicidad (a nivel de UI, de backend, o de constraint en base de datos) que debería limitar a un solo pago por registro/concepto, y por qué no está aplicándose
   - Evaluar si "un solo pago" significa un solo pago por registro completo, o un pago que puede editarse pero no duplicarse — esto es una pregunta de negocio, documentar como pregunta abierta, no asumir
   - Para la reversión: identificar si ya existe algún patrón de soft-delete/reversión en módulos similares (ej. `softDeleteCombustible()`/`softDeleteMantenimiento()` en `server/maquinaria.js`, según patrón ya usado en Maquinaria) que pueda replicarse para pagos, respetando la regla de no borrado físico de registros financieros
   - Reportar qué endpoint(s) nuevo(s) harían falta y si requieren checkPermiso() adicional

Allowed Actions:
- Leer código con `git show` / `git archive` desde historial commiteado (nunca leer el working tree de producción directamente)
- Ejecutar consultas SQL de solo lectura (SELECT) contra Preview para verificar datos, nunca contra Producción
- Hacer requests de prueba contra Preview (no Producción) para reproducir el bug de Prompt B

Forbidden Actions:
- NO implementar ningún fix todavía — este es un prompt de diagnóstico únicamente
- NO ejecutar ningún UPDATE/DELETE/INSERT en Preview ni Producción
- NO asumir la causa raíz sin evidencia literal (output real de terminal/HTTP/SQL)
- NO tocar Producción de ninguna forma

Stop Conditions:
Pausar y pedir revisión cuando:
- El diagnóstico de cualquiera de los tres prompts requiera una decisión de negocio (ej. hard block vs. soft warning en Avance; qué constituye "un solo pago" en Pagos)
- El bug de Prompt B no sea reproducible en Preview con los mismos pasos — reportar diferencias entre Preview y Producción antes de continuar
- Se descubra que alguno de los tres módulos toca lógica financiera compartida con otros módulos no mencionados aquí

Checkpoints:
✅ Prompt A: archivo y línea exactos del endpoint de Avance, confirmación de ausencia/presencia de validación, pregunta abierta sobre tipo de candado
✅ Prompt B: causa raíz exacta con evidencia HTTP/terminal literal, no resumen
✅ Prompt C: archivo y línea del modelo de pagos, confirmación de si existe o no restricción de unicidad, patrón de soft-delete aplicable identificado
✅ Reporte final en el mismo formato usado en diagnósticos previos (hallazgo + opciones de siguiente paso), sin implementar cambios

Estimación de tiempo: 30–45 min con Claude Code + Sonnet 5 a esfuerzo medio (tres diagnósticos de lectura de código, sin cambios).
