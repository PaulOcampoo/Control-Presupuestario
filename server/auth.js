'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const OTPAuth = require('otpauth');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET no está configurada en las variables de entorno — la app no puede arrancar sin ella.');
}

const TOTP_ENC_KEY = process.env.TOTP_ENC_KEY;
if (!TOTP_ENC_KEY || !/^[0-9a-f]{64}$/i.test(TOTP_ENC_KEY)) {
  throw new Error('TOTP_ENC_KEY no está configurada (o no es un hex de 64 caracteres / 32 bytes) — la app no puede arrancar sin ella.');
}
const TOTP_ENC_KEY_BUF = Buffer.from(TOTP_ENC_KEY, 'hex');

const TOKEN_TTL = '2h';
const REFRESH_TTL = '7d';
const REFRESH_COOKIE = 'cp_refresh';
const PRE_AUTH_TTL = '5m';
const TOTP_ISSUER = 'Grupo Roforb — Control Presupuestal';

// Subsecciones de Maquinaria (prompt-39-maquinaria-galeria-subsecciones.md)
// — mismo módulo/permiso de siempre ('maquinaria' + sub-permisos existentes,
// sin cambios de enforcement), el tab único 'maquinaria' se reparte en 6
// para adoptar el patrón de galería (mirror exacto de MAQUINARIA_TABS_* en
// public/app.js — mantener en sync). Cada rol lista solo las que hoy le
// muestran contenido real dentro del módulo (ver ROLES_*_MAQ en
// public/app.js): jefe_maquinaria no captura ni autoriza horas, cabo no ve
// la bitácora de taller (exclusiva de jefe_maquinaria/admin/desarrollador),
// operador no ve catálogo completo ni reportes por cliente, residente solo
// tenía acceso de lectura al catálogo/equipos-por-cliente (puede_ver=true
// por default en la sección 'maquinaria', sin ningún puede_crear/puede_ver
// en maquinaria_captura/maquinaria_combustible/estado_unidad/
// maquinaria_consumibles — ver defaultPermisosParaRol más abajo, sin bloque
// explícito para residente en ninguna de esas 4 secciones).
const MAQUINARIA_TABS_ADMIN = ['maquinaria_catalogo', 'maquinaria_horas', 'maquinaria_bitacora', 'maquinaria_estado_unidad', 'maquinaria_consumibles', 'maquinaria_reportes_cliente'];
const MAQUINARIA_TABS_CABO = ['maquinaria_catalogo', 'maquinaria_horas', 'maquinaria_estado_unidad', 'maquinaria_consumibles', 'maquinaria_reportes_cliente'];
const MAQUINARIA_TABS_JEFE = ['maquinaria_catalogo', 'maquinaria_bitacora', 'maquinaria_estado_unidad', 'maquinaria_consumibles', 'maquinaria_reportes_cliente'];
const MAQUINARIA_TABS_OPERADOR = ['maquinaria_horas', 'maquinaria_estado_unidad', 'maquinaria_consumibles'];
const MAQUINARIA_TABS_RESIDENTE = ['maquinaria_catalogo', 'maquinaria_reportes_cliente'];

// Puestos y qué pestañas puede ver cada uno. 'admin' tiene acceso total
// (se resuelve aparte en allow(), no necesita listarse en cada pestaña).
const PERMISSIONS = {
  // 'estadoResultados'/'estadoResultadosGlobal' retirados de la lista base
  // (prompt-36-control-financiero-fase3-4.md, punto 3): antes cualquier
  // cuenta admin/desarrollador los veía por el bypass normal de allow(),
  // igual que pasaba con 'cuentas'/'controlFinanciero' antes de acotarlos a
  // whitelist — mismo candado ahora, vía tabsParaUsuario() +
  // requireEstadoResultadosAccess (0 usuarios reales con puesto 'tesoreria'
  // en Producción, confirmado antes de este cambio).
  admin:          { label: 'Administrador', tabs: ['resumen', 'contrato', 'impuestos', 'insumos', 'requisiciones', 'ordenes', 'avance', 'programa', 'destajo', 'usuarios', 'proveedores', 'finanzas', 'mapeo', 'trabajadores', 'trabajadores_global', 'nominas', 'nominas_global', 'estimaciones', ...MAQUINARIA_TABS_ADMIN, 'cotizador', 'costos', 'matrices', 'avance_clientes', 'composicion_costos'] },
  desarrollador:  { label: 'Desarrollador', tabs: ['resumen', 'contrato', 'impuestos', 'insumos', 'requisiciones', 'ordenes', 'avance', 'programa', 'destajo', 'usuarios', 'proveedores', 'finanzas', 'mapeo', 'trabajadores', 'trabajadores_global', 'nominas', 'nominas_global', 'estimaciones', ...MAQUINARIA_TABS_ADMIN, 'cotizador', 'costos', 'matrices', 'avance_clientes', 'composicion_costos'] },
  // 'trabajadores' agregado aquí (prompts-cotizador-sidebar-permisos-
  // estimaciones.md, Prompt 3) para que el residente reciba la pestaña al
  // hacer login — el acceso REAL a los datos de cada obra lo sigue
  // decidiendo checkPermiso('trabajadores', ...) vía permisos_usuario (sin
  // fila = 403, igual que 'nominas' hoy): agregar la pestaña no otorga el
  // permiso por sí sola, un admin debe concederlo explícitamente en la
  // matriz por cada obra.
  // 'maquinaria' agregado aquí (prompt-p1-residente-maquinaria.md): mismo gap
  // ya documentado arriba para 'trabajadores' — checkPermiso('maquinaria', ...)
  // y el CHECK constraint de permisos_usuario.seccion ya soportaban 'maquinaria'
  // para residente, y varios residentes ya tenían la fila puede_ver=true
  // otorgada desde la matriz, pero la pestaña nunca llegaba a state.allowedTabs
  // (viene de esta lista, no de la matriz) así que nunca veían el tile. Igual
  // que 'trabajadores': agregar el tab no otorga el permiso por sí solo, sigue
  // decidiéndolo checkPermiso vía permisos_usuario (sin fila = 403).
  // 'matrices' agregado (prompt-14-matrices-precio-unitario.md): mismo gap ya
  // documentado arriba para 'trabajadores'/'maquinaria' — agregar el tab NO
  // otorga el permiso por sí solo, checkPermiso('costos', ...) sigue siendo
  // el gate real vía permisos_usuario (sin fila = 403, default-deny de
  // 'costos', ver SECCIONES_PERMISOS más abajo).
  residente:      { label: 'Residente',     tabs: ['programa', 'avance', 'destajo', 'requisiciones', 'insumos', 'ordenes', 'nominas', 'trabajadores', 'estimaciones', ...MAQUINARIA_TABS_RESIDENTE, 'matrices'] },
  // 'trabajadores' agregado aquí (prompt-c-checkpermiso-trabajadores.md,
  // fix de visibilidad en nav): mismo gap ya documentado para 'costos' más
  // abajo — el permiso puede_ver otorgado vía la matriz a UN cabo específico
  // no bastaba, porque la visibilidad de la pestaña en nav es por ROL (esta
  // lista), no por usuario individual. Agregar el tab lo hace visible para
  // TODOS los cabo (no solo el que recibió el permiso) — cualquier cabo sin
  // el puede_ver real ve la pestaña pero renderTrabajadores() ya maneja esto
  // con gracia ("No tienes permiso para ver esta sección", mismo patrón que
  // trabajadores_global/costos), sin exponer ningún dato — el backend sigue
  // siendo la única barrera de seguridad real (checkPermiso, PR previo de
  // este mismo branch).
  // 'nominas' agregado aquí (prompt-fix-permisos-nomina-cabo.md, mismo patrón
  // que 'trabajadores' arriba): el acceso real por-obra lo sigue decidiendo
  // checkPermiso('nominas', ...) vía permisos_usuario — agregar el tab no
  // otorga el permiso por sí solo, solo lo hace posible cuando un admin lo
  // conceda explícitamente en la matriz.
  cabo:           { label: 'Cabo',          tabs: ['destajo', 'insumos', 'avance', 'requisiciones', ...MAQUINARIA_TABS_CABO, 'trabajadores', 'nominas'] },
  compras:        { label: 'Compras',       tabs: ['programa', 'requisiciones', 'insumos', 'ordenes', 'proveedores', 'cotizador'] },
  tesoreria:      { label: 'Tesorería',     tabs: ['resumen', 'finanzas', 'ordenes', 'contrato', 'impuestos', 'proveedores'] },
  administracion: { label: 'Administración',tabs: ['resumen', 'programa', 'destajo', 'ordenes', 'proveedores', 'contrato', 'impuestos', 'mapeo'] },
  logistica:      { label: 'Logística',     tabs: ['programa', 'avance', 'requisiciones', 'insumos', 'ordenes'] },
  // Rol nuevo (prompt-modulo-maquinaria) — diseño de primer borrador, pendiente
  // de revisión: jefe_maquinaria captura combustible/mantenimiento, cabo
  // captura horas. Renombrado desde 'taller' (prompt-1-rename-operador-jefe-
  // maquinaria.md) para liberar un nombre corto y dejar sitio al rol nuevo de
  // horas/actividad en campo que se agregará después.
  jefe_maquinaria: { label: 'Jefe de Maquinaria', tabs: MAQUINARIA_TABS_JEFE },
  // Rol nuevo (prompt-2-rol-operador-actividades.md) — el trabajador de
  // campo que llena reportes de horas/actividad de maquinaria. Distinto de
  // jefe_maquinaria (combustible/mantenimiento, PR #49) y de cabo (también
  // captura horas hoy, sin cambios en este prompt — eso es el Prompt 3).
  operador: { label: 'Operador', tabs: MAQUINARIA_TABS_OPERADOR },
};
const PUESTOS = Object.keys(PERMISSIONS);

