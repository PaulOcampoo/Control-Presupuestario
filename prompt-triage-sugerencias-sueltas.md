Objective:
Diagnóstico previo (sin código funcional) de las 15 sugerencias restantes del panel de Sugerencias, para clasificar cada una antes de decidir qué implementar. Ya se demostró hoy dos veces que quejas de "permiso otorgado que no se refleja" pueden estar ya resueltas por trabajo posterior, o conectadas a bugs ya diagnosticados (proyecto_id/SECCIONES_SIEMPRE_GLOBAL, y las 7 secciones sin enforcement real) — no asumir que cada una necesita su propio fix nuevo sin antes verificar.

Starting State:
Las 15 sugerencias a triar (usuario, puesto, fecha, texto):
1. Rafael Ocampo Hernandez (jefe_maquinaria), 05 ago: "suministro de combustible taller"
2. Administrador (admin), 29 jul: "en avances, al eliminar el avance capturado para pruebas no me deja eliminar avances"
3. Raúl Mendez (residente), 28 jul: "En residentes, maquinaria, solo los equipos asignados al cliente específico es decir, Kalia, residente asignado Raúl, solo tiene que ver los equipos que están con ese cliente, y no todos"
4. Raúl Mendez (residente), 24 jul: "no me deja corregir datos del trabajador"
5. Emanuel Jimenez Rodriguez (residente), 21 jul: "No me aparece habilitado de concepto maquinaria"
6. Raúl Mendez (residente), 17 jul: "Generar formato para descontar amortización y fondo de garantía"
7. Raúl Mendez (residente), 17 jul: "No me permite editar el nombre de la estimación"
8. Rodolfo Ocampo Hernandez (admin), 16 jul: "la pestaña en administración, trabajadores integrarla a residentes"
9. Raúl Mendez (residente), 16 jul: "integrar los permisos en residentes del personal para darlos de alta al sistema"
10. Rodolfo Ocampo Hernandez (admin), 14 jul: "falta anexar la pestaña de trabajadores a los residentes para que ellos carguen al personal"
11. Raúl Mendez (residente), 13 jul: "No me deja crear nómina."
12. Rodolfo Ocampo Hernandez (admin), 13 jul: "Ya me dio los permisos en avance y no ve los avances y el programa"
13. Raúl Mendez (residente), 13 jul: "Estos permisos ya fueron autorizados por el administrador y siguen sin verse."
14. Raúl Mendez (residente), 13 jul: "No me permite ver programa, en la pestaña de obra y en la pestaña de avance"
15. Raúl Mendez (residente), 12 jul: "En la sección de destajo, el residente asigna cantidades no puede editar precios"
16. Raúl Mendez (residente), 12 jul: "El residente sí puede ver y dar avances en la sección de avances" (nota: suena a confirmación positiva, no queja — verificar)
17. Raúl Mendez (residente), 12 jul: "El residente sí puede ver el programa de obra en la sección de avance" (nota: mismo caso, verificar si es queja o confirmación)
18. Raúl Mendez (residente), 12 jul: "Al crear un nuevo usuario, primero asignarlo por cliente, y luego asignar a las obras a las que puedan dar avance requisiciones etc" (sugerencia de flujo UX)
19. Raúl Mendez (residente), 12 jul: "Los residentes solo pueden crear la lista de nómina de la obra en la que dan avance, y no pueden ver las nóminas de los demás residentes o usuarios, el administrador sí puede ver las nóminas de todos los residentes y todas las obras, pero clasificada por residente y por obra siempre en orden" (sugerencia de feature)
20. Administrador (admin), 09 jul: "en la pantalla al entrar en cualquiera de los clientes, la tecla back hace lo mismo que la tecla de tres líneas parte superior de la pantalla" (bug de navegación)

(Nota: el conteo real es 15 según el panel — esta lista de 20 puede tener duplicados/agrupaciones a resolver durante el triage; usar el panel real de Sugerencias como fuente de verdad, no esta lista reconstruida de memoria.)

Target State (solo investigación y clasificación, reportar en texto/markdown — tabla):

Para cada sugerencia, determinar y reportar en una tabla:
- ¿Ya resuelta por trabajo posterior a su fecha? (revisar git log de las áreas relevantes desde esa fecha)
- ¿Conectada a alguno de los 2 bugs ya diagnosticados hoy (proyecto_id/SECCIONES_SIEMPRE_GLOBAL, o las 7 secciones sin enforcement real)? Particularmente #12, #13, #14 (avance/programa) son candidatas fuertes — confirmar o descartar con evidencia, no suposición.
- ¿Es una queja de bug real que sigue reproduciendo hoy? Si sí, causa raíz identificada (o al menos acotada).
- ¿Es una sugerencia de feature/UX (no un bug)? Marcar como tal — necesita decisión de producto de Paul, no diagnóstico técnico.
- ¿Es ambigua o parece una confirmación positiva en vez de una queja (#16, #17)? Marcar para descartar o pedir aclaración.
- Duplicados/mismo tema agrupable (ej. #8, #9, #10 parecen ser la misma idea repetida: integrar gestión de trabajadores al flujo de residentes) — agrupar en el reporte.

Priorizar en el reporte las que sean bugs reales de rápida resolución sobre las que sean features grandes — para que Paul pueda decidir con esa jerarquía a la vista.

Allowed Actions:
- Leer server/app.js, server/auth.js, public/app.js, git log de las áreas relevantes.
- Consultar Preview DB (confirmar que es Preview antes de cualquier query) si hace falta verificar algún caso con datos reales.
- Reportar en texto/markdown con la tabla de clasificación como entregable principal.

Forbidden Actions:
- NO modificar ningún archivo de código todavía — esto es diagnóstico y clasificación, no implementación.
- NO tocar producción bajo ninguna circunstancia.
- NO asumir que una queja de "permiso no se refleja" es automáticamente el mismo bug ya encontrado — confirmar cada caso con evidencia antes de agruparlo.
