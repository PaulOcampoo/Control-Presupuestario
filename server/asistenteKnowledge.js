'use strict';

// Base de conocimiento estática del Asistente IA (prompt-asistente-ia-app-cp.md).
// Editable a mano — NUNCA generada dinámicamente ni consultada contra la DB.
// Las claves coinciden 1:1 con los ids de tab usados en public/app.js
// (TAB_LABELS/SECTION_DEFS) y con lo que devuelve auth.tabsParaUsuario(user)
// en el backend — así el endpoint de chat puede filtrar automáticamente qué
// módulos describirle al modelo según lo que el usuario realmente puede ver,
// sin necesidad de mantener una tabla de permisos por rol por separado (eso
// ya vive en server/auth.js, fuente única de verdad — ver tabsParaUsuario()).
const MODULOS = {
  resumen: { label: 'Resumen', descripcion: 'Vista de entrada de una obra: KPIs de avance financiero/ejecutado/físico, desviación vs. programa, y accesos directos a los módulos más usados.' },
  contrato: { label: 'Contrato', descripcion: 'Datos del contrato de la obra (contratista, RFC, fechas, importe, % anticipo, % fondo de garantía). El PDF se sube aquí y esos campos se extraen automáticamente con IA.' },
  impuestos: { label: 'Impuestos', descripcion: 'Registro de impuestos/retenciones relacionados a la obra.' },
  insumos: { label: 'Insumos', descripcion: 'Catálogo de materiales/insumos de la obra, usado para vincular requisiciones y órdenes de compra.' },
  requisiciones: { label: 'Requisiciones', descripcion: 'Solicitudes de material que hace el residente/cabo en obra; de aquí se generan las Órdenes de Compra.' },
  ordenes: { label: 'Órdenes de Compra', descripcion: 'Órdenes de compra formales a proveedores, generadas a partir de requisiciones aprobadas; llevan seguimiento de pagos.' },
  avance: { label: 'Avance', descripcion: 'Captura semanal del avance físico de cada concepto del presupuesto (cantidad ejecutada). Alimenta los KPIs de Resumen y, una vez aprobado, las Estimaciones.' },
  programa: { label: 'Programa', descripcion: 'Programa de obra (curva S / calendario de conceptos) usado para calcular el Avance Programado.' },
  destajo: { label: 'Destajo', descripcion: 'Pago a trabajadores por trabajo a destajo (cantidad × precio de destajo), distinto de la nómina por jornal.' },
  estadoActivo: { label: 'Estado del Activo', descripcion: 'Salud general de la obra en un vistazo (financiero + físico).' },
  presupuestoEstimaciones: { label: 'Presupuesto vs Estimaciones', descripcion: 'Compara el presupuesto original contra lo ya facturado por Estimaciones.' },
  estimaciones: { label: 'Estimaciones', descripcion: 'Corte periódico de avance que se convierte en el monto a cobrar al cliente: jala automáticamente el avance registrado en Avance, calcula IVA, fondo de garantía y amortización de anticipo, y genera un PDF firmable. Flujo Borrador → Enviada → Aprobada/Rechazada.' },
  generadoresObra: { label: 'Generadores de Obra', descripcion: 'Captura manual de números generadores/volumetría (mediciones Largo/Ancho/Alto/Pzas por concepto real de la obra), agrupada por Partida/Subpartida, con el mismo flujo Borrador → Enviada → Aprobada/Rechazada que Estimaciones. Pensado para respaldar con detalle el volumen que después se cobra.' },
  ordenesCambio: { label: 'Órdenes de Cambio', descripcion: 'Solicitud formal de cambio de alcance del contrato; al aprobarse, ajusta el presupuesto real de la obra.' },
  lotes: { label: 'Lotes', descripcion: 'Catálogo de lotes/terrenos de un desarrollo (para obras de vivienda).' },
  modelosVivienda: { label: 'Modelos de Vivienda', descripcion: 'Catálogo de modelos/tipologías de casa de un desarrollo de vivienda.' },
  infraVivienda: { label: 'Infraestructura vs. Vivienda', descripcion: 'Compara el avance/costo de infraestructura de un desarrollo contra el de vivienda.' },
  compradores: { label: 'Compradores', descripcion: 'CRM de compradores de vivienda: datos de contacto, proceso de compra.' },
  apartados: { label: 'Apartados', descripcion: 'Registro de apartados (reservas) de lotes/casas antes de firmar contrato de venta.' },
  contratosVenta: { label: 'Contrato de Venta', descripcion: 'Contratos de venta de vivienda con compradores.' },
  cobranza: { label: 'Cobranza', descripcion: 'Seguimiento de pagos/cobranza de los contratos de venta de vivienda.' },
  entregas: { label: 'Entregas', descripcion: 'Registro de entrega de vivienda al comprador final.' },
  usuarios: { label: 'Usuarios', descripcion: 'Alta/baja de usuarios del sistema, asignación de rol y de obras, y matriz de permisos granulares por sección.' },
  proveedores: { label: 'Proveedores', descripcion: 'Catálogo de proveedores usados en Órdenes de Compra.' },
  cumplimiento: { label: 'Cumplimiento', descripcion: 'Documentación de cumplimiento de proveedores/contratistas.' },
  finanzas: { label: 'Finanzas', descripcion: 'Vista financiera de la obra: pagos, erogado real, comprometido.' },
  compromisos: { label: 'Compromisos Abiertos', descripcion: 'Órdenes de compra con saldo pendiente de pago.' },
  fondoGarantia: { label: 'Fondo de Garantía', descripcion: 'Monto retenido por fondo de garantía de las Estimaciones ya aprobadas de la obra.' },
  mapeo: { label: 'Mapeo', descripcion: 'Vinculación de conceptos del presupuesto con insumos/categorías para reportes de costos.' },
  trabajadores: { label: 'Trabajadores', descripcion: 'Roster de trabajadores de una obra: alta, documentos (INE/CURP), EPP, datos de contrato laboral.' },
  nominas: { label: 'Nóminas', descripcion: 'Cálculo y captura de nómina semanal (jornal + destajo) de los trabajadores de una obra, con aprobación de admin.' },
  trabajadores_global: { label: 'Trabajadores (todas las obras)', descripcion: 'Vista cross-obra de trabajadores, solo para roles con acceso global.' },
  nominas_global: { label: 'Nóminas (todas las obras)', descripcion: 'Vista cross-obra de nóminas, solo para roles con acceso global.' },
  cotizador: { label: 'Cotizador', descripcion: 'Herramienta de cotización rápida de compras.' },
  almacen: { label: 'Almacén', descripcion: 'Entradas y salidas de material de almacén de obra.' },
  matrices: { label: 'Matrices de precio unitario', descripcion: 'Análisis de precio unitario (materiales, mano de obra, herramienta, indirecto/utilidad) de cada concepto del presupuesto.' },
  generadorPresupuestos: { label: 'Generador de Presupuestos', descripcion: 'Arma presupuestos nuevos a partir de un catálogo de conceptos/matrices, exportables a Excel.' },
  costos: { label: 'Costos', descripcion: 'Catálogo global de costos de referencia (histórico entre obras).' },
  costosDashboard: { label: 'Dashboard de Costos', descripcion: 'Vista global de solo lectura: cobertura de matrices, insumos con precio inconsistente entre obras, actividad reciente.' },
  catalogoBasicos: { label: 'Catálogo de Básicos', descripcion: 'Catálogo global de insumos básicos (código único cross-obra) con su costo directo.' },
  composicion_costos: { label: 'Composición de costos', descripcion: 'Desglose de qué compone el costo de un concepto (materiales/mano de obra/equipo).' },
  avance_clientes: { label: 'Avance por cliente', descripcion: 'Vista agregada de avance de todas las obras de un cliente.' },
  dashboardEjecutivo: { label: 'Dashboard Ejecutivo', descripcion: 'Vista financiera agregada multi-obra para dirección/tesorería.' },
  estadoResultados: { label: 'Estado de Resultados', descripcion: 'Estado de resultados de una obra, acceso restringido.' },
  estadoResultadosGlobal: { label: 'Estado de Resultados (todas las obras)', descripcion: 'Estado de resultados agregado, acceso restringido.' },
  cuentas: { label: 'Cuentas', descripcion: 'Control de cuentas bancarias, acceso restringido.' },
  controlFinanciero: { label: 'Control Financiero', descripcion: 'Panel financiero consolidado, acceso restringido.' },
  maquinaria_catalogo: { label: 'Catálogo de equipos', descripcion: 'Catálogo de maquinaria/equipo de la empresa.' },
  maquinaria_horas: { label: 'Horas / Pendientes de autorizar', descripcion: 'Captura y autorización de horas trabajadas por unidad de maquinaria.' },
  maquinaria_bitacora: { label: 'Bitácora de taller', descripcion: 'Mantenimientos y combustible de cada unidad de maquinaria.' },
  maquinaria_estado_unidad: { label: 'Estado de las unidades', descripcion: 'Estado operativo actual de cada unidad de maquinaria.' },
  maquinaria_consumibles: { label: 'Consumibles', descripcion: 'Consumibles asociados a maquinaria (llantas, filtros, etc.).' },
  maquinaria_reportes_cliente: { label: 'Reportes por cliente', descripcion: 'Reporte de uso/costo de maquinaria agrupado por cliente.' },
  contabilidadCuentas: { label: 'Catálogo de Cuentas', descripcion: 'Catálogo de cuentas contables (módulo de Contabilidad).' },
  contabilidadPolizas: { label: 'Pólizas', descripcion: 'Pólizas contables.' },
  contabilidadCfdi: { label: 'CFDI', descripcion: 'Gestión de CFDI (facturas electrónicas).' },
  contabilidadPagos: { label: 'Pagos de OC', descripcion: 'Pagos aplicados a Órdenes de Compra, vista contable.' },
  contabilidadConciliacion: { label: 'Conciliación Bancaria', descripcion: 'Conciliación de movimientos bancarios contra pólizas.' },
  contabilidadDepreciacion: { label: 'Depreciación de Maquinaria', descripcion: 'Cálculo de depreciación contable de maquinaria.' },
  contabilidadExport: { label: 'Exportar / Reporte Mensual', descripcion: 'Exportación de reportes contables mensuales.' },
};

// 'sugerencias' no es un tab de navegación (vive como portal aparte,
// accesible a cualquier usuario autenticado) — se agrega fuera del mapa de
// tabs para no confundirlo con un módulo filtrable por tabsParaUsuario().
const SUGERENCIAS_INFO = { label: 'Sugerencias', descripcion: 'Buzón para mandar ideas/mejoras del sistema al equipo de desarrollo — cualquier usuario autenticado puede mandar una.' };

module.exports = { MODULOS, SUGERENCIAS_INFO };