function isValidPuesto(p) {
  return PUESTOS.includes(p);
}

// ---------------------------------------------------------------------------
// Permisos granulares por usuario/obra/sección (tabla permisos_usuario).
// Conviven con PERMISSIONS/allow() de arriba — no lo reemplazan. Alcance de
// enforcement real (checkPermiso aplicado en endpoints): Nómina, Avance,
// Maquinaria, Destajo y Requisiciones (ver SECCIONES_CON_ENFORCEMENT en
// public/app.js, debe mantenerse en sync con esta lista).
//
// GAP CONOCIDO, PENDIENTE DE REVISIÓN (módulo Maquinaria, ver
// prompt-modulo-maquinaria.md y server/maquinaria.js): la sección
// 'maquinaria' es UNA sola fila de permisos para equipos + combustible +
// mantenimiento + horas + presupuesto. El diseño de primer borrador quiere
// que cabo capture horas y jefe_maquinaria capture combustible/mantenimiento, pero
// como ambos roles reciben puede_crear=true en la MISMA sección (ver
// defaultPermisosParaRol), cualquiera de los dos puede llamar por API
// cualquiera de esos 4 endpoints de creación — el frontend solo oculta los
// botones que no le corresponden a cada rol, no hay separación real a nivel
// de checkPermiso. Confirmado en vivo: cabo pudo POST /api/maquinaria/
// combustible aunque el botón esté oculto para su rol. Si se define que esta
// separación debe ser real (no solo de UI), hace falta partir 'maquinaria'
// en sub-secciones (ej. 'maquinaria_captura' vs 'maquinaria_combustible').
// ---------------------------------------------------------------------------
const SECCIONES_PERMISOS = [
  'presupuestos', 'requisiciones', 'proveedores', 'ordenes_compra', 'avance',
  'destajo', 'finanzas', 'estado_resultados', 'insumos', 'mapeo', 'usuarios', 'contrato', 'impuestos',
  'nominas', 'sugerencias', 'programa', 'estimaciones', 'maquinaria',
  // CN-002: 'maquinaria' quedaba como una sola sección compartida entre
  // captura de horas (cabo) y combustible/mantenimiento (jefe_maquinaria), así que
  // cualquiera de los dos roles podía POSTear a los endpoints del otro
  // (confirmado en vivo). Separadas para que cada rol solo tenga
  // puede_crear en la suya — ver defaultPermisosParaRol más abajo.
  'maquinaria_captura', 'maquinaria_combustible',
  // Secciones NUEVAS (prompts-cotizador-permisos.md, Prompt 2) — DISTINTAS de
  // 'nominas' a propósito: 'nominas' ya gatea el acceso por-obra (una obra a
  // la vez, ver checkPermiso en /api/projects/:id/nominas/...); estas dos
  // gatean las vistas GLOBALES cross-obra/cross-cliente (GET /api/trabajadores,
  // GET /api/nominas sin :id) — un privilegio bastante más amplio que no debe
  // quedar implícito solo por tener acceso a nómina de la propia obra.
  // SIEMPRE se guardan con proyecto_id NULL (no existe versión "por obra" de
  // una vista que ya de por sí es cross-obra) — ver SECCIONES_SIEMPRE_GLOBAL
  // en public/app.js.
  'trabajadores_global', 'nominas_global',
  // 'trabajadores' por-obra (prompts-cotizador-sidebar-permisos-estimaciones.md,
  // Prompt 3) — distinta de 'trabajadores_global' igual que 'nominas' lo es de
  // 'nominas_global': gatea lista/alta/editar/baja/reactivar/eliminar-físico
  // de trabajadores DE UNA obra específica, y también EPP + Catálogo EPP
  // (registrar entrega, ver historial, administrar el catálogo — prompt-
  // implementar-permisos-docs-contrato-epp.md decidió NO separarlos en su
  // propia sección: no manejan datos tan sensibles como identidad/salario).
  // "EPP → eliminar entrega" es la única excepción: se queda admin-only
  // estricto vía isAdminRealSinSimular() en frontend, a propósito, sin
  // exponerse aquí ni en la matriz.
  'trabajadores',
  // Documentos de identidad (INE/CURP/comprobante domicilio) y Contratos
  // laborales (incluye salario) de un trabajador — separados de 'trabajadores'
  // en secciones propias (prompt-implementar-permisos-docs-contrato-epp.md)
  // porque son datos más sensibles que el roster/avance básico: Paul quiere
  // poder dar acceso a Trabajadores sin exponer identidad/salario, o
  // viceversa. Mismo patrón de columnas reutilizadas (ver/crear/eliminar con
  // checkPermiso real; 'trabajadores_contrato' no tiene endpoint de editar ni
  // eliminar individual — no existe esa acción, se resube el PDF completo).
  'trabajadores_docs', 'trabajadores_contrato',
  // Datos bancarios (prompt-p5-cuentas-bancarias.md) — cuenta de nómina HSBC
  // + cuenta alterna, aún más sensibles que docs/contrato. A propósito SIN
  // entrada en TAB_A_SECCION (mismo default-deny real que 'costos' — sin
  // mapeo tab→sección no se genera fila al dar de alta un usuario), pero
  // 'administracion' SÍ recibe un default explícito abajo en
  // defaultPermisosParaRol (mismo patrón que jefe_maquinaria con
  // 'maquinaria_combustible'). Nunca viaja en ningún listado — solo en el
  // detalle de un trabajador, gateado por checkPermiso real en server/app.js.
  'trabajadores_bancarios',
  // 'costos' (prompt-modulo-costos.md) — catálogo de precios agregado por
  // cliente y global, cross-obra/cross-cliente por diseño (igual que
  // trabajadores_global/nominas_global, ver SECCIONES_SIEMPRE_GLOBAL en
  // public/app.js). A propósito SIN entrada en TAB_A_SECCION: Paul pidió
  // default-deny real para todos los roles no-admin — sin mapeo tab→sección
  // no se genera ninguna fila de permiso al crear un usuario, así que
  // tienePermiso() devuelve false hasta que un admin lo conceda manualmente
  // desde la matriz. 'costos' solo está en PERMISSIONS.admin/desarrollador.tabs
  // (visibilidad en nav) — si más adelante se le da el permiso a otro rol vía
  // la matriz, ese rol necesita además 'costos' en su lista de tabs para ver
  // el tile (mismo gap ya documentado para trabajadores_global/nominas_global).
  'costos',
  // prompt-p8-migracion-permisos-navegacion.md (diagnóstico): 'cotizador'
  // (tab de PERMISSIONS.compras) y 'estadoResultadosGlobal' (tab de
  // PERMISSIONS.tesoreria) no tenían sección propia — hoy no rompe nada
  // porque no existe ningún usuario real con puesto compras/tesorería, pero
  // dejaba el catálogo incompleto: si el día de mañana se crea uno, no
  // habría forma de otorgarle esa pestaña vía permisos_usuario. Se agregan
  // aquí para completar el catálogo antes de migrar la fuente de verdad de
  // navegación (ver TAB_A_SECCION más abajo) — sin enforcement real todavía
  // (mismo estado "informativo" que 'programa'/'estimaciones', ver
  // SECCIONES_CON_ENFORCEMENT en public/app.js).
  'cotizador', 'estado_resultados_global',
  // prompt-6-estado-unidad-operador.md: checklist de seguridad/preventivos
  // que captura el propio operador sobre su unidad asignada. Sección propia
  // (no comparte 'maquinaria_captura' con horas) porque el criterio de
  // ownership es distinto: horas se captura sobre cualquier equipo que el
  // operador trabaje ese día, estado_unidad SOLO sobre operador_asignado_id
  // — mezclarlas habría hecho que dar puede_crear en una diera sin querer la
  // otra. Sin entrada en TAB_A_SECCION a propósito: vive dentro del tab
  // 'maquinaria' existente (misma pantalla), no es un tab nuevo — mismo
  // criterio que 'maquinaria_captura'/'maquinaria_combustible' arriba.
  'estado_unidad',
  // prompt-10-programa-consumibles.md: registro de consumo de aceites
  // (motor/hidráulico/transmisión) por el operador sobre su unidad — diesel
  // NO vive aquí (decisión consultada: se captura vía 'maquinaria_combustible'
  // existente, ver server/app.js). Sección propia y separada de
  // 'maquinaria_combustible' a propósito: esa sección sigue siendo solo
  // jefe_maquinaria, y también gatea mantenimientos_maquinaria — darle a
  // operador puede_crear ahí le habría abierto esa tabla también (Forbidden
  // Action explícita del prompt).
  'maquinaria_consumibles',
];
const ACCIONES_PERMISOS = ['puede_ver', 'puede_crear', 'puede_editar', 'puede_editar_precios', 'puede_eliminar'];

