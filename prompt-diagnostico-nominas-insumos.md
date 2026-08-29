Objective:
Diagnóstico previo (sin código funcional) del origen real de 3 sugerencias de usuarios, ya descartado que sean el bug de `proyecto_id`/`SECCIONES_SIEMPRE_GLOBAL` (confirmado en diagnóstico previo — `nominas` e `insumos` están 100% scoped por obra y no reproducen ese bug):

1. Efren Monico Velez (cabo), 23 jul: "No deja ver a Monico nóminas, ya le habilité el permiso pero sigue sin aparecerle."
2. Raúl Méndez (residente), 13 jul: "No me aparecen todos los insumos en mi perfil."
3. Rodolfo (admin), 13 jul, confirmando el mismo caso: "En el usuario de Raúl no aparecen todos los insumos."

Starting State:
- Ambas quejas son de mediados/finales de julio — anteriores a varios cambios ya hechos en el sistema desde entonces (incluyendo PR #63/#64 de julio, que le dio a `cabo` acceso real a Nómina vía matriz — fecha muy cercana a la queja de Efren, vale la pena confirmar el orden exacto).
- No asumir que el bug sigue vivo hoy — la primera pregunta es si esto ya se resolvió como efecto colateral de trabajo posterior, antes de buscar una causa nueva.

Target State (solo investigación, reportar en texto/markdown):

1. **Cronología exacta**: ¿la queja de Efren (23 jul, "ya habilité el permiso") fue ANTES o DESPUÉS de que PR #63/#64 (mismo día, 23 jul) le diera acceso real a cabo en Nómina? Si fue antes, es muy probable que el problema que reportó ya no exista — el fix llegó el mismo día. Confirmar con timestamps de commit vs. timestamp de la sugerencia.
2. **Reproducir en Preview, con datos actuales**: crear (o usar) un usuario de prueba con puesto `cabo`, otorgarle `nominas.puede_ver=true` en la matriz (con `proyecto_id=NULL`, ya que no es el bug de scope), y confirmar si HOY puede ver nóminas correctamente. Si sí, la queja de Efren está resuelta — documentarlo y cerrar esa parte.
3. **Insumos — investigar con más profundidad**: la queja específica es "no aparecen TODOS los insumos" (no "no aparece nada") — sugiere un problema de filtrado parcial, no de permiso binario. Revisar el endpoint de insumos: ¿hay algún filtro (por proveedor, por categoría, por obra, por algún otro criterio) que pudiera estar excluyendo insumos que sí deberían verse para un `residente`? Revisar también si `residente` tiene alguna restricción de `puede_ver` granular más allá del booleano simple (ej. algún filtro por tipo de insumo).
4. **Reproducir con datos reales de Raúl si es posible**: identificar su usuario en Preview, ver qué insumos ve hoy vs. cuántos existen en total para esa obra, y comparar.
5. **Conclusión honesta**: para cada una de las 2 quejas, reportar: (a) ya resuelta por trabajo posterior — cerrar sin código, o (b) sigue reproduciendo — con la causa real identificada y evidencia, lista para un prompt de implementación aparte.

Allowed Actions:
- Leer server/app.js, server/auth.js, código de insumos y nóminas.
- Consultar Preview DB (confirmar que es Preview antes de cualquier query) — usuarios reales, permisos, datos de insumos.
- Crear/borrar usuarios y permisos de prueba en Preview, con limpieza física verificada al final.
- Reportar hallazgos en texto/markdown.

Forbidden Actions:
- NO modificar código todavía — esto es diagnóstico puro.
- NO tocar producción bajo ninguna circunstancia.
- NO dejar datos de prueba sin limpiar.
