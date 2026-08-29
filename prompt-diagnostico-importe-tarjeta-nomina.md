Objective:
Diagnóstico previo (sin código funcional) de cómo está implementado hoy el reparto del pago de un trabajador entre distintas cuentas (ej. tarjeta nómina vs. otras cuentas/efectivo), como paso previo a un cambio pedido por el cliente: en vez de asignar un PORCENTAJE por cuenta, la cuenta de nómina (tarjeta nómina) debe tener un IMPORTE editable directo (monto fijo en pesos), y las demás cuentas deben calcularse por diferencia (total del pago menos lo asignado a tarjeta nómina). Motivo del cliente: el proceso de timbrado de nómina ante el IMSS requiere que el monto de tarjeta nómina sea una cifra exacta, no un porcentaje.

Starting State:
- Módulo Trabajadores/Nómina — existe algún mecanismo de reparto de pago por cuenta con porcentajes, ubicación exacta a confirmar (revisar tanto el expediente de trabajador como la captura/cálculo de nómina).
- Ya se documentó en el schema la existencia de columnas de banco/cuenta para nómina en trabajadores (ej. cuenta bancaria de nómina) — confirmar si el reparto por porcentaje vive ahí, en otra tabla, o en el cálculo de la nómina misma.

Target State (solo investigación, reportar en texto/markdown):

1. **Ubicar el campo/mecanismo exacto de "porcentaje por cuenta"**: ¿en qué tabla vive, qué endpoint lo lee/escribe, en qué pantalla del frontend se captura? ¿Es por trabajador (configuración fija) o por corrida de nómina (variable cada periodo)?
2. **Cuántas cuentas existen hoy en ese reparto**: ¿son exactamente 2 (tarjeta nómina + una alterna/efectivo), o puede haber más? Esto determina si "las demás por diferencia" es un cálculo simple (100% - tarjeta nómina) o necesita repartir el resto entre varias.
3. **Dónde se consume el resultado del reparto**: ¿solo se muestra en pantalla, o alimenta algún cálculo/exportación downstream (ej. el archivo de dispersión bancaria, el timbrado de CFDI de nómina si ya existe, algún reporte)? Confirmar todos los consumidores antes de proponer el cambio, para no romper algo aguas abajo.
4. **Validación de rango**: ¿hoy hay alguna validación de que los porcentajes sumen 100%? Si el nuevo modelo es "importe fijo para tarjeta nómina + diferencia para el resto", confirmar qué pasa si el importe de tarjeta nómina excede el total del pago (¿debe bloquearse, advertir, o permitirse con diferencia negativa?).
5. **Alcance de la migración**: ¿hay datos ya capturados con porcentajes que habría que migrar/interpretar al nuevo modelo, o es un campo que se llena en cada corrida sin arrastrar historial?
6. **Propuesta de diseño** (no implementar aún): campo nuevo `importe_tarjeta_nomina` (o el nombre que encaje con la convención ya usada) en vez de porcentaje, con el resto calculado como diferencia — confirmar si esto reemplaza el campo de porcentaje existente o coexiste con él durante una transición.

Allowed Actions:
- Leer server/db.js, server/app.js, público/app.js relacionado a Trabajadores/Nómina/pago.
- Consultar Preview DB (confirmar que es Preview antes de cualquier query) para ver cuántos trabajadores reales tienen este campo capturado hoy y con qué valores.
- Reportar hallazgos y propuesta de diseño en texto/markdown.

Forbidden Actions:
- NO modificar ningún archivo de código todavía — esto es diagnóstico puro.
- NO tocar producción bajo ninguna circunstancia.
- NO asumir el modelo de datos sin confirmarlo con evidencia — esto tiene implicaciones de cumplimiento fiscal (timbrado IMSS), no es un cambio cosmético.