// Traduce las pestañas de PERMISSIONS[puesto].tabs a secciones del sistema de
// permisos granulares. 'programa' y 'estimaciones' tienen su propia sección
// en el catálogo pero SIN enforcement real todavía (sus rutas siguen en
// auth.allow() legacy — ver SECCIONES_CON_ENFORCEMENT en public/app.js):
// aparecen en el panel como informativas hasta que se decida migrarlas a
// checkPermiso.
const TAB_A_SECCION = {
  resumen: 'presupuestos', programa: 'programa', contrato: 'contrato',
  impuestos: 'impuestos', insumos: 'insumos', requisiciones: 'requisiciones',
  ordenes: 'ordenes_compra', avance: 'avance', destajo: 'destajo',
  usuarios: 'usuarios', proveedores: 'proveedores', finanzas: 'finanzas',
  estadoResultados: 'estado_resultados',
  mapeo: 'mapeo', nominas: 'nominas', estimaciones: 'estimaciones',
  // Las 6 subpestañas de Maquinaria (prompt-39, galería de subsecciones)
  // mapean TODAS al mismo 'maquinaria' que antes mapeaba el único tab
  // 'maquinaria' — a propósito, NO a sus secciones granulares reales
  // (maquinaria_captura/maquinaria_combustible/estado_unidad/
  // maquinaria_consumibles): defaultPermisosParaRol() ya inyecta esas 4 por
  // bloques explícitos con valores puede_crear/puede_editar propios de cada
  // rol (ver más abajo) — si esta traducción genérica también las creara
  // por defecto, cada alta de cabo/jefe_maquinaria/operador insertaría una
  // fila DUPLICADA en permisos_usuario para esas secciones.
  maquinaria_catalogo: 'maquinaria', maquinaria_horas: 'maquinaria', maquinaria_bitacora: 'maquinaria',
  maquinaria_estado_unidad: 'maquinaria', maquinaria_consumibles: 'maquinaria', maquinaria_reportes_cliente: 'maquinaria',
  trabajadores: 'trabajadores',
  // prompt-p8-migracion-permisos-navegacion.md: completan el catálogo (ver
  // SECCIONES_PERMISOS arriba) — sin estos dos, defaultPermisosParaRol()
  // descartaba en silencio los tabs 'cotizador' (compras) y
  // 'estadoResultadosGlobal' (tesorería) por no tener sección mapeada.
  cotizador: 'cotizador', estadoResultadosGlobal: 'estado_resultados_global',
  // prompt-14-matrices-precio-unitario.md: 'matrices' reusa la sección
  // 'costos' (mismo tipo de dato). A diferencia del tab GLOBAL 'costos'
  // (catálogo cross-obra, deliberadamente SIN entrada aquí — ver comentario
  // de 'costos' en SECCIONES_PERMISOS), 'matrices' SÍ es por-obra, así que
  // sí debe resolverse por esta vía para que GET /api/projects/:id/nav-tabs
  // (server/app.js, fuente de verdad de navegación por-obra para roles
  // no-admin) le otorgue el tab a un residente con puede_ver=true en
  // 'costos' — sin este mapeo, el permiso quedaba concedido a nivel API
  // pero el tab nunca aparecía en su sidebar (confirmado con Playwright:
  // contenido servía 200 vía navegación directa, pero SECCION_A_TAB
  // descartaba 'costos' por no tener tab reverso, dejando el tab invisible).
  matrices: 'costos',
};

// Set de permisos default al dar de alta un usuario: puede_ver=true en las
// secciones ya cubiertas por sus tabs de rol (PERMISSIONS), más el mínimo de
// puede_crear/puede_editar necesario para que el rol siga operando igual que
// hoy en las secciones con enforcement real (nóminas, destajo, avance,
// requisiciones).
// puede_editar_precios y puede_eliminar quedan en false para todos por
// default — se conceden manualmente desde el panel de checkboxes.
function defaultPermisosParaRol(puesto) {
  const tabs = PERMISSIONS[puesto]?.tabs || [];
  const secciones = new Set(tabs.map((t) => TAB_A_SECCION[t]).filter(Boolean));
  secciones.add('sugerencias'); // accesible para todos los roles en la app
  const filas = [...secciones].map((seccion) => ({
    seccion, puede_ver: true, puede_crear: false, puede_editar: false,
    puede_editar_precios: false, puede_eliminar: false,
  }));
  const porSeccion = Object.fromEntries(filas.map((f) => [f.seccion, f]));
  if (puesto === 'residente' || puesto === 'cabo') {
    // 'proveedores' no está en las tabs de residente/cabo, así que el default
    // base no le crea fila — pero auth.allow('residente','cabo',...) ya le
    // daba lectura del catálogo (se usa para elegir proveedor al crear una
    // Orden de Compra) antes de que esta sección tuviera checkPermiso real.
    // Este default preserva solo esa lectura, sin crear/editar/eliminar
    // (prompt-checkpermiso-proveedores.md).
    if (!porSeccion.proveedores) {
      const filaProveedores = {
        seccion: 'proveedores', puede_ver: true, puede_crear: false,
        puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
      };
      filas.push(filaProveedores);
      porSeccion.proveedores = filaProveedores;
    }
  }
  if (puesto === 'residente') {
    if (porSeccion.nominas) { porSeccion.nominas.puede_crear = true; }
    // puede_eliminar=true (a diferencia del resto de secciones, donde eliminar
    // se concede manualmente): antes de que destajo tuviera checkPermiso real,
    // auth.allow('residente') ya le permitía eliminar destajistas/items sin
    // restricción adicional — este default preserva ese comportamiento.
    if (porSeccion.destajo) { porSeccion.destajo.puede_crear = true; porSeccion.destajo.puede_editar = true; porSeccion.destajo.puede_eliminar = true; }
    if (porSeccion.avance)  { porSeccion.avance.puede_crear = true; }
    // Mismo criterio que destajo arriba: auth.allow('residente','cabo','compras')
    // ya le permitía crear/editar/eliminar sus propias requisiciones (en
    // borrador) antes de que esta sección tuviera checkPermiso real — este
    // default preserva exactamente esa capacidad (prompt-requisiciones-permisos.md).
    if (porSeccion.requisiciones) { porSeccion.requisiciones.puede_crear = true; porSeccion.requisiciones.puede_editar = true; porSeccion.requisiciones.puede_eliminar = true; }
    // prompt-c-checkpermiso-trabajadores.md: mismo criterio que destajo/
    // requisiciones arriba — antes de este prompt, editar/eliminar/
    // documentos/contratos/EPP de trabajadores eran admin-only en código
    // (auth.allow() sin argumentos), PERO residente igual tenía acceso
    // porque auth.allow('residente') ya cubría ver/crear y el resto pasaba
    // por endpoints que en la práctica solo residente/admin usaban desde la
    // UI. Con checkPermiso real en todos los endpoints, este default
    // preserva exactamente la capacidad completa que residente ya tenía —
    // Forbidden Action explícita de este prompt: no debe requerir que Paul
    // reconfigure nada para residente.
    if (porSeccion.trabajadores) { porSeccion.trabajadores.puede_crear = true; porSeccion.trabajadores.puede_editar = true; porSeccion.trabajadores.puede_eliminar = true; }
  }
  if (puesto === 'cabo') {
    if (porSeccion.destajo) { porSeccion.destajo.puede_editar = true; }
    if (porSeccion.avance)  { porSeccion.avance.puede_crear = true; }
    // 'maquinaria' (equipos) queda como estaba — /api/maquinaria/equipos no
    // es parte de este fix (CN-002), solo se separa captura de horas.
    if (porSeccion.maquinaria) { porSeccion.maquinaria.puede_crear = true; }
    // prompt-3-flujo-aprobacion-cabo-operador.md: cabo ya NO captura horas
    // directamente (ese rol pasó a 'operador') — ahora solo autoriza o
    // rechaza los reportes que operador deja en 'pendiente' (puede_editar,
    // no puede_crear). Backfill para cabo ya existentes en server/db.js
    // (esta función solo aplica a altas nuevas).
    filas.push({
      seccion: 'maquinaria_captura', puede_ver: true, puede_crear: false,
      puede_editar: true, puede_editar_precios: false, puede_eliminar: false,
    });
    // Mismo criterio que residente arriba — cabo también podía crear/editar/
    // eliminar requisiciones por rol plano.
    if (porSeccion.requisiciones) { porSeccion.requisiciones.puede_crear = true; porSeccion.requisiciones.puede_editar = true; porSeccion.requisiciones.puede_eliminar = true; }
    // 'ordenes_compra' no está en las tabs de cabo, así que el default base
    // (vía TAB_A_SECCION) no le crea fila — pero auth.allow('cabo', ...) ya
    // le daba lectura del listado/detalle de OC antes de que esta sección
    // tuviera checkPermiso real. Este default preserva solo esa lectura, sin
    // crear/editar/eliminar (prompt-checkpermiso-ordenes-compra.md).
    if (!porSeccion.ordenes_compra) {
      const filaOrdenes = {
        seccion: 'ordenes_compra', puede_ver: true, puede_crear: false,
        puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
      };
      filas.push(filaOrdenes);
      porSeccion.ordenes_compra = filaOrdenes;
    }
    // prompt-c-checkpermiso-trabajadores.md (fix de nav): agregar
    // 'trabajadores' a PERMISSIONS.cabo.tabs (arriba) hace que el loop base
    // de esta función también le genere puede_ver=true por default — porque
    // 'trabajadores' SÍ está en TAB_A_SECCION (a diferencia de 'costos', que
    // se dejó fuera de ese mapeo a propósito para lograr default-deny real).
    // Eso anularía por completo el punto de que Paul otorgue el permiso a UN
    // cabo específico desde la matriz — CUALQUIER cabo nuevo lo tendría ya
    // de entrada. Override explícito: cabo parte en puede_ver=false para
    // 'trabajadores' (residente NO se toca, sigue con su default de
    // puede_ver=true de siempre) — el tab aparece en su nav (para que sepan
    // que la sección existe y pueden pedir acceso), pero sin el permiso
    // real hasta que un admin se lo conceda explícitamente por la matriz.
    if (porSeccion.trabajadores) { porSeccion.trabajadores.puede_ver = false; }
    // prompt-6-estado-unidad-operador.md: cabo SOLO lee el checklist de
    // todas las unidades de la obra (supervisión), nunca captura por esta
    // vía — coherente con que no capture horas tampoco (ver arriba).
    filas.push({
      seccion: 'estado_unidad', puede_ver: true, puede_crear: false,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
    // prompt-10-programa-consumibles.md: cabo solo ve el consumo de
    // aceites/diesel de todas las unidades, no captura por esta vía — mismo
    // criterio que estado_unidad arriba.
    filas.push({
      seccion: 'maquinaria_consumibles', puede_ver: true, puede_crear: false,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
  }
  if (puesto === 'compras') {
    // compras podía crear/editar/eliminar requisiciones de cualquier obra por
    // rol plano (a diferencia de residente/cabo, sin restricción de dueño —
    // ver requisicionAjena() en server/app.js, que solo acota a residente/cabo).
    if (porSeccion.requisiciones) { porSeccion.requisiciones.puede_crear = true; porSeccion.requisiciones.puede_editar = true; porSeccion.requisiciones.puede_eliminar = true; }
    // auth.allow('compras') ya le permitía crear/editar proveedores y dar de
    // baja/reactivar (PUT .../estado, mapeado a puede_eliminar) sin
    // restricción adicional — este default preserva esa capacidad
    // (prompt-checkpermiso-proveedores.md).
    if (porSeccion.proveedores) { porSeccion.proveedores.puede_crear = true; porSeccion.proveedores.puede_editar = true; porSeccion.proveedores.puede_eliminar = true; }
    // auth.allow('compras') ya le permitía generar OC desde una requisición
    // autorizada (puede_crear), cambiar su estado (puede_editar) y eliminarla
    // en borrador (puede_eliminar) sin restricción adicional — este default
    // preserva esa capacidad (prompt-checkpermiso-ordenes-compra.md).
    if (porSeccion.ordenes_compra) { porSeccion.ordenes_compra.puede_crear = true; porSeccion.ordenes_compra.puede_editar = true; porSeccion.ordenes_compra.puede_eliminar = true; }
  }
  if (puesto === 'tesoreria') {
    // auth.allow('compras', 'tesoreria') ya le permitía cambiar el estado de
    // una OC (incluyendo confirmar/rechazar, restringido aparte dentro del
    // propio handler a admin/tesorería) sin restricción adicional — este
    // default preserva esa capacidad (prompt-checkpermiso-ordenes-compra.md).
    if (porSeccion.ordenes_compra) { porSeccion.ordenes_compra.puede_editar = true; }
  }
  if (puesto === 'logistica') {
    // logistica no crea/edita el contenido de una requisición, pero sí podía
    // cambiar su estado (PUT .../estado, mapeado a puede_editar) por rol
    // plano — 'autorizada' sigue restringido a admin/logistica dentro del
    // propio handler, eso no cambia aquí.
    if (porSeccion.requisiciones) { porSeccion.requisiciones.puede_editar = true; }
  }
  if (puesto === 'administracion') {
    // prompt-p5-cuentas-bancarias.md: 'trabajadores_bancarios' SIN entrada en
    // TAB_A_SECCION (default-deny real, igual que 'costos') — el default para
    // administración se empuja aquí explícitamente, mismo patrón que
    // jefe_maquinaria con 'maquinaria_combustible' más abajo. puede_ver Y
    // puede_editar en true: el checkpoint del prompt pide que administración
    // pueda dar de alta un trabajador CON datos bancarios, no solo verlos.
    filas.push({
      seccion: 'trabajadores_bancarios', puede_ver: true, puede_crear: false,
      puede_editar: true, puede_editar_precios: false, puede_eliminar: false,
    });
  }
  if (puesto === 'jefe_maquinaria' || puesto === 'admin' || puesto === 'desarrollador') {
    // Registro de combustible/mantenimiento (mismo diseño de primer borrador).
    if (porSeccion.maquinaria) { porSeccion.maquinaria.puede_crear = true; porSeccion.maquinaria.puede_editar = true; }
  }
  if (puesto === 'jefe_maquinaria') {
    // CN-002: sección propia de combustible/mantenimiento — jefe_maquinaria
    // ya NO recibe puede_crear en 'maquinaria_captura' (antes lo tenía
    // implícito al compartir 'maquinaria' con cabo).
    filas.push({
      seccion: 'maquinaria_combustible', puede_ver: true, puede_crear: true,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
    // prompt-6-estado-unidad-operador.md: jefe_maquinaria lee el checklist
    // de todas las unidades (supervisión de taller), no captura por esta vía
    // — mismo criterio que cabo arriba.
    filas.push({
      seccion: 'estado_unidad', puede_ver: true, puede_crear: false,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
    // prompt-10-programa-consumibles.md: jefe_maquinaria solo ve el consumo
    // de aceites/diesel de todas las unidades — su propia captura de diesel
    // sigue siendo por 'maquinaria_combustible' (arriba), sin cambios.
    filas.push({
      seccion: 'maquinaria_consumibles', puede_ver: true, puede_crear: false,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
  }
  if (puesto === 'operador') {
    // Solo captura de horas/actividad (prompt-2-rol-operador-actividades.md)
    // — a diferencia de cabo, NO recibe puede_crear en 'maquinaria' (equipos)
    // ni en 'maquinaria_combustible'; a diferencia de jefe_maquinaria, no
    // toca combustible/mantenimiento. Ningún permiso de aprobar/autorizar.
    filas.push({
      seccion: 'maquinaria_captura', puede_ver: true, puede_crear: true,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
    // prompt-6-estado-unidad-operador.md: único rol que captura el checklist
    // de estado de unidad — el backend valida ownership real (operador_
    // asignado_id) antes de cualquier INSERT, esto solo habilita el intento.
    filas.push({
      seccion: 'estado_unidad', puede_ver: true, puede_crear: true,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
    // prompt-10-programa-consumibles.md: operador captura consumo de aceites
    // Y de diesel (diesel vía POST /api/maquinaria/consumibles, que escribe
    // en combustible_maquinaria con su propia validación de ownership — NO
    // vía 'maquinaria_combustible', que sigue siendo solo jefe_maquinaria y
    // también gatea mantenimientos_maquinaria).
    filas.push({
      seccion: 'maquinaria_consumibles', puede_ver: true, puede_crear: true,
      puede_editar: false, puede_editar_precios: false, puede_eliminar: false,
    });
  }
  return filas;
}

// Consulta directa (sin middleware) de un permiso puntual — usado dentro de
// un handler cuando la decisión no es "bloquear toda la request" sino, p.ej.,
// ignorar en silencio un campo del payload (ver precio_destajo en /destajistas
// .../items). admin/desarrollador siempre true.
async function tienePermiso(req, seccion, accion) {
  if (!SECCIONES_PERMISOS.includes(seccion)) throw new Error(`tienePermiso: sección inválida '${seccion}'`);
  if (!ACCIONES_PERMISOS.includes(accion)) throw new Error(`tienePermiso: acción inválida '${accion}'`);
  if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') return true;
  const projectId = req.project ? req.project.id : null;
  const { rows } = await db.pool.query(
    `SELECT ${accion} AS ok FROM permisos_usuario
     WHERE usuario_id = $1 AND seccion = $2 AND (proyecto_id = $3 OR proyecto_id IS NULL)
     ORDER BY proyecto_id NULLS LAST LIMIT 1`,
    [req.user.id, seccion, projectId]
  );
  return !!rows[0]?.ok;
}

// Middleware: exige que el usuario tenga `accion` (una de ACCIONES_PERMISOS)
// en `seccion` (una de SECCIONES_PERMISOS), consultando permisos_usuario.
// admin/desarrollador siempre pasan (bypass hardcodeado, no dependen de la
// tabla). Si hay una fila con proyecto_id específico Y otra con proyecto_id
// NULL (aplica a todas sus obras) para la misma sección, gana la específica.
// Debe ir después de requireProject cuando el endpoint es de una obra.
function checkPermiso(seccion, accion) {
  if (!SECCIONES_PERMISOS.includes(seccion)) throw new Error(`checkPermiso: sección inválida '${seccion}'`);
  if (!ACCIONES_PERMISOS.includes(accion)) throw new Error(`checkPermiso: acción inválida '${accion}'`);
  return async (req, res, next) => {
    if (await tienePermiso(req, seccion, accion)) return next();
    logDenied(req, `sin permiso '${accion}' en sección '${seccion}'`);
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  };
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, nombre: user.nombre, usuario: user.usuario, puesto: user.puesto },
    SESSION_SECRET,
    { expiresIn: TOKEN_TTL, algorithm: 'HS256' }
  );
}

function signRefreshToken(user) {
  return jwt.sign({ id: user.id, usuario: user.usuario }, SESSION_SECRET, { expiresIn: REFRESH_TTL, algorithm: 'HS256' });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, SESSION_SECRET, { algorithms: ['HS256'] });
}

// Construye el valor de la cookie Set-Cookie para el refresh token.
function buildRefreshCookie(token, clear = false) {
  // VERCEL_ENV es la señal autoritativa en Vercel (production/preview/development);
  // NODE_ENV no está garantizado en cada invocación serverless. Fallback a NODE_ENV
  // fuera de Vercel (dev local / server/index.js standalone).
  const isProd = process.env.VERCEL_ENV ? process.env.VERCEL_ENV !== 'development' : process.env.NODE_ENV === 'production';
  const maxAge = clear ? 0 : 7 * 24 * 60 * 60; // 7 días en segundos
  const value = clear ? '' : encodeURIComponent(token);
  return `${REFRESH_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/auth/refresh; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;
}

// Token intermedio (5 min) entre password OK y el 2° factor TOTP. stage:'pre_totp'
// impide que requireAuth lo acepte como sesión completa aunque alguien lo mande
// como Bearer a un endpoint protegido. enroll=true cuando es inscripción forzada
// (primer login sin TOTP configurado) vs. login normal ya inscrito.
function signPreAuthToken(user, { enroll = false } = {}) {
  return jwt.sign({ id: user.id, usuario: user.usuario, stage: 'pre_totp', enroll }, SESSION_SECRET, { expiresIn: PRE_AUTH_TTL, algorithm: 'HS256' });
}

function verifyPreAuthToken(token) {
  const decoded = jwt.verify(token, SESSION_SECRET, { algorithms: ['HS256'] });
  if (decoded.stage !== 'pre_totp') throw new Error('Token no es de pre-autenticación');
  return decoded;
}

// ---------------------------------------------------------------------------
// TOTP (2FA) — el secret se cifra en reposo (AES-256-GCM) porque, a diferencia
// de una contraseña, necesita ser recuperable para poder verificar el código.
// ---------------------------------------------------------------------------
function encryptTotpSecret(plainBase32) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOTP_ENC_KEY_BUF, iv);
  const enc = Buffer.concat([cipher.update(plainBase32, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptTotpSecret(stored) {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', TOTP_ENC_KEY_BUF, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// Genera un secret TOTP nuevo (base32, sin cifrar — se cifra al guardarlo en DB).
function generateTotpSecret() {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

// URI otpauth:// para el QR (Google Authenticator, Authy, etc.)
function buildTotpUri(usuario, secretBase32) {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: usuario,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

// Verifica un código de 6 dígitos contra el secret (base32, ya descifrado).
// window:1 tolera desfase de reloj de ±30s en el dispositivo del usuario.
function verifyTotpCode(secretBase32, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.validate({ token: String(code), window: 1 }) !== null;
}

// Genera N códigos de respaldo (formato XXXX-XXXX legible) — se devuelven en
// claro UNA sola vez al llamador; solo el hash de cada uno se persiste.
async function generateBackupCodes(count = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusión
  const rawCodes = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let b = 0; b < 8; b++) code += alphabet[bytes[b] % alphabet.length];
    rawCodes.push(code);
  }
  // Se hashea el código "en crudo" (sin guion); el guion es solo cosmético al mostrarlo.
  const hashed = await Promise.all(rawCodes.map(async (code) => ({ hash: await bcrypt.hash(code, 10), used: false })));
  const plain = rawCodes.map((c) => `${c.slice(0, 4)}-${c.slice(4)}`);
  return { plain, hashed };
}

// Busca un código de respaldo válido y no usado dentro del array almacenado
// (JSONB [{hash, used}]). Devuelve el índice del que coincide, o -1 si ninguno.
async function findBackupCodeIndex(inputCode, storedCodes) {
  const norm = String(inputCode || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!norm || !Array.isArray(storedCodes)) return -1;
  for (let i = 0; i < storedCodes.length; i++) {
    if (storedCodes[i].used) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(norm, storedCodes[i].hash)) return i;
  }
  return -1;
}

// Exige un token válido en Authorization: Bearer <token>; deja al usuario en req.user.
// Verifica además que el token no fue revocado (iat > token_valid_since en DB).
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  let decoded;
  try {
    decoded = jwt.verify(token, SESSION_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada, inicia sesión de nuevo' });
  }
  // El token intermedio de pre-TOTP (5 min) nunca debe servir como sesión completa,
  // aunque alguien lo mande como Bearer antes de completar el 2° factor.
  if (decoded.stage === 'pre_totp') {
    return res.status(401).json({ error: 'Falta completar la verificación en dos pasos' });
  }
  try {
    const { rows } = await db.pool.query(
      'SELECT token_valid_since FROM usuarios WHERE id = $1 AND activo = true',
      [decoded.id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Sesión inválida' });
    // token_valid_since llega de server/db.js como 'YYYY-MM-DD HH:MM:SS' (el
    // type parser global le quita la zona) pero el valor en sí SIEMPRE es
    // UTC (así lo persiste Postgres para TIMESTAMPTZ) — sin el '+ Z', new
    // Date() lo interpreta como hora LOCAL del proceso, no UTC. En un proceso
    // corriendo en una zona detrás de UTC eso corre la comparación hacia
    // adelante y revoca sesiones recién emitidas que no deberían estarlo.
    const validSinceMs = new Date(`${rows[0].token_valid_since}Z`).getTime();
    // iat es en segundos; si fue emitido en el mismo instante o antes de la revocación, se rechaza
    if (decoded.iat * 1000 <= validSinceMs) {
      return res.status(401).json({ error: 'Sesión revocada, inicia sesión de nuevo' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    next(err);
  }
}

// Extrae IP del request para rate-limiting y audit_log. X-Forwarded-For es
// un header que CUALQUIER cliente puede mandar con cualquier valor — solo es
// confiable si hay un proxy/edge delante (Vercel) que lo sobreescribe él
// mismo. Sin TRUST_PROXY=1 explícito (seteado en Vercel, no en dev/LAN vía
// server/index.js), se ignora y se usa la IP real del socket.
function getIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Inserta en audit_log de forma fire-and-forget: no bloquea la respuesta.
function logDenied(req, razon) {
  const ip = getIp(req);
  db.pool.query(
    'INSERT INTO audit_log (actor_id, actor_usuario, accion, target_usuario, ip) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, req.user.usuario, 'acceso_denegado', `${req.method} ${req.originalUrl} — ${razon}`, ip]
  ).catch(() => {});
}

// Restringe la ruta a los puestos indicados; 'admin' y 'desarrollador' siempre pasan.
function allow(...puestos) {
  return (req, res, next) => {
    const p = req.user?.puesto;
    if (p === 'admin' || p === 'desarrollador' || puestos.includes(p)) return next();
    logDenied(req, `puesto '${p}' no permitido`);
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  };
}

// Control de Cuentas (prompt-control-cuentas.md) — control personal de
// saldo bancario de Paul y Fer, NO del negocio en general. Whitelist por
// usuario_id EXPLÍCITA, deliberadamente separada de allow('admin',
// 'desarrollador'): el bypass normal de esos 2 roles es por PUESTO (ver
// allow() arriba), y hoy existen 5 cuentas con esos roles (confirmado en
// diagnóstico: 'admin' bootstrap genérico, Rodolfo Ocampo, y una segunda
// cuenta "Fernando Olvera" que NO es la de Fer) — cualquier futuro alta de
// usuario admin/desarrollador habría visto este saldo personal sin este
// candado adicional. 46 = Paul (paul.ocmp, desarrollador). 8 = Fer (folvera,
// Fernando Olvera Monroy, admin) — confirmado explícitamente con Paul, NO
// el id=105 "Fernando Olvera Herrera" (apellido distinto, cuenta distinta).
// Cambiar esta lista requiere editar código + nuevo commit a propósito (sin
// UI de gestión — decisión consultada: 1-2 personas, cambia rarísima vez).
const USUARIOS_CONTROL_CUENTAS = [46, 8];
function requireControlCuentasAccess(req, res, next) {
  if (!USUARIOS_CONTROL_CUENTAS.includes(req.user.id)) {
    logDenied(req, 'sin acceso a Control de Cuentas (whitelist)');
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  next();
}

// Control Financiero Fase 1 (prompt-27-control-financiero-fase1.md) —
// Ingresos (facturación/cobro) y Gastos Indirectos Corporativos. Mismo
// patrón de whitelist que Control de Cuentas (CP0 punto 3, confirmado con
// SELECT real: 46 = Paul, 8 = Fer) pero constante INDEPENDIENTE a
// propósito — aunque hoy tenga los mismos 2 IDs, es un candado distinto
// para un dato distinto (finanzas del negocio, no saldo personal); que
// cambien juntos hoy no debe implicar que evolucionen acopladas mañana.
const USUARIOS_CONTROL_FINANCIERO = [46, 8];
function requireControlFinancieroAccess(req, res, next) {
  if (!USUARIOS_CONTROL_FINANCIERO.includes(req.user.id)) {
    logDenied(req, 'sin acceso a Control Financiero (whitelist)');
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  next();
}

// Estado de Resultados (prompt-36-control-financiero-fase3-4.md, punto 3) —
// migrado de auth.allow('tesoreria') a esta whitelist. Confirmado con SELECT
// real contra Producción antes del cambio: 0 usuarios con puesto 'tesoreria'
// hoy, así que nadie pierde acceso real. Constante INDEPENDIENTE de
// USUARIOS_CONTROL_CUENTAS/USUARIOS_CONTROL_FINANCIERO por el mismo motivo
// que esas dos son independientes entre sí — mismos 2 IDs hoy, candados
// separados a propósito.
const USUARIOS_ESTADO_RESULTADOS = [46, 8];
function requireEstadoResultadosAccess(req, res, next) {
  if (!USUARIOS_ESTADO_RESULTADOS.includes(req.user.id)) {
    logDenied(req, 'sin acceso a Estado de Resultados (whitelist)');
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  next();
}

// Contabilidad Fase 1 (prompt-contabilidad-fase1-cuentas-polizas.md) —
// catálogo de cuentas contables + pólizas. Mismo patrón de whitelist que
// Control de Cuentas/Control Financiero/Estado de Resultados arriba, pero
// constante INDEPENDIENTE a propósito (mismo criterio documentado en esas
// tres: aunque hoy tenga los mismos 2 IDs, un candado distinto para un dato
// distinto no debe evolucionar acoplado a los otros).
//
// prompt-contabilidad-acceso-admin.md: a diferencia de las 3 constantes
// hermanas (whitelist pura, deliberadamente SIN bypass de rol — ver sus
// propios comentarios), Contabilidad además da acceso automático a
// admin/desarrollador — mismo criterio que allow()/tienePermiso() en el
// resto del sistema, donde esos dos roles siempre tienen bypass universal.
// USUARIOS_CONTABILIDAD en sí NO se toca (conserva el acceso ya otorgado
// por ID a cuentas que no sean admin/desarrollador, ej. si algún día se
// suma un contador externo con otro rol).
const USUARIOS_CONTABILIDAD = [46, 8];
function tieneAccesoContabilidad(user) {
  return user.puesto === 'admin' || user.puesto === 'desarrollador' || USUARIOS_CONTABILIDAD.includes(user.id);
}
function requireContabilidadAccess(req, res, next) {
  if (!tieneAccesoContabilidad(req.user)) {
    logDenied(req, 'sin acceso a Contabilidad (whitelist)');
    return res.status(403).json({ error: 'No tienes permiso para realizar esta acción' });
  }
  next();
}

// Los 5 tabs reales de Contabilidad (prompt-contabilidad-galeria-tiles.md —
// antes un solo tab 'contabilidad' con subnav interno, ver public/app.js
// CONTABILIDAD_TABS, misma lista literal duplicada aquí porque este archivo
// no comparte módulo con el frontend). Cambiar el mecanismo de navegación
// (subnav -> galería de tiles) no cambia QUIÉN tiene acceso — tieneAccesoContabilidad
// sigue siendo exactamente el mismo criterio (whitelist OR admin/desarrollador).
const CONTABILIDAD_TABS = ['contabilidadCuentas', 'contabilidadPolizas', 'contabilidadCfdi', 'contabilidadConciliacion', 'contabilidadDepreciacion', 'contabilidadExport'];

// Agrega los tabs 'cuentas'/'controlFinanciero'/CONTABILIDAD_TABS a la lista
// SOLO para los usuarios en la whitelist correspondiente — el resto de
// admin/desarrollador (incluida la cuenta bootstrap genérica y cualquier
// alta futura) ni siquiera ve el link en el sidebar, EXCEPTO para
// Contabilidad (ver tieneAccesoContabilidad arriba), que sí es visible
// para cualquier admin/desarrollador. Ocultar el tab es solo cortesía de UI
// (nunca el gate real — ver requireControlCuentasAccess/
// requireControlFinancieroAccess/requireContabilidadAccess arriba, que es
// lo único que de verdad protege los datos); por eso vive como wrapper
// sobre PERMISSIONS.tabs en vez de duplicar la lista de tabs por usuario.
function tabsParaUsuario(user) {
  const base = PERMISSIONS[user.puesto] ? PERMISSIONS[user.puesto].tabs : [];
  const extra = [];
  if (USUARIOS_CONTROL_CUENTAS.includes(user.id) && !base.includes('cuentas')) extra.push('cuentas');
  if (USUARIOS_CONTROL_FINANCIERO.includes(user.id) && !base.includes('controlFinanciero')) extra.push('controlFinanciero');
  if (USUARIOS_ESTADO_RESULTADOS.includes(user.id)) {
    if (!base.includes('estadoResultados')) extra.push('estadoResultados');
    if (!base.includes('estadoResultadosGlobal')) extra.push('estadoResultadosGlobal');
  }
  if (tieneAccesoContabilidad(user)) {
    CONTABILIDAD_TABS.forEach((t) => { if (!base.includes(t)) extra.push(t); });
  }
  return extra.length ? [...base, ...extra] : base;
}

// Restringe el acceso a la obra (proyecto) cargada por requireProject: el
// admin siempre pasa; el resto solo si tiene una fila en usuario_proyectos
// para ese project_id. Debe ir después de requireProject en la cadena.
async function verificarAccesoObra(req, res, next) {
  if (req.user.puesto === 'admin' || req.user.puesto === 'desarrollador') return next();
  const projectId = req.project ? req.project.id : Number(req.params.id);
  const { rows } = await db.pool.query(
    'SELECT 1 FROM usuario_proyectos WHERE usuario_id = $1 AND project_id = $2',
    [req.user.id, projectId]
  );
  if (!rows.length) {
    logDenied(req, `sin acceso a obra ${projectId}`);
    return res.status(403).json({ error: 'No tienes acceso a esta obra' });
  }
  next();
}

// Crea el primer usuario administrador si la tabla de usuarios está vacía,
// para poder entrar la primera vez y dar de alta al resto desde la app.
async function ensureBootstrapAdmin() {
  const { rows } = await db.pool.query('SELECT COUNT(*) AS n FROM usuarios');
  if (Number(rows[0].n) > 0) return;
  const usuario = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('ADMIN_PASSWORD no está configurada en las variables de entorno — no se puede crear el administrador inicial sin ella.');
  }
  const hash = await hashPassword(password);
  await db.pool.query(
    'INSERT INTO usuarios (nombre, usuario, password_hash, puesto) VALUES ($1,$2,$3,$4)',
    ['Administrador', usuario, hash, 'admin']
  );
  // eslint-disable-next-line no-console
  console.log(`Usuario administrador inicial creado: "${usuario}" — cambia la contraseña después de iniciar sesión.`);
}

module.exports = {
  PERMISSIONS,
  PUESTOS,
  REFRESH_COOKIE,
  isValidPuesto,
  hashPassword,
  verifyPassword,
  signToken,
  signRefreshToken,
  verifyRefreshToken,
  buildRefreshCookie,
  signPreAuthToken,
  verifyPreAuthToken,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  buildTotpUri,
  verifyTotpCode,
  generateBackupCodes,
  findBackupCodeIndex,
  requireAuth,
  allow,
  requireControlCuentasAccess,
  requireControlFinancieroAccess,
  requireEstadoResultadosAccess,
  requireContabilidadAccess,
  tabsParaUsuario,
  verificarAccesoObra,
  ensureBootstrapAdmin,
  SECCIONES_PERMISOS,
  ACCIONES_PERMISOS,
  TAB_A_SECCION,
  defaultPermisosParaRol,
  checkPermiso,
  tienePermiso,
  logDenied,
  getIp,
};
