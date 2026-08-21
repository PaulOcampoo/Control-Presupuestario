'use strict';

const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings (not JS Date objects)
types.setTypeParser(1082, (val) => val);
// Return TIMESTAMP / TIMESTAMPTZ as 'YYYY-MM-DD HH:MM:SS' strings
types.setTypeParser(1114, (val) => (val ? val.slice(0, 19).replace('T', ' ') : val));
types.setTypeParser(1184, (val) => (val ? val.slice(0, 19).replace('T', ' ') : val));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS proyectos (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    archivo_original TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS meta (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    clave TEXT NOT NULL,
    valor TEXT,
    UNIQUE (project_id, clave)
  );

  CREATE TABLE IF NOT EXISTS conceptos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    codigo TEXT,
    concepto TEXT NOT NULL,
    unidad TEXT,
    cantidad DOUBLE PRECISION DEFAULT 0,
    precio_unitario DOUBLE PRECISION DEFAULT 0,
    importe DOUBLE PRECISION DEFAULT 0,
    grupo TEXT,
    es_total INTEGER DEFAULT 0,
    orden INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_conceptos_project ON conceptos(project_id);

  -- Actualización de presupuesto preservando avance (DISEÑO-ACTUALIZACION-
  -- PRESUPUESTO.md): un concepto que ya no aparece en una carga nueva del
  -- Excel se marca activo=0 en vez de borrarse — preserva su avance
  -- histórico (avance_conceptos) y su mapeo de insumos (concepto_insumos)
  -- intactos vía ON DELETE CASCADE, que nunca se dispara porque nunca hay
  -- DELETE. Las consultas de presupuesto activo deben filtrar activo=1; el
  -- historial de avance de un concepto desactivado sigue siendo consultable
  -- sin filtrar por esta columna.
  ALTER TABLE conceptos ADD COLUMN IF NOT EXISTS activo INTEGER DEFAULT 1;

  CREATE TABLE IF NOT EXISTS insumos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    codigo TEXT,
    concepto TEXT NOT NULL,
    categoria TEXT,
    unidad TEXT,
    cantidad_presupuesto DOUBLE PRECISION DEFAULT 0,
    precio_presupuesto DOUBLE PRECISION DEFAULT 0,
    importe_presupuesto DOUBLE PRECISION DEFAULT 0,
    orden INTEGER DEFAULT 0,
    iva_tasa DOUBLE PRECISION NOT NULL DEFAULT 16
  );
  CREATE INDEX IF NOT EXISTS idx_insumos_project ON insumos(project_id);

  CREATE TABLE IF NOT EXISTS concepto_insumos (
    id SERIAL PRIMARY KEY,
    concepto_id INTEGER NOT NULL REFERENCES conceptos(id) ON DELETE CASCADE,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
    UNIQUE (concepto_id, insumo_id)
  );
  CREATE INDEX IF NOT EXISTS idx_conceptoinsumos_concepto ON concepto_insumos(concepto_id);
  CREATE INDEX IF NOT EXISTS idx_conceptoinsumos_insumo ON concepto_insumos(insumo_id);

  -- Matrices de precio unitario (prompt-14-matrices-precio-unitario.md).
  -- Diagnóstico confirmado con Paul: tabla propia, NUNCA concepto_insumos —
  -- esa tabla es el mapeo admin-curado que alimenta "avance requiere entrega"
  -- (insumosPendientesPorConcepto, server/app.js); poblarla con renglones de
  -- Mano de Obra/Herramienta (que nunca pasan por requisición→OC→recepción)
  -- habría bloqueado esos conceptos para siempre en captura de avance.
  -- Además concepto_insumos no tiene columna cantidad — no serviría ni
  -- aunque quisiéramos.
  -- Fórmula en cascada (estándar MX, confirmada con Paul — utilidad sobre el
  -- costo ya indirectado, no sobre el directo):
  --   CD = materiales + mano_obra + herramienta_equipo (por insumos.categoria)
  --   precio_unitario = CD × (1 + %indirecto/100) × (1 + %utilidad/100)
  -- pct_indirecto/pct_utilidad se guardan POR MATRIZ (snapshot) — actualizar
  -- porcentajes_referencia_costo (PR #48) o porcentajes_matriz_obra (abajo)
  -- nunca altera retroactivamente una matriz ya creada.
  CREATE TABLE IF NOT EXISTS matrices_precio_unitario (
    id SERIAL PRIMARY KEY,
    concepto_id INTEGER NOT NULL UNIQUE REFERENCES conceptos(id) ON DELETE CASCADE,
    pct_indirecto DOUBLE PRECISION NOT NULL DEFAULT 0,
    pct_utilidad DOUBLE PRECISION NOT NULL DEFAULT 0,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_por INTEGER REFERENCES usuarios(id),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- prompt-20-matrices-formato-neodata.md: PR #98 simplificó la fórmula real
  -- (era un error de especificación, no de implementación) — estas columnas
  -- faltaban para modelar el Análisis de Precios Unitarios formato Neodata
  -- real: cuadrilla (MO = suma de jornales ÷ rendimiento, no cantidad×precio),
  -- cascada de 4 niveles con financiamiento, y encabezado formal del análisis.
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS pct_financiamiento DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS rendimiento DOUBLE PRECISION;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS partida TEXT;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS analisis_no TEXT;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS cuadrilla_nombre TEXT;

  -- prompt-matrices-basicos-anidados.md: soporte de "básicos" (análisis
  -- reutilizables, ej. una receta de concreto) que se insertan como un solo
  -- renglón dentro de OTRO análisis, divididos... en realidad MULTIPLICADOS
  -- por un "Volumen" propio de cada uso (verificado contra el Excel real de
  -- referencia — la fórmula de Neodata dice "Volumen" pero la operación real
  -- es Importe_básico × Volumen, igual que cualquier renglón cantidad×precio;
  -- ver factor_referencia/cantidad reutilizados en matriz_precio_renglones
  -- más abajo, nunca se agregó un campo "divisor").
  -- Un básico NO corresponde a un renglón real del presupuesto (concepto_id),
  -- así que concepto_id se vuelve NULLABLE: una matriz es O bien la matriz de
  -- un concepto real (concepto_id NOT NULL, es_basico=false, como hasta hoy)
  -- O bien un básico standalone reutilizable (es_basico=true, concepto_id
  -- NULL, con su propia identidad codigo/descripcion/unidad — mismo patrón
  -- que ya usan los renglones tipo='factor_pct' sin insumo_id) — nunca ambas
  -- cosas a la vez, para no complicar qué pasa si el concepto real cambia.
  -- project_id explícito porque un básico sin concepto no hereda obra vía
  -- JOIN a conceptos.
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS es_basico BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS codigo TEXT;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS descripcion TEXT;
  ALTER TABLE matrices_precio_unitario ADD COLUMN IF NOT EXISTS unidad TEXT;
  ALTER TABLE matrices_precio_unitario ALTER COLUMN concepto_id DROP NOT NULL;
  ALTER TABLE matrices_precio_unitario DROP CONSTRAINT IF EXISTS matrices_precio_unitario_concepto_xor_basico_check;
  ALTER TABLE matrices_precio_unitario ADD CONSTRAINT matrices_precio_unitario_concepto_xor_basico_check CHECK (
    (concepto_id IS NOT NULL AND es_basico = false)
    OR (concepto_id IS NULL AND es_basico = true AND project_id IS NOT NULL AND codigo IS NOT NULL AND descripcion IS NOT NULL)
  );

  -- Reemplaza matriz_precio_items (prompt-20-matrices-formato-neodata.md,
  -- decisión confirmada con Paul: las 2 matrices de prueba en Producción y la
  -- de Preview se pierden a propósito, autorizado explícitamente — no había
  -- ninguna matriz real en uso). El modelo (insumo_id, cantidad) de la tabla
  -- vieja no puede representar un renglón %MO* (que no es un insumo, referencia
  -- el subtotal de OTRA categoría) ni distinguir Mano de Obra (cuadrilla ÷
  -- rendimiento) de Materiales/Equipo (cantidad × precio directo).
  DROP TABLE IF EXISTS matriz_precio_items;
  CREATE TABLE IF NOT EXISTS matriz_precio_renglones (
    id SERIAL PRIMARY KEY,
    matriz_id INTEGER NOT NULL REFERENCES matrices_precio_unitario(id) ON DELETE CASCADE,
    categoria TEXT NOT NULL CHECK (categoria IN ('MATERIALES','MANO DE OBRA','EQUIPO Y HERRAMIENTA')),
    tipo TEXT NOT NULL DEFAULT 'insumo' CHECK (tipo IN ('insumo','factor_pct')),
    insumo_id INTEGER REFERENCES insumos(id) ON DELETE CASCADE,
    -- Solo para tipo='factor_pct' (ej. "%MO1" / "HERRAMIENTA MENOR") — no
    -- tiene insumo_id que le dé código/descripción, así que los lleva
    -- propios. Para tipo='insumo' se ignoran, el código/descripción real
    -- viene del JOIN con insumos.
    codigo TEXT,
    descripcion TEXT,
    cantidad DOUBLE PRECISION NOT NULL,
    factor_referencia TEXT CHECK (factor_referencia IN ('MATERIALES','MANO DE OBRA','EQUIPO Y HERRAMIENTA')),
    orden INTEGER NOT NULL DEFAULT 0,
    UNIQUE (matriz_id, insumo_id)
  );
  CREATE INDEX IF NOT EXISTS idx_matrizrenglones_matriz ON matriz_precio_renglones(matriz_id);
  CREATE INDEX IF NOT EXISTS idx_matrizrenglones_insumo ON matriz_precio_renglones(insumo_id);
  ALTER TABLE matriz_precio_renglones ADD COLUMN IF NOT EXISTS codigo TEXT;
  ALTER TABLE matriz_precio_renglones ADD COLUMN IF NOT EXISTS descripcion TEXT;

  -- prompt-matrices-basicos-anidados.md: tipo='basico_ref' referencia OTRA
  -- matriz (marcada es_basico=true) en vez de un insumo o un factor. Reusa
  -- la columna cantidad ya existente como el "Volumen" de la referencia
  -- (multiplicador, no divisor — ver comentario en matrices_precio_unitario
  -- arriba); insumo_id queda NULL igual que en factor_pct.
  -- operador es la pieza genuinamente nueva de cálculo: dentro de un
  -- básico, el renglón de cuadrilla viene pre-agregado en una sola fila con
  -- un "/" explícito (ej. "1A5P ... 5218.31 / 12 = 434.86"), a diferencia
  -- del patrón ya existente en matrices normales (varias filas '*' sumadas
  -- y divididas UNA vez entre matriz.rendimiento, mostrado aparte en la fila
  -- "Rendimiento:"). Default '*' preserva el cálculo de TODOS los renglones
  -- ya existentes sin cambio (cantidad×precio, como siempre).
  ALTER TABLE matriz_precio_renglones ADD COLUMN IF NOT EXISTS operador TEXT NOT NULL DEFAULT '*';
  ALTER TABLE matriz_precio_renglones DROP CONSTRAINT IF EXISTS matriz_precio_renglones_operador_check;
  ALTER TABLE matriz_precio_renglones ADD CONSTRAINT matriz_precio_renglones_operador_check CHECK (operador IN ('*','/'));
  ALTER TABLE matriz_precio_renglones ADD COLUMN IF NOT EXISTS basico_matriz_id INTEGER REFERENCES matrices_precio_unitario(id) ON DELETE RESTRICT;
  -- ON DELETE RESTRICT (no CASCADE): un básico referenciado desde otros
  -- análisis no debe poder borrarse "por accidente" arrastrando consigo el
  -- renglón que lo consume en otro análisis — forzar a que primero se quite
  -- la referencia. Distinto del resto de FKs de esta tabla (insumo_id,
  -- matriz_id) que sí son CASCADE porque ahí "borrar el padre" es
  -- exactamente la intención (borrar la matriz completa).
  ALTER TABLE matriz_precio_renglones DROP CONSTRAINT IF EXISTS matriz_precio_renglones_tipo_check;
  ALTER TABLE matriz_precio_renglones ADD CONSTRAINT matriz_precio_renglones_tipo_check CHECK (tipo IN ('insumo','factor_pct','basico_ref'));
  ALTER TABLE matriz_precio_renglones DROP CONSTRAINT IF EXISTS matriz_precio_renglones_categoria_check;
  ALTER TABLE matriz_precio_renglones ADD CONSTRAINT matriz_precio_renglones_categoria_check CHECK (categoria IN ('MATERIALES','MANO DE OBRA','EQUIPO Y HERRAMIENTA','BASICOS'));

  -- % de indirecto/utilidad por defecto de una obra (cada contrato se cotiza
  -- distinto — porcentajes_referencia_costo de PR #48 es un set global único,
  -- no sirve como default por obra). Se usa SOLO para prellenar una matriz
  -- NUEVA; nunca se lee retroactivamente desde una matriz ya creada.
  CREATE TABLE IF NOT EXISTS porcentajes_matriz_obra (
    project_id INTEGER PRIMARY KEY REFERENCES proyectos(id) ON DELETE CASCADE,
    pct_indirecto DOUBLE PRECISION NOT NULL DEFAULT 0,
    pct_utilidad DOUBLE PRECISION NOT NULL DEFAULT 0,
    actualizado_por INTEGER REFERENCES usuarios(id),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- prompt-20-matrices-formato-neodata.md: la cascada real agrega (CF)
  -- Financiamiento como tercer porcentaje, mismo criterio que indirecto/
  -- utilidad — default por obra, snapshot por matriz al crearse.
  ALTER TABLE porcentajes_matriz_obra ADD COLUMN IF NOT EXISTS pct_financiamiento DOUBLE PRECISION NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS requisiciones (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    folio TEXT,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    estado TEXT NOT NULL DEFAULT 'borrador',
    observaciones TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS requisicion_items (
    id SERIAL PRIMARY KEY,
    requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id) ON DELETE CASCADE,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id),
    cantidad_solicitada DOUBLE PRECISION DEFAULT 0,
    precio_solicitado DOUBLE PRECISION DEFAULT 0,
    importe DOUBLE PRECISION DEFAULT 0,
    alerta_cantidad INTEGER DEFAULT 0,
    alerta_precio INTEGER DEFAULT 0,
    observaciones TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reqitems_req ON requisicion_items(requisicion_id);
  CREATE INDEX IF NOT EXISTS idx_reqitems_insumo ON requisicion_items(insumo_id);

  CREATE TABLE IF NOT EXISTS avances_semanales (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    semana INTEGER NOT NULL,
    fecha_inicio DATE,
    fecha_fin DATE,
    avance_fisico_programado DOUBLE PRECISION DEFAULT 0,
    avance_fisico_real DOUBLE PRECISION,
    avance_financiero_programado DOUBLE PRECISION DEFAULT 0,
    avance_financiero_real DOUBLE PRECISION,
    UNIQUE (project_id, semana)
  );

  CREATE TABLE IF NOT EXISTS avance_conceptos (
    id SERIAL PRIMARY KEY,
    semana INTEGER NOT NULL,
    concepto_id INTEGER NOT NULL REFERENCES conceptos(id) ON DELETE CASCADE,
    cantidad_ejecutada DOUBLE PRECISION DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (semana, concepto_id)
  );

  CREATE TABLE IF NOT EXISTS programa_ejecucion (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    codigo TEXT,
    concepto TEXT NOT NULL,
    grupo TEXT,
    fecha_inicio DATE,
    fecha_fin DATE,
    duracion_dias INTEGER,
    importe DOUBLE PRECISION DEFAULT 0,
    peso_pct DOUBLE PRECISION DEFAULT 0,
    orden INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS destajistas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    telefono TEXT,
    orden INTEGER DEFAULT 0,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_destajistas_project ON destajistas(project_id);

  CREATE TABLE IF NOT EXISTS destajo_items (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    destajista_id INTEGER NOT NULL REFERENCES destajistas(id) ON DELETE CASCADE,
    concepto_id INTEGER REFERENCES conceptos(id) ON DELETE SET NULL,
    codigo TEXT,
    concepto TEXT NOT NULL,
    unidad TEXT,
    cantidad_asignada DOUBLE PRECISION DEFAULT 0,
    precio_destajo DOUBLE PRECISION DEFAULT 0,
    cantidad_ejecutada DOUBLE PRECISION DEFAULT 0,
    orden INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_destajo_items_destajista ON destajo_items(destajista_id);

  CREATE TABLE IF NOT EXISTS avance_destajo (
    id SERIAL PRIMARY KEY,
    semana INTEGER NOT NULL,
    destajo_item_id INTEGER NOT NULL REFERENCES destajo_items(id) ON DELETE CASCADE,
    cantidad_ejecutada DOUBLE PRECISION DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (semana, destajo_item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_avance_destajo_item ON avance_destajo(destajo_item_id);

  CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    usuario TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    puesto TEXT NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS usuario_proyectos (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    asignado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (usuario_id, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_usuario_proyectos_usuario ON usuario_proyectos(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_usuario_proyectos_project ON usuario_proyectos(project_id);

  CREATE TABLE IF NOT EXISTS proveedores (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    contacto TEXT,
    telefono TEXT,
    email TEXT,
    rfc TEXT,
    activo INTEGER DEFAULT 1,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Cumplimiento de proveedores/subcontratistas (prompt-cumplimiento-
  -- subcontratistas.md, diagnóstico previo en prompt-diagnostico-cumplimiento-
  -- subcontratistas.md): documentación legal con vencimiento por documento
  -- (constancia fiscal, opinión SAT, póliza RC, IMSS, licencia de gremio,
  -- identificación). Nunca se sobrescribe una fila al re-subir — siempre
  -- INSERT nuevo, se conserva el historial completo (valor de auditoría). El
  -- "vigente" de un proveedor×tipo se deriva por query (fecha_vencimiento más
  -- reciente), no por una columna de estado — ver server/cumplimiento.js.
  CREATE TABLE IF NOT EXISTS proveedor_documentos (
    id SERIAL PRIMARY KEY,
    proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
    tipo TEXT NOT NULL CHECK (tipo IN (
      'constancia_situacion_fiscal','opinion_cumplimiento_sat',
      'poliza_rc','registro_imss','licencia_gremio','identificacion_representante'
    )),
    fecha_vencimiento DATE,
    blob_url TEXT,
    nombre_archivo TEXT,
    subido_por INTEGER REFERENCES usuarios(id),
    subido_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_proveedor_documentos_proveedor ON proveedor_documentos(proveedor_id);
  CREATE INDEX IF NOT EXISTS idx_proveedor_documentos_vencimiento ON proveedor_documentos(fecha_vencimiento);

  -- Dedup de alertas de cumplimiento — mismo criterio que alertas_contrato_
  -- enviadas (UNIQUE por umbral), pero a nivel documento en vez de a nivel
  -- obra, porque la granularidad real es documento×proveedor, no obra.
  CREATE TABLE IF NOT EXISTS alertas_documentos_enviadas (
    id SERIAL PRIMARY KEY,
    proveedor_documento_id INTEGER NOT NULL REFERENCES proveedor_documentos(id),
    umbral TEXT NOT NULL,
    enviado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(proveedor_documento_id, umbral)
  );

  CREATE TABLE IF NOT EXISTS ordenes_compra (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id),
    proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
    folio TEXT,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    estado TEXT NOT NULL DEFAULT 'borrador',
    observaciones TEXT,
    incluye_iva BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_oc_project ON ordenes_compra(project_id);
  CREATE INDEX IF NOT EXISTS idx_oc_requisicion ON ordenes_compra(requisicion_id);

  CREATE TABLE IF NOT EXISTS orden_compra_items (
    id SERIAL PRIMARY KEY,
    orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
    requisicion_item_id INTEGER NOT NULL REFERENCES requisicion_items(id),
    cantidad_ordenada DOUBLE PRECISION DEFAULT 0,
    precio_unitario DOUBLE PRECISION DEFAULT 0,
    importe DOUBLE PRECISION DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ocitems_oc ON orden_compra_items(orden_compra_id);

  CREATE TABLE IF NOT EXISTS recepciones (
    id SERIAL PRIMARY KEY,
    orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    recibido_por TEXT,
    observaciones TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_recepciones_oc ON recepciones(orden_compra_id);

  CREATE TABLE IF NOT EXISTS recepcion_items (
    id SERIAL PRIMARY KEY,
    recepcion_id INTEGER NOT NULL REFERENCES recepciones(id) ON DELETE CASCADE,
    orden_compra_item_id INTEGER NOT NULL REFERENCES orden_compra_items(id),
    cantidad_recibida DOUBLE PRECISION DEFAULT 0,
    observaciones TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recepitems_recepcion ON recepcion_items(recepcion_id);

  CREATE TABLE IF NOT EXISTS pagos (
    id SERIAL PRIMARY KEY,
    orden_compra_id INTEGER NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    monto DOUBLE PRECISION NOT NULL,
    metodo TEXT,
    referencia TEXT,
    observaciones TEXT,
    incluye_iva BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_pagos_oc ON pagos(orden_compra_id);

  CREATE TABLE IF NOT EXISTS gastos_generales (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    categoria TEXT NOT NULL,
    concepto TEXT NOT NULL,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    monto DOUBLE PRECISION NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    observaciones TEXT,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_gastos_project ON gastos_generales(project_id);

  -- Columnas de IVA agregadas después de que estas tablas ya existían en
  -- producción — CREATE TABLE IF NOT EXISTS no las hubiera sumado a tablas
  -- previamente creadas, así que se agregan explícitamente aquí (idempotente,
  -- no destructivo: filas existentes quedan con el default).
  ALTER TABLE insumos ADD COLUMN IF NOT EXISTS iva_tasa DOUBLE PRECISION NOT NULL DEFAULT 16;
  ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS incluye_iva BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE pagos ADD COLUMN IF NOT EXISTS incluye_iva BOOLEAN NOT NULL DEFAULT true;

  -- Creador de la requisición — permite que residente/cabo solo vean sus
  -- propias requisiciones (compras/logistica/admin siguen viendo todas, las
  -- necesitan completas para generar órdenes de compra). Nullable: las
  -- requisiciones creadas antes de esta columna quedan sin dueño. Para no
  -- romper el historial ya capturado, esas quedan visibles/editables para
  -- CUALQUIER residente/cabo con acceso a la obra (no se le puede atribuir a
  -- nadie con certeza, pero tampoco se le oculta a todos) — ver
  -- requisicionAjena() en server/app.js. Solo las requisiciones creadas desde
  -- ahora en adelante quedan estrictamente acotadas a su creador.
  ALTER TABLE requisiciones ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id);
  CREATE INDEX IF NOT EXISTS idx_requisiciones_usuario ON requisiciones(usuario_id);

  -- Fecha de suministro requerida (prompt-15-fecha-suministro-y-programa.md)
  -- — a nivel de requisición completa, no por renglón: el dato real (folios
  -- ya usados como 'sem-7', 'SEMANA-01') confirma que el equipo ya arma cada
  -- requisición pensando en una sola semana de necesidad, nunca mezclando
  -- fechas distintas dentro de la misma. Nullable y NO retroactivo a
  -- propósito: las requisiciones existentes se quedan sin fecha, siguen
  -- consultables sin bloqueo — el frontend las marca "Sin fecha de
  -- suministro" en vez de ocultarlas (decisión consultada: ese hueco es
  -- justo lo que el Programa de suministros debe ayudar a detectar).
  ALTER TABLE requisiciones ADD COLUMN IF NOT EXISTS fecha_suministro DATE;
  CREATE INDEX IF NOT EXISTS idx_requisiciones_fecha_suministro ON requisiciones(fecha_suministro);

  -- Cliente (agrupador de proyectos) — agregado después de que 'proyectos' ya
  -- existía en producción. cliente_id es nullable para no romper proyectos
  -- existentes sin cliente asignado (los 2 originales se migraron a "VINTE"
  -- en un script one-off, ver historial de git).
  CREATE TABLE IF NOT EXISTS clientes (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES clientes(id);

  -- Orden personalizado de tarjetas de cliente en "Selecciona un cliente",
  -- por usuario (no afecta lo que ven otros usuarios). Se reescribe entera
  -- en cada guardado (DELETE + INSERT dentro de una transacción) en vez de
  -- hacer upserts fila por fila — más simple dado que el orden siempre se
  -- guarda completo desde el frontend tras un drag and drop.
  CREATE TABLE IF NOT EXISTS orden_clientes_usuario (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    posicion INTEGER NOT NULL,
    UNIQUE (usuario_id, cliente_id)
  );

  -- Notificaciones in-app — infraestructura base para las alertas de fases
  -- futuras (impuestos, vencimiento de contrato, requisición/OC publicada).
  -- 'tipo' es texto libre (no ENUM) para que esas fases agreguen tipos nuevos
  -- sin migrar el esquema. 'referencia_id' apunta al id del recurso asociado
  -- (requisicion_id, orden_compra_id, etc.) según 'tipo' — sin FK porque puede
  -- referenciar distintas tablas según el tipo.
  CREATE TABLE IF NOT EXISTS notificaciones (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    referencia_id INTEGER,
    mensaje TEXT NOT NULL,
    leida BOOLEAN NOT NULL DEFAULT false,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_leida ON notificaciones(usuario_id, leida);

  -- Preferencias de notificaciones por usuario/tipo (prompt-fase2-notificaciones-
  -- sesiones.md) — sin fila para un (usuario_id, tipo) significa "activado" (ver
  -- tipoHabilitado() en server/notificaciones.js), así que esta tabla solo
  -- guarda las excepciones que el usuario desactivó explícitamente. Los 9
  -- tipos son los mismos que ya usan crearNotificacion()/notificarAdmins() en
  -- server/app.js — mantener en sync si se agrega un tipo nuevo.
  CREATE TABLE IF NOT EXISTS notificacion_preferencias (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN (
      'recordatorio_impuestos','contrato_por_vencer','maquinaria_horas_pendiente',
      'requisicion_pendiente','oc_pendiente','avance_pendiente','destajo_pendiente',
      'estimacion_pendiente','estimacion_rechazada'
    )),
    activo BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (usuario_id, tipo)
  );
  CREATE INDEX IF NOT EXISTS idx_notificacion_preferencias_usuario ON notificacion_preferencias(usuario_id);

  -- Pagos de impuestos (IMSS/SAT/INFONAVIT) por obra y periodo — aplica a
  -- TODAS las obras por igual, sin relación con la pestaña Contrato. Un
  -- periodo por (project_id, año, mes); el cron mensual (ver
  -- POST /api/cron/recordatorio-impuestos) los crea en 'pendiente' y el
  -- residente/admin los actualiza a 'cargado' desde la pestaña Impuestos.
  -- Las referencias son texto libre (folio escrito a mano) — no hay subida
  -- de archivo binario en este alcance.
  CREATE TABLE IF NOT EXISTS pagos_impuestos_obra (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    periodo_anio INTEGER NOT NULL,
    periodo_mes INTEGER NOT NULL,
    imss_monto DOUBLE PRECISION,
    imss_referencia TEXT,
    sat_monto DOUBLE PRECISION,
    sat_referencia TEXT,
    infonavit_monto DOUBLE PRECISION,
    infonavit_referencia TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    cargado_por INTEGER REFERENCES usuarios(id),
    cargado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, periodo_anio, periodo_mes)
  );

  -- Deduplicación de alertas de vencimiento de contrato (ver
  -- POST /api/cron/alertas-vencimiento y server/alertasContrato.js). Una
  -- fila por (project_id, umbral) — 'vencido' se inserta una sola vez para
  -- no repetir la alerta cada día después de la fecha de término.
  CREATE TABLE IF NOT EXISTS alertas_contrato_enviadas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    umbral TEXT NOT NULL,
    enviada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, umbral)
  );

  -- Autorización de avance semanal (físico/financiero) — capa agregada
  -- encima del flujo existente, no lo reemplaza. Default 'autorizado' para
  -- que las semanas ya existentes (capturadas antes de esta fase) no
  -- queden bloqueadas retroactivamente; a partir de ahora, cuando alguien
  -- no-admin captura avance real, el endpoint la pasa a
  -- 'pendiente_autorizacion' y notifica a los admins (ver
  -- PUT /api/projects/:id/avances/:semana[/conceptos] en server/app.js).
  ALTER TABLE avances_semanales ADD COLUMN IF NOT EXISTS estado_autorizacion TEXT NOT NULL DEFAULT 'autorizado';

  -- Autorización de avance de destajo por destajista+semana. No existe una
  -- fila por defecto: se crea la primera vez que alguien captura avance de
  -- destajo para ese destajista en esa semana (ver PUT
  -- /api/projects/:id/destajistas/:destId/avance/:semana).
  CREATE TABLE IF NOT EXISTS destajo_avance_autorizacion (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    destajista_id INTEGER NOT NULL REFERENCES destajistas(id) ON DELETE CASCADE,
    semana INTEGER NOT NULL,
    estado_autorizacion TEXT NOT NULL DEFAULT 'pendiente_autorizacion',
    autorizado_por INTEGER REFERENCES usuarios(id),
    autorizado_en TIMESTAMPTZ,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, destajista_id, semana)
  );

  -- Seguridad: columnas para gestión de contraseñas y revocación de sesión.
  -- DEFAULT '2020-01-01' en token_valid_since para no invalidar sesiones
  -- existentes al desplegar esta migración.
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_valid_since TIMESTAMPTZ NOT NULL DEFAULT '2020-01-01 00:00:00+00';

  -- 2FA TOTP: secret cifrado (AES-256-GCM con TOTP_ENC_KEY, no en texto plano),
  -- totp_enabled=false fuerza el flujo de inscripción en el próximo login,
  -- backup codes como JSONB [{hash, used}] (bcrypt individual, un solo uso c/u).
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_secret TEXT;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_backup_codes JSONB;

  -- 2FA opcional (julio 2026): totp_enabled=false ya NO fuerza inscripción.
  -- totp_reminder_last_shown_at trackea cuándo se le mostró el banner de
  -- recordatorio por última vez, para no repetirlo antes de 3 días.
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_reminder_last_shown_at TIMESTAMP;

  -- Autoservicio de privacidad: el usuario marca que solicitó la eliminación
  -- de sus datos personales (Ajustes > Mi cuenta). NUNCA dispara un borrado
  -- físico — solo marca la solicitud para revisión manual de un admin.
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS solicitud_eliminacion_datos BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_solicitud_eliminacion TIMESTAMPTZ;

  -- Intentos de login para rate limiting por usuario (serverless-safe:
  -- persiste entre instancias). Índice compuesto para la consulta de ventana
  -- temporal (identificador + creado_en).
  CREATE TABLE IF NOT EXISTS login_attempts (
    id SERIAL PRIMARY KEY,
    identificador TEXT NOT NULL,
    ip TEXT,
    exitoso BOOLEAN NOT NULL DEFAULT false,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_ident ON login_attempts(identificador, creado_en);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, creado_en);

  -- Auditoría de acciones administrativas sensibles (creación de usuario,
  -- reset de contraseña). No reemplaza login_attempts; registra quién hizo
  -- qué sobre qué usuario y desde qué IP. actor_id puede ser NULL si el
  -- actor ya no existe al consultar historial.
  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    actor_id INTEGER,
    actor_usuario TEXT NOT NULL,
    accion TEXT NOT NULL,
    target_id INTEGER,
    target_usuario TEXT,
    ip TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_creado ON audit_log(creado_en DESC);

  -- project_id agregado para poder filtrar el historial de acciones sobre
  -- requisiciones por obra (residente/cabo — control de qué hacen en cada
  -- obra). ON DELETE SET NULL: si algún día se borra un proyecto, el
  -- historial de auditoría no desaparece con él.
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES proyectos(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id, creado_en DESC);

  -- detalle: JSON en texto con contexto extra para acciones donde vale la
  -- pena guardar más que actor/target (ej. actualización de presupuesto:
  -- conteos de nuevos/emparejados/históricos y qué conceptos cambiaron de
  -- precio o cantidad). NULL para todas las acciones que no lo necesitan.
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detalle TEXT;

  -- Última visita por usuario+cliente para navegación inteligente: cuando el
  -- usuario selecciona un cliente, la app navega automáticamente al último
  -- proyecto visitado. UNIQUE(usuario_id, cliente_id) permite upsert eficiente.
  CREATE TABLE IF NOT EXISTS ultima_visita (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    proyecto_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(usuario_id, cliente_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ultima_visita_usuario_cliente ON ultima_visita(usuario_id, cliente_id);

  -- Favoritos de la galería de clientes (Prompt B, prompts-animaciones-y-
  -- galeria-clientes.md) — por usuario (no por dispositivo/localStorage) para
  -- que viaje entre sesiones/equipos del mismo usuario, mismo patrón que
  -- ultima_visita de arriba. UNIQUE(usuario_id, cliente_id) evita duplicados;
  -- marcar/desmarcar es INSERT/DELETE simple, no hace falta upsert.
  CREATE TABLE IF NOT EXISTS usuario_favoritos (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    orden INTEGER NOT NULL DEFAULT 0,
    UNIQUE(usuario_id, cliente_id)
  );
  CREATE INDEX IF NOT EXISTS idx_usuario_favoritos_usuario ON usuario_favoritos(usuario_id);
  -- orden (prompt-dashboard-favoritos-layout.md, reorder por drag de la
  -- franja de Favoritos) — ALTER además del CREATE de arriba porque esta
  -- tabla es tan nueva que puede ya existir sin la columna en algún
  -- entorno donde ya corrió la migración anterior (mismo patrón ya usado
  -- para estimaciones.nombre).
  ALTER TABLE usuario_favoritos ADD COLUMN IF NOT EXISTS orden INTEGER NOT NULL DEFAULT 0;

  -- Catálogo formal de trabajadores por obra (expediente personal). Coexiste
  -- con 'destajistas' (rol en obra); el vínculo es opcional vía destajista_id.
  CREATE TABLE IF NOT EXISTS trabajadores (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    destajista_id INTEGER REFERENCES destajistas(id) ON DELETE SET NULL,
    nombre TEXT NOT NULL,
    puesto TEXT,
    tipo_pago TEXT NOT NULL DEFAULT 'jornal',
    tarifa_jornal DOUBLE PRECISION DEFAULT 0,
    periodicidad TEXT NOT NULL DEFAULT 'semanal',
    curp TEXT,
    rfc TEXT,
    nss TEXT,
    telefono TEXT,
    direccion TEXT,
    contacto_emergencia TEXT,
    fecha_ingreso DATE,
    activo BOOLEAN NOT NULL DEFAULT true,
    fecha_baja DATE,
    motivo_baja TEXT,
    orden INTEGER DEFAULT 0,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_trabajadores_project ON trabajadores(project_id);

  -- Documentos de identidad (Vercel Blob privado — nunca URL pública directa)
  CREATE TABLE IF NOT EXISTS trabajador_documentos (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    nombre_archivo TEXT NOT NULL,
    blob_url TEXT NOT NULL,
    subido_por INTEGER REFERENCES usuarios(id),
    subido_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_trabajador_docs ON trabajador_documentos(trabajador_id);

  -- Asistencia diaria (checklist por trabajador × fecha)
  CREATE TABLE IF NOT EXISTS asistencia_diaria (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    presente BOOLEAN NOT NULL DEFAULT false,
    capturado_por INTEGER REFERENCES usuarios(id),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, trabajador_id, fecha)
  );
  CREATE INDEX IF NOT EXISTS idx_asistencia_fecha ON asistencia_diaria(project_id, fecha);

  -- Migración: columna estado 3-valores en lugar del booleano presente original.
  -- 'presente' es el DEFAULT para no afectar filas existentes.
  -- PAID_IF_PRESENT: solo 'presente' genera pago (falta_justificada y falta_injustificada no pagan).
  -- Si se quiere que falta_justificada pague, cambiar la constante en el cálculo de nómina.
  ALTER TABLE asistencia_diaria ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'presente';

  -- Nóminas — cabecera de periodo de pago con flujo de autorización
  CREATE TABLE IF NOT EXISTS nominas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE NOT NULL,
    estado TEXT NOT NULL DEFAULT 'borrador',
    nota_rechazo TEXT,
    aprobada_por INTEGER REFERENCES usuarios(id),
    aprobada_en TIMESTAMPTZ,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_nominas_project ON nominas(project_id);

  -- Items de nómina — uno por trabajador por periodo
  CREATE TABLE IF NOT EXISTS nomina_items (
    id SERIAL PRIMARY KEY,
    nomina_id INTEGER NOT NULL REFERENCES nominas(id) ON DELETE CASCADE,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id),
    dias_trabajados INTEGER DEFAULT 0,
    monto_jornal DOUBLE PRECISION DEFAULT 0,
    monto_destajo DOUBLE PRECISION DEFAULT 0,
    monto_total DOUBLE PRECISION DEFAULT 0,
    UNIQUE(nomina_id, trabajador_id)
  );
  CREATE INDEX IF NOT EXISTS idx_nomina_items_nomina ON nomina_items(nomina_id);

  -- Rate limiting de endpoints costosos (ej. extracción PDF via Claude API).
  -- Serverless-safe: persiste entre instancias igual que login_attempts.
  -- Índice compuesto para la consulta de ventana temporal (usuario + endpoint + creado_en).
  CREATE TABLE IF NOT EXISTS api_rate_limits (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_api_rate_limits_usuario ON api_rate_limits(usuario_id, endpoint, creado_en);
  -- Columna ip: permite además un límite por IP (ej. PUT /api/auth/mi-cuenta),
  -- igual que login_attempts, sin duplicar la tabla.
  ALTER TABLE api_rate_limits ADD COLUMN IF NOT EXISTS ip TEXT;
  CREATE INDEX IF NOT EXISTS idx_api_rate_limits_ip ON api_rate_limits(ip, endpoint, creado_en);

  -- PDF original del contrato — almacenado en Vercel Blob (privado). Relación
  -- 1:1 con proyectos (UNIQUE project_id). El blob_url lo genera contrato-preview
  -- y lo persiste contrato-confirm; el endpoint GET /api/projects/:id/contrato/pdf
  -- hace proxy del blob sin exponer la URL directa al cliente.
  CREATE TABLE IF NOT EXISTS contratos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    blob_url TEXT NOT NULL,
    nombre_archivo TEXT NOT NULL DEFAULT 'contrato.pdf',
    subido_por INTEGER REFERENCES usuarios(id),
    subido_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_contratos_project ON contratos(project_id);

  -- Órdenes de Cambio (prompt-ordenes-cambio.md, diagnóstico previo en
  -- prompt-diagnostico-ordenes-cambio.md) — solicitud formal de cambio de
  -- alcance con folio/justificación/aprobación, que al aprobarse aplica el
  -- delta real al presupuesto reusando el motor ya existente de
  -- server/reintegracionPresupuesto.js (aplicarCambiosConceptos), nunca un
  -- segundo motor paralelo. folio es TEXT (no INTEGER) para mantener el
  -- mismo patrón ya usado por folio_counters (consecutivo por project_id +
  -- tipo='orden_cambio', sin columna de tipo nueva — folio_counters.tipo ya
  -- es TEXT libre). monto_delta se calcula SIEMPRE server-side a partir de
  -- orden_cambio_conceptos (nunca se confía en un monto capturado por el
  -- cliente para un dato financiero — mismo criterio que fondo_garantia_
  -- monto/estimaciones en otras partes de la app).
  CREATE TABLE IF NOT EXISTS ordenes_cambio (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    folio TEXT NOT NULL,
    fecha_solicitud TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    descripcion TEXT NOT NULL,
    solicitado_por INTEGER REFERENCES usuarios(id),
    monto_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','rechazada')),
    aprobado_por INTEGER REFERENCES usuarios(id),
    aprobado_en TIMESTAMPTZ,
    comentario_rechazo TEXT,
    documento_respaldo_url TEXT,
    documento_respaldo_nombre TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, folio)
  );
  CREATE INDEX IF NOT EXISTS idx_ordenes_cambio_project ON ordenes_cambio(project_id);

  -- Detalle línea por línea de cada orden de cambio: o bien un ajuste a un
  -- concepto YA existente (concepto_id + es_concepto_nuevo=false, cantidad/
  -- precio_unitario son los valores NUEVOS deseados) o un concepto
  -- completamente nuevo (concepto_id NULL + es_concepto_nuevo=true).
  -- 'unidad' NO estaba en el schema original del prompt — se agrega aquí
  -- porque un concepto nuevo sin unidad queda invisible para Avance/
  -- Estimaciones (ambos filtran TRIM(COALESCE(unidad,'')) <> ''), lo que
  -- rompería en silencio el caso "concepto nuevo" de esta misma feature;
  -- toda otra tabla con forma de concepto en la app (conceptos, parser de
  -- Excel) siempre trae unidad. Único campo añadido sobre el schema dado.
  CREATE TABLE IF NOT EXISTS orden_cambio_conceptos (
    id SERIAL PRIMARY KEY,
    orden_cambio_id INTEGER NOT NULL REFERENCES ordenes_cambio(id) ON DELETE CASCADE,
    concepto_id INTEGER REFERENCES conceptos(id),
    es_concepto_nuevo BOOLEAN NOT NULL DEFAULT false,
    codigo TEXT,
    descripcion TEXT,
    unidad TEXT,
    cantidad DOUBLE PRECISION,
    precio_unitario DOUBLE PRECISION
  );
  CREATE INDEX IF NOT EXISTS idx_orden_cambio_conceptos_oc ON orden_cambio_conceptos(orden_cambio_id);

  -- Lotes/Unidades (prompt-lotes-fase1.md, diagnóstico previo en
  -- prompt-diagnostico-lotes-fase1.md) — Fase 1 (cimiento) del roadmap
  -- "Desarrollador de Vivienda": trackea el estatus de construcción de cada
  -- lote/casa individual de un fraccionamiento. Independiente de
  -- avances_semanales/avance_financiero_real a propósito (Forbidden Action
  -- explícita del prompt) — estatus 100% manual en esta fase, sin prorrateo
  -- desde el avance físico/financiero de la obra completa.
  -- 'manzana' NOT NULL DEFAULT '' (no nullable, a diferencia del borrador del
  -- diagnóstico) — un desarrollo sin manzanas usa '' consistentemente; con
  -- NULL, el UNIQUE de abajo no detecta duplicados entre sí (Postgres trata
  -- cada NULL como distinto en una constraint UNIQUE), lo que habría dejado
  -- reimportar el mismo lote sin manzana una y otra vez como fila nueva.
  -- 'numero_lote' es TEXT, no INTEGER: identificadores reales como "12-A" o
  -- "12 BIS" son comunes y los define el desarrollador externo, no Roforb —
  -- Forbidden Action explícita: NUNCA usar folio_counters aquí.
  -- 'modelo_vivienda' es texto libre a propósito (Forbidden Action explícita
  -- — catálogo formal de modelos es una fase futura, no esta).
  -- 'estatus' con CHECK: vocabulario chico y estable (4 valores), mismo
  -- criterio que ordenes_cambio.estado/equipos_maquinaria.estado arriba.
  CREATE TABLE IF NOT EXISTS lotes (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    manzana TEXT NOT NULL DEFAULT '',
    numero_lote TEXT NOT NULL,
    modelo_vivienda TEXT,
    superficie_m2 DOUBLE PRECISION,
    estatus TEXT NOT NULL DEFAULT 'sin_iniciar'
      CHECK (estatus IN ('sin_iniciar','en_proceso','terminado','entregado')),
    fecha_entrega_estimada DATE,
    fecha_entrega_real DATE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, manzana, numero_lote)
  );
  CREATE INDEX IF NOT EXISTS idx_lotes_project ON lotes(project_id);

  -- Portal de sugerencias — cualquier usuario autenticado puede enviar; solo
  -- admin puede revisar y gestionar. prompt_generado almacena el prompt
  -- técnico formateado por IA (claude-sonnet-4-6) bajo demanda desde el
  -- panel de admin. El rate limiting usa api_rate_limits (endpoint='sugerencias').
  CREATE TABLE IF NOT EXISTS sugerencias (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    prompt_generado TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_sugerencias_estado ON sugerencias(estado, creado_en DESC);
  CREATE INDEX IF NOT EXISTS idx_sugerencias_usuario ON sugerencias(usuario_id);

  -- Imágenes adjuntas a sugerencias (capturas de pantalla). Almacenadas en
  -- Vercel Blob con acceso público (no son datos sensibles). Máx. 5 por sugerencia.
  CREATE TABLE IF NOT EXISTS sugerencia_imagenes (
    id SERIAL PRIMARY KEY,
    sugerencia_id INTEGER NOT NULL REFERENCES sugerencias(id) ON DELETE CASCADE,
    blob_url TEXT NOT NULL,
    nombre_archivo TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_sug_imgs ON sugerencia_imagenes(sugerencia_id);

  -- Novedades (changelog in-app, prompt-16-novedades-changelog.md). Mismo
  -- criterio de acceso que Sugerencias: informativo, sin sección de permiso
  -- propia, sin auth.allow() para lectura — cualquier usuario autenticado
  -- puede verlas. 'publicada' separa crear de publicar a propósito (Target
  -- State #4): un borrador nunca aparece en el listado ni dispara aviso.
  CREATE TABLE IF NOT EXISTS novedades (
    id SERIAL PRIMARY KEY,
    version TEXT,
    fecha_publicacion DATE NOT NULL DEFAULT CURRENT_DATE,
    titulo TEXT NOT NULL,
    resumen TEXT,
    publicada BOOLEAN NOT NULL DEFAULT false,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_novedades_publicada ON novedades(publicada, fecha_publicacion DESC);

  CREATE TABLE IF NOT EXISTS novedades_items (
    id SERIAL PRIMARY KEY,
    novedad_id INTEGER NOT NULL REFERENCES novedades(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('nueva', 'mejora', 'correccion')),
    texto TEXT NOT NULL,
    orden INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_novedades_items_novedad ON novedades_items(novedad_id);

  -- Tabla puente, NO columna-cursor en usuarios (diagnóstico confirmado con
  -- Paul): un cursor tipo "vista_hasta_id" se rompe si se publica una
  -- novedad vieja (id bajo) DESPUÉS de que el usuario ya vio una más nueva
  -- (id alto) — el borrador pudo quedarse días sin publicar mientras otras
  -- novedades más nuevas sí se publicaban y veían. La tabla puente responde
  -- "¿este usuario vio ESTA novedad" sin ambigüedad de orden, mismo patrón
  -- N:N ya usado en el proyecto (concepto_insumos).
  CREATE TABLE IF NOT EXISTS novedades_vistas (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    novedad_id INTEGER NOT NULL REFERENCES novedades(id) ON DELETE CASCADE,
    visto_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (usuario_id, novedad_id)
  );
  CREATE INDEX IF NOT EXISTS idx_novedades_vistas_usuario ON novedades_vistas(usuario_id);

  -- Alta: campos adicionales en trabajadores (contacto de emergencia dividido).
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS contacto_emergencia_nombre TEXT;
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS contacto_emergencia_telefono TEXT;

  -- Datos bancarios (prompt-p5-cuentas-bancarias.md) — solo admin/desarrollador/
  -- administración (sección 'trabajadores_bancarios', ver server/auth.js).
  -- NUNCA viajan en el SELECT de ningún listado (server/app.js reescribe esas
  -- queries con columnas explícitas, sin estas dos) — el recorte es a nivel
  -- de query, no de payload condicional.
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS cuenta_nomina_hsbc TEXT;
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS cuenta_alterna TEXT;

  -- Banco detectado/capturado para cada cuenta (prompt-2-deteccion-banco-
  -- clabe.md) — "cuenta_nomina_hsbc" ya no asume HSBC fijo: si el usuario
  -- captura una CLABE de 18 dígitos válida, el banco se autodetecta contra
  -- server/catalogoBancos.js y se guarda aquí; el nombre de columna de la
  -- cuenta se conserva tal cual (sin RENAME, sin precedente en este
  -- proyecto) para no romper referencias existentes — solo cambia su
  -- semántica de "siempre HSBC" a "banco real, detectado o capturado a
  -- mano". Mismo gating de permisos que las cuentas (trabajadores_bancarios).
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS banco_nomina TEXT;
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS banco_alterna TEXT;

  -- prompt-35-numero-cuenta-export-nomina.md: número de TARJETA, campo
  -- separado de cuenta_nomina_hsbc/cuenta_alterna (CLABE) — un trabajador
  -- puede recibir dispersión a tarjeta en vez de CLABE, y ambos formatos
  -- pueden coexistir (capturar los dos por si acaso). Sin validación de
  -- checksum (una tarjeta no tiene el mismo dígito verificador que una
  -- CLABE) y sin bloquear por longitud — se guarda tal cual, igual que
  -- cuenta_nomina_hsbc/cuenta_alterna cuando su longitud no es 18 (ver
  -- resolverCuentaBanco en server/app.js). Mismo gate de permisos
  -- (trabajadores_bancarios) y mismo recorte a nivel de SELECT que el
  -- resto de la sección bancaria — nunca viaja en el SELECT de ningún
  -- listado.
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS tarjeta_nomina TEXT;
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS tarjeta_alterna TEXT;

  -- prompt-21-trabajadores-multiobra-diagnostico.md, Fase 0 — previene el bug
  -- real encontrado (Javier Pineda / Santiago Lagunas en RED HIDRAULICA: dar
  -- de baja y recrear en vez de editar, dentro de la MISMA obra). Por-obra
  -- (project_id, curp), NO global: un UNIQUE(curp) global bloquearía el caso
  -- legítimo de un trabajador que termina en una obra y años después arranca
  -- en otra con el mismo CURP — sigue siendo una fila independiente porque no
  -- existe tabla puente (diagnóstico confirmó 0 evidencia real de necesitar
  -- una). Parcial (ignora NULL/'') porque CURP no es obligatorio hoy — de
  -- hecho ninguno de los 2 duplicados reales tenía CURP capturado, así que
  -- esto previene la recurrencia solo cuando SÍ se captura, no es un fix
  -- retroactivo de esos casos. Verificado antes de crear: 0 grupos
  -- (project_id, curp) repetidos en Preview y en Producción.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_trabajadores_curp_unico_por_obra
    ON trabajadores (project_id, curp)
    WHERE curp IS NOT NULL AND TRIM(curp) <> '';

  -- Historial formal de bajas por trabajador (soft-delete auditado).
  -- motivo_baja restringido por CHECK; cuando es 'otro', se espera notas != null (enforced en app).
  CREATE TABLE IF NOT EXISTS trabajador_bajas (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    fecha_baja DATE NOT NULL DEFAULT CURRENT_DATE,
    motivo_baja TEXT NOT NULL CHECK (motivo_baja IN ('renuncia','despido_justificado','despido_injustificado','fin_obra','abandono','otro')),
    notas TEXT,
    registrado_por INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_trabajador_bajas_trabajador ON trabajador_bajas(trabajador_id);

  -- Contratos laborales por trabajador (múltiples en el tiempo — historial).
  -- activo=true indica el contrato vigente; al crear uno nuevo se desactiva el anterior.
  -- salario_diario es el salario contractual/legal; NO reemplaza tarifa_jornal de nómina.
  CREATE TABLE IF NOT EXISTS contratos_trabajador (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    tipo_contrato TEXT NOT NULL CHECK (tipo_contrato IN ('obra_determinada','tiempo_determinado','tiempo_indeterminado')),
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE,
    salario_diario NUMERIC(12,2),
    pdf_url TEXT,
    pdf_filename TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_by INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_contratos_trabajador ON contratos_trabajador(trabajador_id);

  -- Catálogo de EPP configurable por obra.
  CREATE TABLE IF NOT EXISTS epp_catalogo (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    nombre_item TEXT NOT NULL,
    descripcion TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_epp_catalogo_project ON epp_catalogo(project_id);

  -- Registros de entrega de EPP con firma digital (base64 PNG).
  CREATE TABLE IF NOT EXISTS epp_entregas (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES epp_catalogo(id) ON DELETE RESTRICT,
    cantidad INTEGER NOT NULL DEFAULT 1,
    fecha_entrega DATE NOT NULL DEFAULT CURRENT_DATE,
    firma_digital TEXT,
    entregado_por INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_epp_entregas_trabajador ON epp_entregas(trabajador_id);
  CREATE INDEX IF NOT EXISTS idx_epp_entregas_item ON epp_entregas(item_id);

  -- Permisos granulares por usuario/obra/sección — conviven con auth.allow()
  -- (rol) sin reemplazarlo. proyecto_id nullable = aplica a todas las obras
  -- asignadas al usuario. Alcance inicial de enforcement real: Nómina y
  -- Destajo (ver server/app.js); el resto de secciones sigue gobernado por
  -- auth.allow() por ahora — esta tabla ya persiste su matriz completa para
  -- cuando se amplíe.
  CREATE TABLE IF NOT EXISTS permisos_usuario (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    proyecto_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
    -- Mantener en sync con SECCIONES_PERMISOS en server/auth.js. En Preview
    -- este CHECK ya se amplió vía ALTER TABLE directo (no vuelve a correr
    -- sobre una tabla existente); esta definición solo aplica a bases nuevas.
    seccion TEXT NOT NULL CHECK (seccion IN (
      'presupuestos','requisiciones','proveedores','ordenes_compra','avance',
      'destajo','finanzas','insumos','mapeo','usuarios','contrato','impuestos',
      'nominas','sugerencias','programa','estimaciones','maquinaria',
      'trabajadores_global','nominas_global','trabajadores','estado_resultados','maquinaria_captura','maquinaria_combustible',
      'costos','trabajadores_docs','trabajadores_contrato','trabajadores_bancarios',
      'cotizador','estado_resultados_global','estado_unidad','maquinaria_consumibles',
      'ordenes_cambio','lotes'
    )),
    puede_ver BOOLEAN NOT NULL DEFAULT false,
    puede_crear BOOLEAN NOT NULL DEFAULT false,
    puede_editar BOOLEAN NOT NULL DEFAULT false,
    puede_editar_precios BOOLEAN NOT NULL DEFAULT false,
    puede_eliminar BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (usuario_id, proyecto_id, seccion)
  );
  CREATE INDEX IF NOT EXISTS idx_permisos_usuario_usuario ON permisos_usuario(usuario_id);
  -- Amplía el CHECK de 'seccion' en bases ya existentes (Preview/producción)
  -- — el CREATE TABLE de arriba no vuelve a correr sobre una tabla
  -- existente, así que el CHECK original se queda corto sin este ALTER
  -- explícito. 'trabajadores' agregado en prompts-cotizador-sidebar-
  -- permisos-estimaciones.md Prompt 3 (permiso por-obra, distinto de
  -- trabajadores_global) — confirmado con prueba real que sin este ALTER
  -- INSERT INTO permisos_usuario con seccion='trabajadores' viola el CHECK.
  -- 'trabajadores_docs'/'trabajadores_contrato' agregados en prompt-implementar-
  -- permisos-docs-contrato-epp.md — mismo bug ya documentado con 'costos':
  -- agregar la sección SOLO al CREATE TABLE de arriba no alcanza en Preview/
  -- producción (tabla ya existente, el CREATE no vuelve a correr) — tiene que
  -- ir también aquí.
  -- 'cotizador'/'estado_resultados_global' agregados en prompt-p8-migracion-
  -- permisos-navegacion.md (diagnóstico): completan el catálogo para los tabs
  -- 'cotizador' (compras) y 'estadoResultadosGlobal' (tesorería), que hasta
  -- ahora no tenían sección propia — sin esto INSERT con esas secciones
  -- viola el CHECK, mismo bug ya documentado arriba con cada sección nueva.
  -- 'estado_unidad' agregado en prompt-6-estado-unidad-operador.md — mismo
  -- patrón, sección propia para el checklist de operador.
  -- 'maquinaria_consumibles' agregado en prompt-10-programa-consumibles.md —
  -- sección propia y separada de 'maquinaria_combustible' a propósito: esta
  -- última sigue siendo solo jefe_maquinaria (combustible oficial +
  -- bitácora de mantenimiento); darle a operador puede_crear ahí también le
  -- habría abierto la puerta a mantenimientos_maquinaria (Forbidden Action
  -- explícita de este prompt: no ampliar quién escribe esa tabla).
  -- 'ordenes_cambio' agregado en prompt-ordenes-cambio.md — sección propia
  -- con enforcement real (checkPermiso en server/app.js), mismo criterio que
  -- 'estimaciones'/'nominas'.
  -- 'lotes' agregado en prompt-lotes-fase1.md — sección propia con
  -- enforcement real (checkPermiso en server/app.js), mismo criterio que
  -- 'ordenes_cambio' arriba.
  ALTER TABLE permisos_usuario DROP CONSTRAINT IF EXISTS permisos_usuario_seccion_check;
  ALTER TABLE permisos_usuario ADD CONSTRAINT permisos_usuario_seccion_check CHECK (seccion IN (
    'presupuestos','requisiciones','proveedores','ordenes_compra','avance',
    'destajo','finanzas','insumos','mapeo','usuarios','contrato','impuestos',
    'nominas','sugerencias','programa','estimaciones','maquinaria',
    'trabajadores_global','nominas_global','trabajadores','estado_resultados','maquinaria_captura','maquinaria_combustible',
    'costos','trabajadores_docs','trabajadores_contrato','trabajadores_bancarios',
    'cotizador','estado_resultados_global','estado_unidad','maquinaria_consumibles',
    'ordenes_cambio','lotes'
  ));

  -- Contador de folios por obra + tipo de documento. INSERT...ON CONFLICT DO
  -- UPDATE...RETURNING es atómico a nivel de fila en Postgres (no necesita
  -- SELECT FOR UPDATE aparte) — evita folios duplicados si dos residentes
  -- crean una estimación de la misma obra al mismo tiempo. 'tipo' deja abierto
  -- reusar esta tabla para otros documentos foliados en el futuro.
  CREATE TABLE IF NOT EXISTS folio_counters (
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    ultimo_folio INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, tipo)
  );

  -- Estimaciones de obra: corte de avance periódico que jala montos de
  -- avance_conceptos (NO captura manual). total_acumulado/cantidad_acumulada
  -- (aquí y en estimacion_conceptos) reflejan solo estimaciones previas ya
  -- APROBADAS + el periodo actual — no el avance físico crudo — para que el
  -- PDF firmado siempre reconcilie con los documentos previos ya entregados
  -- al cliente (decisión explícita, ver prompt_modulo_estimaciones_obra.md).
  -- Soft-delete vía 'activo': nunca DELETE físico de una estimación.
  CREATE TABLE IF NOT EXISTS estimaciones (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    folio INTEGER NOT NULL,
    periodo_inicio DATE NOT NULL,
    periodo_fin DATE NOT NULL,
    estado TEXT NOT NULL DEFAULT 'borrador',
    residente_id INTEGER REFERENCES usuarios(id),
    admin_aprobador_id INTEGER REFERENCES usuarios(id),
    fecha_captura TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_aprobacion TIMESTAMPTZ,
    total_periodo DOUBLE PRECISION DEFAULT 0,
    total_acumulado DOUBLE PRECISION DEFAULT 0,
    pdf_url TEXT,
    comentario_rechazo TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (project_id, folio)
  );
  CREATE INDEX IF NOT EXISTS idx_estimaciones_project ON estimaciones(project_id);
  -- Prompt 4 (prompts-cotizador-sidebar-permisos-estimaciones.md): nombre
  -- editable opcional (si es NULL, la UI sigue mostrando "Estimación #folio"
  -- como hasta ahora) + desglose de pago persistido (no se recalcula solo,
  -- para que una estimación ya aprobada/con PDF mantenga el monto exacto que
  -- se cobró aunque la fórmula cambie después). amortizacion_anticipo es
  -- captura manual (opcional, $0 si no aplica); fondo_garantia_monto/
  -- iva_monto/total_a_pagar se recalculan junto con total_periodo cada vez
  -- que se usa "Calcular" (ver POST .../calcular), y total_a_pagar también
  -- se recalcula al guardar una nueva amortizacion_anticipo.
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS nombre TEXT;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS amortizacion_anticipo DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS fondo_garantia_monto DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS iva_monto DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE estimaciones ADD COLUMN IF NOT EXISTS total_a_pagar DOUBLE PRECISION NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS estimacion_conceptos (
    id SERIAL PRIMARY KEY,
    estimacion_id INTEGER NOT NULL REFERENCES estimaciones(id) ON DELETE CASCADE,
    concepto_id INTEGER NOT NULL REFERENCES conceptos(id),
    cantidad_periodo DOUBLE PRECISION DEFAULT 0,
    importe_periodo DOUBLE PRECISION DEFAULT 0,
    cantidad_acumulada DOUBLE PRECISION DEFAULT 0,
    importe_acumulado DOUBLE PRECISION DEFAULT 0,
    porcentaje_avance DOUBLE PRECISION DEFAULT 0,
    UNIQUE (estimacion_id, concepto_id)
  );
  CREATE INDEX IF NOT EXISTS idx_estimacion_conceptos_estimacion ON estimacion_conceptos(estimacion_id);

  -- Módulo de Maquinaria (prompt-modulo-maquinaria) — DISEÑO DE PRIMER BORRADOR,
  -- pendiente de revisión: la asignación cabo=captura de horas /
  -- taller=combustible+mantenimiento es una propuesta inicial, no definitiva.
  -- 'tipo' en equipos_maquinaria empieza solo con 'retroexcavadora' pero es
  -- texto libre para poder agregar tipos de equipo después sin migración.
  CREATE TABLE IF NOT EXISTS equipos_maquinaria (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'retroexcavadora',
    identificador TEXT,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'mantenimiento', 'baja', 'en_taller')),
    obra_id INTEGER REFERENCES proyectos(id) ON DELETE SET NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_equipos_maquinaria_obra ON equipos_maquinaria(obra_id);

  -- Asignación de equipo a cliente (prompt-a-maquinaria-por-cliente.md):
  -- concepto deliberadamente independiente de obra_id (que sigue usándose
  -- solo para atribuir combustible/mantenimiento a una obra concreta, ver
  -- getReportePorCliente en server/maquinaria.js). cliente_asignado_id
  -- responde "¿de qué cliente es este equipo hoy?" en abstracto, sin
  -- ligarlo a una obra específica de ese cliente — decisión explícita de
  -- Paul tras confirmar que quería un campo nuevo y no reutilizar obra_id.
  -- Nullable: "sin asignar" (disponible/en taller) es un estado válido. Un
  -- solo valor por equipo (no tabla puente) porque nunca está asignado a
  -- dos clientes a la vez; reasignar simplemente sobreescribe.
  ALTER TABLE equipos_maquinaria ADD COLUMN IF NOT EXISTS cliente_asignado_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL;

  -- Asignación de equipo a operador (prompt-p2-aislamiento-operador.md):
  -- independiente de cliente_asignado_id (arriba) y de obra_id — un operador
  -- solo debe ver/usar las máquinas que tiene asignadas aquí, nunca la flota
  -- completa. Un equipo tiene exactamente un operador (o ninguno); un
  -- operador puede tener varios equipos. Nullable y reasignable en cualquier
  -- momento, mismo criterio que cliente_asignado_id.
  ALTER TABLE equipos_maquinaria ADD COLUMN IF NOT EXISTS operador_asignado_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;

  -- Categoría de unidad (prompt-6-estado-unidad-operador.md): distinta de
  -- 'tipo' (arriba) a propósito. 'tipo' es el modelo/equipo específico
  -- (retroexcavadora, equipo menor, etc. — texto libre sin CHECK, catálogo
  -- vive en public/app.js MAQUINARIA_TIPOS). 'categoria' es la clasificación
  -- de alto nivel que determina QUÉ VARIANTE de checklist de estado_unidad
  -- aplica (máquina vs. camioneta) — controlada con CHECK porque solo hay 2
  -- variantes de formulario posibles, a diferencia de 'tipo' que sigue
  -- creciendo. Diagnóstico confirmó cero camionetas registradas hoy (las 3
  -- filas existentes son 'retroexcavadora'); DEFAULT 'maquina' las backfillea
  -- sin intervención manual.
  ALTER TABLE equipos_maquinaria ADD COLUMN IF NOT EXISTS categoria TEXT NOT NULL DEFAULT 'maquina' CHECK (categoria IN ('maquina', 'camioneta'));

  -- 'en_taller' como valor nuevo de estado (prompt-responsable-diario-equipo-
  -- menor.md) — el CHECK ya quedó actualizado arriba para instalaciones
  -- nuevas, pero CREATE TABLE IF NOT EXISTS no vuelve a correr sobre una
  -- tabla que ya existe (Preview/producción), así que hace falta reemplazar
  -- el constraint explícitamente. Nombre autogenerado por Postgres para un
  -- CHECK inline sin CONSTRAINT explícito: <tabla>_<columna>_check.
  ALTER TABLE equipos_maquinaria DROP CONSTRAINT IF EXISTS equipos_maquinaria_estado_check;
  ALTER TABLE equipos_maquinaria ADD CONSTRAINT equipos_maquinaria_estado_check CHECK (estado IN ('activo', 'mantenimiento', 'baja', 'en_taller'));

  -- Clasificación pesada/menor (prompt-responsable-diario-equipo-menor.md):
  -- distinta de 'tipo' (texto libre, catálogo de modelo/equipo específico) y
  -- de 'categoria' (máquina/camioneta, variante de checklist estado_unidad).
  -- 'categoria_uso' determina si la ficha del equipo usa el selector formal
  -- de "Operador asignado" (pesada, comportamiento sin cambios) o el registro
  -- abierto de equipo_responsable_diario (menor). DEFAULT 'pesada' para no
  -- reclasificar retroactivamente equipos ya capturados (algunos ya tienen
  -- operador_asignado_id / reportes_horas_maquinaria históricos que no deben
  -- verse afectados) — reclasificación a 'menor' es siempre manual.
  ALTER TABLE equipos_maquinaria ADD COLUMN IF NOT EXISTS categoria_uso TEXT NOT NULL DEFAULT 'pesada' CHECK (categoria_uso IN ('pesada', 'menor'));

  -- Registro abierto de "quién tuvo el equipo hoy" para equipo tipo 'menor'
  -- (prompt-responsable-diario-equipo-menor.md) — deliberadamente separado de
  -- reportes_horas_maquinaria (horas trabajadas con implicación de nómina/
  -- costos, candadeado a operador_asignado_id === req.user.id en 4 endpoints,
  -- ver server/app.js) y de trabajadores (catálogo por obra, no cubre equipo
  -- sin obra ni personas sin registro de obra). nombre_responsable es texto
  -- libre a propósito (decisión confirmada con Paul: "dejar abierto"), no FK
  -- a trabajadores/usuarios — cubre también compartir equipo entre personas
  -- de distintas obras o terceros.
  CREATE TABLE IF NOT EXISTS equipo_responsable_diario (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    nombre_responsable TEXT NOT NULL,
    registrado_por INTEGER REFERENCES usuarios(id),
    registrado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_equipo_responsable_equipo_fecha ON equipo_responsable_diario(equipo_id, fecha);

  CREATE TABLE IF NOT EXISTS combustible_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    litros DOUBLE PRECISION NOT NULL,
    costo DOUBLE PRECISION NOT NULL,
    registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_combustible_maquinaria_equipo ON combustible_maquinaria(equipo_id);

  -- Programa de consumibles (prompt-10-programa-consumibles.md) — decisión
  -- consultada: 'diesel' NO se duplica en una tabla nueva porque
  -- combustible_maquinaria (arriba) ya lo cubre exactamente (litros/fecha/
  -- equipo/costo); el operador captura diesel EN esta misma tabla vía un
  -- endpoint nuevo con su propia validación de ownership (equipo_id debe ser
  -- el operador_asignado_id del operador) — costo/registrado_por se resuelven
  -- igual, sin tocar el flujo existente de jefe_maquinaria. 'lectura'
  -- (horómetro/km opcional en el momento de la captura) no existía en esta
  -- tabla — se agrega nullable para no afectar las filas ya capturadas por
  -- jefe_maquinaria, que nunca la usó.
  ALTER TABLE combustible_maquinaria ADD COLUMN IF NOT EXISTS lectura DOUBLE PRECISION;

  -- Los otros 3 consumibles (aceite_motor/hidraulico/transmision) sí son
  -- tabla nueva — no tienen ningún equivalente existente. insumo_id
  -- referencia el insumo de Insumos usado para resolver costo_estimado (si
  -- lo hay — Insumos solo tiene 'ACEITE' genérico, sin distinguir motor/
  -- hidráulico/transmisión, confirmado en diagnóstico) — nullable porque la
  -- captura NO debe bloquearse por falta de catálogo (Forbidden Actions).
  CREATE TABLE IF NOT EXISTS consumibles_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('aceite_motor', 'aceite_hidraulico', 'aceite_transmision', 'gasolina')),
    cantidad DOUBLE PRECISION NOT NULL,
    unidad TEXT NOT NULL DEFAULT 'litros',
    lectura DOUBLE PRECISION,
    operador_id INTEGER NOT NULL REFERENCES usuarios(id),
    fecha DATE NOT NULL,
    costo_estimado DOUBLE PRECISION,
    insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_consumibles_maquinaria_equipo ON consumibles_maquinaria(equipo_id, creado_en DESC);

  -- prompt-agregar-gasolina-consumibles.md: CREATE TABLE IF NOT EXISTS de
  -- arriba no vuelve a correr sobre Preview/producción (la tabla ya existe
  -- desde el Programa de consumibles original) — se amplía el CHECK aquí
  -- para esas bases ya creadas. Insumos ya tiene un concepto 'GASOLINA'
  -- propio (distinto de 'ACEITE'/'DIESEL'), ver resolverCostoConsumible en
  -- server/maquinaria.js.
  ALTER TABLE consumibles_maquinaria DROP CONSTRAINT IF EXISTS consumibles_maquinaria_tipo_check;
  ALTER TABLE consumibles_maquinaria ADD CONSTRAINT consumibles_maquinaria_tipo_check
    CHECK (tipo IN ('aceite_motor', 'aceite_hidraulico', 'aceite_transmision', 'gasolina'));

  CREATE TABLE IF NOT EXISTS mantenimientos_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('preventivo', 'correctivo')),
    descripcion TEXT,
    costo DOUBLE PRECISION NOT NULL,
    proveedor TEXT,
    registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_mantenimientos_maquinaria_equipo ON mantenimientos_maquinaria(equipo_id);

  CREATE TABLE IF NOT EXISTS reportes_horas_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    operador_id INTEGER NOT NULL REFERENCES usuarios(id),
    fecha DATE NOT NULL,
    horas DOUBLE PRECISION NOT NULL,
    obra_id INTEGER REFERENCES proyectos(id) ON DELETE SET NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_reportes_horas_maquinaria_equipo ON reportes_horas_maquinaria(equipo_id);

  -- Checklist rápido de "estado de la unidad" (prompt-6-estado-unidad-
  -- operador.md): distinto de mantenimientos_maquinaria (bitácora de
  -- taller/mantenimiento de jefe_maquinaria) — este es el checklist de
  -- seguridad/preventivos que captura el propio operador sobre SU unidad
  -- asignada. tipo_unidad queda desnormalizado (copia de equipos_maquinaria.
  -- categoria al momento de la captura) para que el histórico no cambie de
  -- forma retroactiva si la categoría del equipo se reclasifica después.
  -- items en JSONB: [{clave, etiqueta, estado: 'ok'|'atencion'|'critico', nota?}],
  -- validado en código contra el catálogo fijo de cada variante (server/
  -- app.js) — mismo patrón que ACTIVIDADES_MAQUINARIA (sin CHECK a nivel BD
  -- para no duplicar el catálogo en dos lugares).
  CREATE TABLE IF NOT EXISTS estado_unidad (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL REFERENCES equipos_maquinaria(id) ON DELETE CASCADE,
    operador_id INTEGER NOT NULL REFERENCES usuarios(id),
    fecha DATE NOT NULL,
    tipo_unidad TEXT NOT NULL CHECK (tipo_unidad IN ('maquina', 'camioneta')),
    items JSONB NOT NULL,
    lectura NUMERIC,
    observaciones TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_estado_unidad_equipo ON estado_unidad(equipo_id, creado_en DESC);

  -- Catálogo fijo de actividad (prompt-2-rol-operador-actividades.md,
  -- ampliado por prompt-3-actividades-operador-taller-renta.md y
  -- prompt-operador-multiactividad.md): Excavaciones/Cepas/Rellenos/
  -- Acarreos/Carga de material/Limpiezas/Taller/Renta/Conformación de
  -- terreno. Validado en código (server/app.js ACTIVIDADES_MAQUINARIA), no
  -- con CHECK constraint — mismo patrón ya confirmado para usuarios.puesto
  -- en el Prompt 1 (isValidPuesto, sin restricción a nivel BD). Nullable:
  -- los reportes históricos ya guardados sin este campo no se rompen; el
  -- endpoint de captura sí lo exige para reportes nuevos. Desde
  -- prompt-operador-multiactividad.md la captura permite multi-selección:
  -- se guarda como texto con las actividades unidas por ", " en este mismo
  -- campo TEXT (Opción A del diagnóstico — no se parte en varios
  -- registros porque nada agrega por actividad hoy).
  ALTER TABLE reportes_horas_maquinaria ADD COLUMN IF NOT EXISTS actividad TEXT;

  -- Flujo de aprobación operador (captura) -> cabo (autoriza/rechaza)
  -- (prompt-3-flujo-aprobacion-cabo-operador.md). 'pendiente' es el estado
  -- inicial que fija el endpoint de captura para reportes NUEVOS (server/
  -- maquinaria.js createHoras, hardcoded — no lo decide el llamador). El
  -- DEFAULT 'autorizado' de esta columna solo aplica retroactivamente a los
  -- reportes ya existentes al momento de esta migración (capturados antes de
  -- que existiera este flujo) — no bloquear datos históricos ya en uso.
  -- Sin CHECK constraint, mismo patrón que 'actividad' arriba: validación
  -- 100% en código (server/app.js, PUT /api/maquinaria/horas/:id/estado).
  ALTER TABLE reportes_horas_maquinaria ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'autorizado';
  ALTER TABLE reportes_horas_maquinaria ADD COLUMN IF NOT EXISTS revisado_por INTEGER REFERENCES usuarios(id);
  ALTER TABLE reportes_horas_maquinaria ADD COLUMN IF NOT EXISTS revisado_en TIMESTAMPTZ;

  -- Bitácora de taller para jefe_maquinaria (prompt-4-bitacora-taller-jefe-
  -- maquinaria.md): mantenimientos_maquinaria se reutiliza como bitácora
  -- general — decisión confirmada con Paul tras diagnosticar que
  -- combustible_maquinaria NO encaja (litros y equipo_id NOT NULL son
  -- específicos de combustible por equipo; no aplican a comprar una
  -- herramienta o consumible general de taller). combustible_maquinaria
  -- queda intacta, sin cambios.
  -- - equipo_id pasa a NULLABLE: NULL = entrada general de taller
  --   (consumible/herramienta no atada a un equipo); con valor = mantenimiento
  --   de ESE equipo (preventivo/correctivo), igual que antes.
  -- - 'tipo' se amplía con 'consumible'/'herramienta' — la regla de que
  --   preventivo/correctivo SÍ exigen equipo_id (y consumible/herramienta
  --   NO) se valida en código (server/app.js), no aquí.
  -- - refaccion_descripcion/refaccion_costo: desglose OPCIONAL de la
  --   refacción usada en un mantenimiento — nullable, no rompe registros
  --   históricos que solo tenían 'costo' total sin desglose.
  ALTER TABLE mantenimientos_maquinaria ALTER COLUMN equipo_id DROP NOT NULL;
  ALTER TABLE mantenimientos_maquinaria DROP CONSTRAINT IF EXISTS mantenimientos_maquinaria_tipo_check;
  ALTER TABLE mantenimientos_maquinaria ADD CONSTRAINT mantenimientos_maquinaria_tipo_check
    CHECK (tipo IN ('preventivo', 'correctivo', 'consumible', 'herramienta'));
  ALTER TABLE mantenimientos_maquinaria ADD COLUMN IF NOT EXISTS refaccion_descripcion TEXT;
  ALTER TABLE mantenimientos_maquinaria ADD COLUMN IF NOT EXISTS refaccion_costo DOUBLE PRECISION;

  -- ASUNCIÓN sin confirmar con Paul (ver prompt-modulo-maquinaria.md): un solo
  -- monto total sin periodo (no mensual/anual) — fila única forzada por el
  -- CHECK (id = 1), patrón "singleton row".
  CREATE TABLE IF NOT EXISTS presupuesto_maquinaria (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    monto_total DOUBLE PRECISION NOT NULL DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO presupuesto_maquinaria (id, monto_total) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

  -- Cache de precios del Cotizador de materiales (Home Depot / Sodimac —
  -- Materiales Valdez quedó fuera: su sitio no publica precios en línea,
  -- ver prompts-cotizador-permisos.md). Cada fila es un resultado de
  -- scraping para una query+tienda; el cache se considera válido 24h
  -- (ver server/cotizador.js) antes de re-scrapear.
  CREATE TABLE IF NOT EXISTS cotizador_precios (
    id SERIAL PRIMARY KEY,
    query_busqueda TEXT NOT NULL,
    tienda TEXT NOT NULL CHECK (tienda IN ('home_depot', 'sodimac', 'amazon')),
    nombre_producto TEXT NOT NULL,
    precio DOUBLE PRECISION,
    url_producto TEXT,
    fecha_consulta TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_cotizador_precios_query_tienda ON cotizador_precios(query_busqueda, tienda);
  -- Amplía el CHECK de 'tienda' en bases ya existentes (Preview/producción)
  -- para 'amazon' (prompt-cotizador-mas-tiendas.md) — el CREATE TABLE de
  -- arriba no vuelve a correr sobre una tabla existente, así que el CHECK
  -- original se queda corto sin este ALTER explícito. Mercado Libre y
  -- Construrama quedaron fuera del comparador: bloqueo consistente de
  -- bot-detection real (Incapsula en Construrama, verificación de seguridad
  -- en ML) confirmado en diagnóstico de Fase 0 — no hay CAPTCHA resoluble
  -- que automatizar, es un firewall de tráfico automatizado.
  ALTER TABLE cotizador_precios DROP CONSTRAINT IF EXISTS cotizador_precios_tienda_check;
  ALTER TABLE cotizador_precios ADD CONSTRAINT cotizador_precios_tienda_check CHECK (tienda IN ('home_depot', 'sodimac', 'amazon'));

  -- Ubicación fija para cotizar en Amazon (única tienda del comparador que
  -- soporta fijar zona de envío vía UI) — una sola fila activa para toda la
  -- app, no por usuario (prompt-cotizador-mas-tiendas.md, Fase 1).
  CREATE TABLE IF NOT EXISTS cotizador_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    ciudad TEXT,
    codigo_postal TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES usuarios(id)
  );

  -- Estado de Resultados (Tesorería) — Ingresos (facturas/cobros) para
  -- comparar contra Egresos ya calculados en Finanzas (getFinanzasResumenData).
  -- Vínculo con el contrato: solo project_id — la tabla contratos es 1:1 con
  -- project_id (UNIQUE) y no guarda montos (esos viven en meta como filas
  -- sueltas por clave), así que un contrato_id FK sería redundante.
  -- estatus 'cancelada' es el soft-delete (mismo patrón que ordenes_compra/
  -- requisiciones: filtrar con estatus != 'cancelada', nunca DELETE físico).
  CREATE TABLE IF NOT EXISTS facturas (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    folio TEXT,
    concepto TEXT NOT NULL,
    fecha_emision DATE NOT NULL DEFAULT CURRENT_DATE,
    monto_subtotal DOUBLE PRECISION NOT NULL,
    iva DOUBLE PRECISION NOT NULL DEFAULT 0,
    monto_total DOUBLE PRECISION NOT NULL,
    estatus TEXT NOT NULL DEFAULT 'pendiente'
      CHECK (estatus IN ('pendiente', 'cobrada_parcial', 'cobrada_total', 'cancelada')),
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_facturas_project ON facturas(project_id);

  -- Abonos sobre una factura — historial completo, nunca se sobreescribe ni
  -- se borra una fila para "corregir" un cobro (si se captura mal, se
  -- registra un cobro compensatorio; el estatus de la factura se recalcula
  -- siempre a partir de la suma de esta tabla).
  CREATE TABLE IF NOT EXISTS cobros (
    id SERIAL PRIMARY KEY,
    factura_id INTEGER NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
    fecha_cobro DATE NOT NULL DEFAULT CURRENT_DATE,
    monto_cobrado DOUBLE PRECISION NOT NULL,
    forma_pago TEXT,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_cobros_factura ON cobros(factura_id);

  -- Agregada después de que facturas ya existía en Preview/Producción —
  -- prompt-27-control-financiero-fase1.md, CP0 punto 1: el Excel de
  -- referencia (Control_Financiero_KALIA.xlsx) capturaba un campo de
  -- observaciones libres por factura que el modelo original no tenía.
  ALTER TABLE facturas ADD COLUMN IF NOT EXISTS observaciones TEXT;

  -- Gastos Indirectos Corporativos (prompt-27-control-financiero-fase1.md,
  -- Control Financiero Fase 1) — gastos que NO pertenecen a ninguna obra
  -- específica (nómina de oficina, contador, renta corporativa), a
  -- diferencia de gastos_generales que siempre es por-obra
  -- (project_id NOT NULL). Deliberadamente una tabla NUEVA y separada de
  -- gastos_generales (CP0 punto 2, decisión confirmada con Paul):
  -- reutilizar esa tabla habría acoplado este módulo a rutas anidadas bajo
  -- /api/projects/:id (requireProject + auth.verificarAccesoObra, que
  -- exigen una obra) y heredado su DELETE físico condicional
  -- (server/app.js, gastos/:gastoId — permitido si estado != 'pagado'),
  -- que contradice la regla dura de este módulo: nunca DELETE físico.
  -- project_id NULL = gasto corporativo sin obra específica.
  CREATE TABLE IF NOT EXISTS gastos_indirectos_corporativos (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    concepto TEXT NOT NULL,
    monto DOUBLE PRECISION NOT NULL,
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    observaciones TEXT,
    registrado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_gastos_indirectos_project ON gastos_indirectos_corporativos(project_id);

  -- Contabilidad Fase 1 (prompt-contabilidad-fase1-cuentas-polizas.md) —
  -- catálogo de cuentas contables + registro de pólizas. Silo intencionalmente
  -- separado de Finanzas/Erogado Real (diagnóstico Fase 0, prompt-contabilidad-
  -- fase0-diagnostico.md, punto 4) — sin cruce automático, misma decisión que
  -- ya rige Control Financiero vs Finanzas. Gateado por
  -- auth.requireContabilidadAccess (whitelist), no por checkPermiso.
  --
  -- codigo: formato numérico con prefijo por tipo (confirmado con Paul,
  -- diagnóstico Fase 0) — 1xxx=activo, 2xxx=pasivo, 3xxx=capital,
  -- 4xxx=ingreso, 5xxx=gasto. El CHECK de abajo valida el primer dígito
  -- contra el tipo; server/contabilidad.js valida lo mismo antes del INSERT
  -- para dar un mensaje de error legible en vez del texto crudo de Postgres.
  -- codigo NUNCA se edita una vez creada la cuenta (para no romper
  -- referencias históricas en polizas.cuenta_id) — para corregir un código
  -- mal capturado: inactivar + dar de alta una cuenta nueva.
  CREATE TABLE IF NOT EXISTS cuentas_contables (
    id SERIAL PRIMARY KEY,
    codigo TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('activo','pasivo','capital','ingreso','gasto')),
    estatus TEXT NOT NULL DEFAULT 'activa' CHECK (estatus IN ('activa','inactiva')),
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cuentas_contables_codigo_prefijo_tipo CHECK (
      (tipo = 'activo'  AND codigo ~ '^1[0-9]{3,}$') OR
      (tipo = 'pasivo'  AND codigo ~ '^2[0-9]{3,}$') OR
      (tipo = 'capital' AND codigo ~ '^3[0-9]{3,}$') OR
      (tipo = 'ingreso' AND codigo ~ '^4[0-9]{3,}$') OR
      (tipo = 'gasto'   AND codigo ~ '^5[0-9]{3,}$')
    )
  );

  -- Catálogo base sembrado (confirmado con Paul, diagnóstico Fase 0) — punto
  -- de partida editable/ampliable desde la UI, no un catálogo cerrado.
  INSERT INTO cuentas_contables (codigo, nombre, tipo) VALUES
    ('1101', 'Caja', 'activo'),
    ('1102', 'Bancos', 'activo'),
    ('1201', 'Clientes', 'activo'),
    ('2101', 'Proveedores', 'pasivo'),
    ('2102', 'Acreedores diversos', 'pasivo'),
    ('2201', 'Impuestos por pagar', 'pasivo'),
    ('3101', 'Capital social', 'capital'),
    ('4101', 'Ingresos por obra', 'ingreso'),
    ('4102', 'Otros ingresos', 'ingreso'),
    ('5101', 'Gastos indirectos corporativos', 'gasto'),
    ('5102', 'Nómina de oficina', 'gasto'),
    ('5103', 'Renta', 'gasto'),
    ('5104', 'Honorarios contables', 'gasto'),
    ('5105', 'Gastos financieros', 'gasto'),
    ('5106', 'Gastos varios', 'gasto'),
    ('5107', 'Depreciación', 'gasto')
  ON CONFLICT (codigo) DO NOTHING;

  -- project_id NULLABLE = póliza corporativa sin obra específica, mismo
  -- patrón que gastos_indirectos_corporativos. cancelado_por/cancelado_en:
  -- quedan NULL mientras estatus='activa'; se llenan al cancelar (nunca
  -- DELETE físico — regla dura del proyecto).
  CREATE TABLE IF NOT EXISTS polizas (
    id SERIAL PRIMARY KEY,
    tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso','diario')),
    fecha DATE NOT NULL DEFAULT CURRENT_DATE,
    cuenta_id INTEGER NOT NULL REFERENCES cuentas_contables(id),
    monto DOUBLE PRECISION NOT NULL,
    concepto TEXT NOT NULL,
    referencia_factura TEXT,
    project_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    estatus TEXT NOT NULL DEFAULT 'activa' CHECK (estatus IN ('activa','cancelada')),
    cancelado_por INTEGER REFERENCES usuarios(id),
    cancelado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_polizas_project ON polizas(project_id);
  CREATE INDEX IF NOT EXISTS idx_polizas_cuenta ON polizas(cuenta_id);

  -- Contabilidad Fase 2 (prompt-contabilidad-fase2-cfdi.md) — repositorio de
  -- CFDI (facturas fiscales), catálogo consultable por UUID/RFC/fecha.
  -- Deliberadamente SIN FK desde polizas (diagnóstico Fase 2, punto 3,
  -- confirmado con Paul): forzar que cada póliza apunte a un cfdi_id en el
  -- momento de captura añadiría fricción justo en el flujo pensado para ser
  -- rápido — polizas.referencia_factura se queda como texto libre,
  -- correlacionable a simple vista, sin integridad referencial forzada.
  --
  -- origen: 'xml' (caso normal, parseo determinista) o 'pdf_representacion'
  -- (fallback vía Claude API cuando el usuario solo tiene el PDF impreso, sin
  -- el XML — extraccionCFDIPdf.js). xml_blob_url/nombre_archivo_xml son
  -- NULLABLE (no NOT NULL como en la propuesta original del diagnóstico)
  -- precisamente para permitir ese caso: un registro origen='pdf_representacion'
  -- no tiene XML que subir. El CHECK de abajo exige que exista al menos un
  -- archivo (XML o PDF) — nunca un registro sin ningún archivo real detrás.
  --
  -- estatus_sat es manual (vigente/cancelado) — sin integración con el SAT
  -- en esta fase (diagnóstico Fase 2, punto 4). Sin DELETE físico, mismo
  -- criterio que cuentas_contables/polizas.
  CREATE TABLE IF NOT EXISTS cfdi (
    id SERIAL PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE,
    rfc_emisor TEXT NOT NULL,
    rfc_receptor TEXT NOT NULL,
    fecha_emision TIMESTAMPTZ NOT NULL,
    subtotal DOUBLE PRECISION NOT NULL,
    iva DOUBLE PRECISION NOT NULL DEFAULT 0,
    total DOUBLE PRECISION NOT NULL,
    tipo_comprobante TEXT,
    estatus_sat TEXT NOT NULL DEFAULT 'vigente' CHECK (estatus_sat IN ('vigente', 'cancelado')),
    origen TEXT NOT NULL DEFAULT 'xml' CHECK (origen IN ('xml', 'pdf_representacion')),
    xml_blob_url TEXT,
    pdf_blob_url TEXT,
    nombre_archivo_xml TEXT,
    nombre_archivo_pdf TEXT,
    project_id INTEGER REFERENCES proyectos(id) ON DELETE CASCADE,
    subido_por INTEGER REFERENCES usuarios(id),
    subido_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cfdi_al_menos_un_archivo CHECK (xml_blob_url IS NOT NULL OR pdf_blob_url IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_cfdi_project ON cfdi(project_id);
  CREATE INDEX IF NOT EXISTS idx_cfdi_rfc_emisor ON cfdi(rfc_emisor);

  -- Contabilidad Fase 3 (prompt-contabilidad-fase3-conciliacion.md) —
  -- catálogo de cuentas bancarias corporativas + importación/conciliación
  -- de movimientos bancarios. Gateado por la misma auth.requireContabilidadAccess
  -- de Fase 1/2. COMPLETAMENTE separado de cuentas_control/movimientos_control
  -- (server/db.js, control PERSONAL de saldo de Paul/Fer, USUARIOS_CONTROL_
  -- CUENTAS) — decisión confirmada en diagnóstico Fase 3, nunca reusar esas
  -- tablas aquí.
  CREATE TABLE IF NOT EXISTS cuentas_bancarias (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    banco TEXT,
    numero_cuenta TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Seed de una cuenta genérica para que el flujo de importación funcione
  -- desde el día uno sin bloquear en un catálogo vacío — Paul la edita/
  -- renombra después y puede agregar más cuando las necesite (diagnóstico
  -- Fase 3, punto 4: multi-cuenta soportado desde el diseño, sin forzarlo).
  INSERT INTO cuentas_bancarias (nombre)
    SELECT 'Cuenta principal' WHERE NOT EXISTS (SELECT 1 FROM cuentas_bancarias);

  -- poliza_id NULLABLE a propósito (diagnóstico Fase 3, punto 2): no todo
  -- movimiento bancario tiene una póliza correspondiente (comisiones,
  -- intereses, traspasos entre cuentas propias), y la conciliación casi
  -- nunca ocurre en el mismo momento que la importación. UNIQUE compuesto +
  -- ON CONFLICT DO NOTHING en el confirm (server/contabilidad.js) es la
  -- defensa real contra reimportar el mismo archivo dos veces — mismo
  -- patrón ya usado en alertas_contrato_enviadas.UNIQUE(project_id, umbral)
  -- y cfdi.uuid. Sin DELETE físico, mismo criterio que el resto de
  -- Contabilidad.
  CREATE TABLE IF NOT EXISTS movimientos_bancarios (
    id SERIAL PRIMARY KEY,
    cuenta_bancaria_id INTEGER NOT NULL REFERENCES cuentas_bancarias(id),
    fecha DATE NOT NULL,
    descripcion TEXT NOT NULL,
    monto DOUBLE PRECISION NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('cargo', 'abono')),
    poliza_id INTEGER REFERENCES polizas(id),
    estatus TEXT NOT NULL DEFAULT 'pendiente' CHECK (estatus IN ('pendiente', 'conciliado')),
    conciliado_por INTEGER REFERENCES usuarios(id),
    conciliado_en TIMESTAMPTZ,
    importado_por INTEGER REFERENCES usuarios(id),
    importado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cuenta_bancaria_id, fecha, monto, descripcion)
  );
  CREATE INDEX IF NOT EXISTS idx_movimientos_bancarios_cuenta ON movimientos_bancarios(cuenta_bancaria_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_movimientos_bancarios_poliza ON movimientos_bancarios(poliza_id);

  -- Contabilidad Fase 4 (prompt-contabilidad-fase4-depreciacion.md) —
  -- parámetros de depreciación de maquinaria (línea recta). Deliberadamente
  -- SEPARADA de equipos_maquinaria (catálogo operativo de jefe_maquinaria,
  -- gateado por checkPermiso('maquinaria', ...), sistema de permisos
  -- distinto al de Contabilidad) — esta tabla solo LEE equipos_maquinaria
  -- vía FK, nunca la modifica ni le agrega columnas (diagnóstico Fase 4,
  -- punto 1). UNIQUE(equipo_id): un equipo tiene a lo más un set de
  -- parámetros de depreciación (1:1), no un histórico de revisiones.
  --
  -- fecha_baja vive AQUÍ, no en equipos_maquinaria — equipos_maquinaria.estado
  -- ya tiene 'baja' como valor válido (columna existente, sin tocar), pero
  -- no registra FECHA de cuándo pasó a ese estado; capturarla en Contabilidad
  -- (al momento en que el usuario de Contabilidad confirma la baja para
  -- efectos de depreciación) evita depender de que jefe_maquinaria la
  -- hubiera registrado en su propio catálogo (diagnóstico Fase 4, punto 5).
  --
  -- Sin snapshot mensual persistido — el cálculo (depreciación mensual/
  -- acumulada/valor en libros) se deriva on-the-fly en cada consulta desde
  -- estas columnas (server/contabilidad.js, calcularDepreciacion), nunca se
  -- guarda un resultado ya calculado.
  CREATE TABLE IF NOT EXISTS depreciacion_maquinaria (
    id SERIAL PRIMARY KEY,
    equipo_id INTEGER NOT NULL UNIQUE REFERENCES equipos_maquinaria(id),
    valor_adquisicion DOUBLE PRECISION NOT NULL,
    fecha_adquisicion DATE NOT NULL,
    vida_util_meses INTEGER NOT NULL,
    valor_rescate DOUBLE PRECISION NOT NULL DEFAULT 0,
    fecha_baja DATE,
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- % estándar de referencia para Composición de costos (docs/diseno-desglose-
  -- presupuesto-categorias) — usado como "base" de comparación contra el %
  -- real (insumos.categoria) cuando una obra NO tiene contrato/cédula cargado.
  -- Set único global (no por cliente) — confirmado con Paul, no hay noción
  -- previa de estándar por cliente en el código. Sembrado con los valores de
  -- la cédula de Vinte (OE-671-CCLUB.pdf): Materiales+M.O.+Carga Social+
  -- Herramienta = 90% de Costo Directo, Indirecto = 10% adicional.
  CREATE TABLE IF NOT EXISTS porcentajes_referencia_costo (
    id SERIAL PRIMARY KEY,
    categoria TEXT NOT NULL UNIQUE,
    porcentaje DOUBLE PRECISION NOT NULL,
    actualizado_por INTEGER REFERENCES usuarios(id),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO porcentajes_referencia_costo (categoria, porcentaje) VALUES
    ('materiales', 55.0000),
    ('mano_obra', 17.7778),
    ('carga_social', 6.2222),
    ('herramienta_equipo', 11.0000),
    ('indirecto_utilidad', 10.0000)
  ON CONFLICT (categoria) DO NOTHING;

  -- Rename de rol taller -> jefe_maquinaria (prompt-1-rename-operador-jefe-
  -- maquinaria.md). usuarios.puesto es TEXT NOT NULL sin CHECK constraint —
  -- la validación de valores aceptados vive 100% en código (isValidPuesto,
  -- server/auth.js), así que este rename es solo el UPDATE de datos.
  -- Idempotente: sin filas con puesto='taller' que migrar en corridas
  -- subsecuentes, este UPDATE es un no-op.
  UPDATE usuarios SET puesto = 'jefe_maquinaria' WHERE puesto = 'taller';

  -- prompt-3-flujo-aprobacion-cabo-operador.md: cabo deja de capturar horas
  -- directamente y pasa a solo autorizar/rechazar — defaultPermisosParaRol
  -- (server/auth.js) ya refleja esto para altas NUEVAS, pero solo se evalúa
  -- al crear un usuario, así que los cabo ya existentes conservarían
  -- puede_crear=true en 'maquinaria_captura' sin este backfill (mismo criterio
  -- ya usado arriba para el rename taller->jefe_maquinaria). Idempotente: sin
  -- filas que coincidan en corridas subsecuentes, es un no-op.
  UPDATE permisos_usuario SET puede_crear = false, puede_editar = true
  WHERE seccion = 'maquinaria_captura'
    AND usuario_id IN (SELECT id FROM usuarios WHERE puesto = 'cabo');

  -- prompt-fix-cabo-y-extender-residente-maquinaria.md: el UPDATE de arriba
  -- solo corrige a cabo que YA tenían una fila para 'maquinaria_captura'
  -- (de antes del cambio de rol) -- no crea la fila para cabo que nunca la
  -- tuvieron. Confirmado en diagnóstico real: el único cabo activo al
  -- momento del diagnóstico (id 118) no tenía ninguna fila y por lo tanto
  -- seguía recibiendo 403 real al intentar aprobar/rechazar un reporte de
  -- horas. INSERT ... WHERE NOT EXISTS (mismo patrón ya usado arriba para
  -- estado_unidad/maquinaria_consumibles, en vez de otro UPDATE que
  -- tampoco alcanzaría a estos usuarios) para cubrir también este caso.
  INSERT INTO permisos_usuario (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
  SELECT u.id, NULL, 'maquinaria_captura', true, false, true, false, false
  FROM usuarios u
  WHERE u.puesto = 'cabo'
    AND NOT EXISTS (
      SELECT 1 FROM permisos_usuario pu
      WHERE pu.usuario_id = u.id AND pu.proyecto_id IS NULL AND pu.seccion = 'maquinaria_captura'
    );

  -- prompt-fix-cabo-y-extender-residente-maquinaria.md: residente gana
  -- autorización de reportes de horas en Maquinaria, mismo criterio y misma
  -- fila que cabo arriba (puede_ver=true, puede_editar=true, puede_crear=
  -- false -- residente autoriza/rechaza, no captura horas él mismo).
  -- defaultPermisosParaRol (server/auth.js) ya lo da a altas nuevas; este
  -- backfill cubre a los residente ya existentes. INSERT ... WHERE NOT
  -- EXISTS desde el inicio (no repetir el error de cabo arriba, que empezó
  -- como UPDATE-only y dejó fuera a quien nunca tuvo la fila).
  INSERT INTO permisos_usuario (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
  SELECT u.id, NULL, 'maquinaria_captura', true, false, true, false, false
  FROM usuarios u
  WHERE u.puesto = 'residente'
    AND NOT EXISTS (
      SELECT 1 FROM permisos_usuario pu
      WHERE pu.usuario_id = u.id AND pu.proyecto_id IS NULL AND pu.seccion = 'maquinaria_captura'
    );

  -- prompt-6-estado-unidad-operador.md: 'estado_unidad' es una sección NUEVA
  -- que defaultPermisosParaRol (server/auth.js) solo asigna a usuarios dados
  -- de alta a partir de este cambio — mismo patrón ya usado arriba para
  -- 'maquinaria_captura' con cabo. Backfill para operador/cabo/jefe_maquinaria
  -- YA existentes en Preview (3 operadores, 1 cabo, 1 jefe_maquinaria al
  -- momento del diagnóstico).
  -- NOT EXISTS en vez de ON CONFLICT: proyecto_id es NULL en estas filas, y
  -- Postgres NO considera NULL=NULL para efectos de UNIQUE — ON CONFLICT
  -- (usuario_id, proyecto_id, seccion) DO NOTHING NO habría evitado
  -- duplicados en cada cold start (confirmado empíricamente antes de este
  -- fix: un segundo INSERT idéntico con proyecto_id NULL sí pasa el
  -- constraint). NOT EXISTS sí es correcto para NULL e idempotente de verdad.
  INSERT INTO permisos_usuario (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
  SELECT u.id, NULL, 'estado_unidad', true, (u.puesto = 'operador'), false, false, false
  FROM usuarios u
  WHERE u.puesto IN ('operador', 'cabo', 'jefe_maquinaria')
    AND NOT EXISTS (
      SELECT 1 FROM permisos_usuario pu
      WHERE pu.usuario_id = u.id AND pu.proyecto_id IS NULL AND pu.seccion = 'estado_unidad'
    );

  -- prompt-10-programa-consumibles.md: mismo backfill, mismo criterio, para
  -- 'maquinaria_consumibles' — operador ver+crear, cabo/jefe_maquinaria solo
  -- ver (igual que estado_unidad arriba).
  INSERT INTO permisos_usuario (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
  SELECT u.id, NULL, 'maquinaria_consumibles', true, (u.puesto = 'operador'), false, false, false
  FROM usuarios u
  WHERE u.puesto IN ('operador', 'cabo', 'jefe_maquinaria')
    AND NOT EXISTS (
      SELECT 1 FROM permisos_usuario pu
      WHERE pu.usuario_id = u.id AND pu.proyecto_id IS NULL AND pu.seccion = 'maquinaria_consumibles'
    );

  -- prompt-fix-permisos-maquinaria-completo.md: 'maquinaria_captura' para
  -- operador. defaultPermisosParaRol (server/auth.js:557-560) ya la da a
  -- altas NUEVAS (puede_ver=true, puede_crear=true), pero ningún backfill
  -- anterior cubrió a los operador ya existentes -- los backfills previos de
  -- esta misma sección (arriba) solo cubrieron cabo/residente. Confirmado en
  -- auditoría: 3 operador reales (ids 126, 240, 241) sin esta fila, bloqueados
  -- para capturar horas pese a que su rol sí debería tener el permiso. INSERT
  -- ... WHERE NOT EXISTS, mismo patrón y mismos valores que defaultPermisosParaRol
  -- (nunca UPDATE, para no repetir el error de cabo que dejó fuera a quien
  -- nunca tuvo la fila).
  INSERT INTO permisos_usuario (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
  SELECT u.id, NULL, 'maquinaria_captura', true, true, false, false, false
  FROM usuarios u
  WHERE u.puesto = 'operador'
    AND NOT EXISTS (
      SELECT 1 FROM permisos_usuario pu
      WHERE pu.usuario_id = u.id AND pu.proyecto_id IS NULL AND pu.seccion = 'maquinaria_captura'
    );

  -- prompt-fix-permisos-maquinaria-completo.md: 'maquinaria_combustible' para
  -- jefe_maquinaria -- mismo gap y mismo criterio que 'maquinaria_captura'/
  -- operador arriba. defaultPermisosParaRol (server/auth.js:533-536) ya da
  -- puede_ver=true, puede_crear=true a altas NUEVAS; sin backfill previo para
  -- esta sección. Confirmado en auditoría: 1 jefe_maquinaria real (id 128) sin
  -- esta fila, bloqueado para registrar combustible/mantenimiento.
  INSERT INTO permisos_usuario (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
  SELECT u.id, NULL, 'maquinaria_combustible', true, true, false, false, false
  FROM usuarios u
  WHERE u.puesto = 'jefe_maquinaria'
    AND NOT EXISTS (
      SELECT 1 FROM permisos_usuario pu
      WHERE pu.usuario_id = u.id AND pu.proyecto_id IS NULL AND pu.seccion = 'maquinaria_combustible'
    );

  -- prompt-fondo-garantia-editable-panel.md: defaultPermisosParaRol
  -- (server/auth.js) ya da puede_editar=true en 'finanzas' a tesorería para
  -- altas NUEVAS, pero solo se evalúa al crear un usuario — mismo criterio
  -- ya usado arriba para maquinaria_captura/cabo. Backfill UPDATE (no
  -- INSERT: 'finanzas' ya existía como sección para tesorería desde antes,
  -- con puede_ver=true) para que tesorería ya existente no se quede solo
  -- viendo mientras un tesorería dado de alta después de este cambio sí
  -- puede editar. Idempotente: sin filas que coincidan (puede_editar ya en
  -- true) en corridas subsecuentes, es un no-op.
  UPDATE permisos_usuario SET puede_editar = true
  WHERE seccion = 'finanzas'
    AND usuario_id IN (SELECT id FROM usuarios WHERE puesto = 'tesoreria');

  -- Control de Cuentas (control personal de saldo bancario de Paul/Fer,
  -- prompt-control-cuentas.md) — DELIBERADAMENTE fuera del sistema de
  -- permisos_usuario/checkPermiso: acceso gateado por una whitelist de
  -- usuario_id hardcodeada en server/auth.js (USUARIOS_CONTROL_CUENTAS),
  -- no por rol — confirmado en diagnóstico que admin/desarrollador bypassean
  -- checkPermiso por PUESTO, no por usuario, y hoy existen 5 cuentas con esos
  -- roles (no solo Paul/Fer) — una sección de permiso normal habría expuesto
  -- saldo personal a esas otras cuentas. Sin relación con ninguna tabla
  -- financiera del negocio (Costos/Finanzas/Nómina) a propósito — es un
  -- control personal separado.
  CREATE TABLE IF NOT EXISTS cuentas_control (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    banco TEXT,
    saldo_inicial DOUBLE PRECISION NOT NULL DEFAULT 0,
    fecha_saldo_inicial DATE NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Todos los movimientos son gastos (monto > 0 resta del saldo) — sin
  -- ingresos/depósitos en este PR (confirmado en diagnóstico: Paul no pidió
  -- esa lectura, y el prompt exigía pausar si aparecía esa necesidad).
  CREATE TABLE IF NOT EXISTS movimientos_control (
    id SERIAL PRIMARY KEY,
    cuenta_id INTEGER NOT NULL REFERENCES cuentas_control(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    concepto TEXT NOT NULL,
    monto DOUBLE PRECISION NOT NULL CHECK (monto > 0),
    registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_movimientos_control_cuenta ON movimientos_control(cuenta_id, fecha);

  -- Split de pago de nómina (prompt-29-split-pago-cuentas.md): porcentaje que
  -- va a cuenta_nomina_hsbc, capturado una sola vez al alta del trabajador (o
  -- editado después) y no por periodo — el resto (100 - pct) va a
  -- cuenta_alterna automáticamente en el reporte/export. Default 100 (todo a
  -- la cuenta principal) para no romper trabajadores existentes ni obligar a
  -- definir el split si no aplica; si cuenta_alterna está vacía, el split se
  -- ignora en el cálculo (100% a cuenta_nomina_hsbc sin importar el valor
  -- aquí, ver calcularSplitCuentas en server/calculos.js).
  ALTER TABLE trabajadores ADD COLUMN IF NOT EXISTS split_cuenta_nomina_pct NUMERIC NOT NULL DEFAULT 100
    CHECK (split_cuenta_nomina_pct >= 0 AND split_cuenta_nomina_pct <= 100);

  -- prompt-31-trabajador-multiobra-nn.md, CP0/CP1: bajo el modelo N:N,
  -- trabajadores.project_id deja de ser "la obra del trabajador" y pasa a ser
  -- solo su obra primaria/de alta (columna conservada por compatibilidad con
  -- endpoints aún no migrados a trabajador_obras — documentos/contratos/EPP/
  -- listado global, PR 2 pendiente). Con el ON DELETE CASCADE original,
  -- borrar esa obra primaria arrastraría en cascada TODO el trabajador —
  -- incluyendo su historial en las demás obras donde esté activo vía
  -- trabajador_obras. Cambiado a RESTRICT (confirmado con Paul): borrar una
  -- obra con trabajadores que la tengan como primaria falla con error de DB
  -- en vez de perder historial cruzado en silencio.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'trabajadores'::regclass AND confrelid = 'proyectos'::regclass
        AND contype = 'f' AND confdeltype != 'r'
    ) THEN
      ALTER TABLE trabajadores DROP CONSTRAINT trabajadores_project_id_fkey;
      ALTER TABLE trabajadores ADD CONSTRAINT trabajadores_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES proyectos(id) ON DELETE RESTRICT;
    END IF;
  END $$;

  -- Modelo N:N trabajador<->obra (prompt-31, PR 1 de 2 — alcance acotado a
  -- modelo + endpoints core: listado por obra, alta, edición, asignar/
  -- desasignar, nómina/asistencia. Documentos/contratos/EPP/listado global
  -- quedan para el PR 2, migrando cada uno una vez validado este modelo base
  -- con datos reales en Preview). Reemplaza a trabajador_movimientos
  -- (PR #110, cerrado sin mergear, sin datos reales que migrar) — cada fila
  -- con fecha_asignacion/fecha_desasignacion ya da el historial completo de
  -- por dónde pasó cada trabajador, sin necesitar 2 tablas paralelas.
  CREATE TABLE IF NOT EXISTS trabajador_obras (
    id SERIAL PRIMARY KEY,
    trabajador_id INTEGER NOT NULL REFERENCES trabajadores(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE RESTRICT,
    curp TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    fecha_asignacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_desasignacion TIMESTAMPTZ,
    asignado_por INTEGER REFERENCES usuarios(id)
  );
  CREATE INDEX IF NOT EXISTS idx_trabajador_obras_trabajador ON trabajador_obras(trabajador_id);
  CREATE INDEX IF NOT EXISTS idx_trabajador_obras_project ON trabajador_obras(project_id, activo);

  -- UNIQUE de CURP por obra bajo el nuevo modelo — un mismo CURP no puede
  -- estar ACTIVO dos veces en la misma obra, pero sí en varias obras
  -- distintas del mismo cliente simultáneamente (confirmado con Paul).
  -- curp se DUPLICA aquí a propósito (un UNIQUE INDEX no puede referenciar
  -- una columna de otra tabla) — el trigger de abajo lo mantiene
  -- sincronizado con trabajadores.curp SIEMPRE que cambie, para que nunca
  -- quede obsoleto ni deje pasar un duplicado real por datos
  -- desincronizados (decisión explícita con Paul: constraint real de DB >
  -- validación de aplicación, pese a la duplicación de dato).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_trabajador_obras_curp_unico_activo
    ON trabajador_obras (project_id, curp)
    WHERE activo = true AND curp IS NOT NULL AND TRIM(curp) <> '';

  CREATE OR REPLACE FUNCTION sync_curp_trabajador_obras() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.curp IS DISTINCT FROM OLD.curp THEN
      UPDATE trabajador_obras SET curp = NEW.curp WHERE trabajador_id = NEW.id AND activo = true;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_sync_curp_trabajador_obras ON trabajadores;
  CREATE TRIGGER trg_sync_curp_trabajador_obras
    AFTER UPDATE OF curp ON trabajadores
    FOR EACH ROW
    EXECUTE FUNCTION sync_curp_trabajador_obras();

  -- Backfill: cada trabajador existente obtiene su primera fila en
  -- trabajador_obras, reflejando la asignación que ya tenía vía project_id
  -- (nunca DELETE, regla dura del proyecto — esto es puramente aditivo).
  -- Idempotente por diseño (WHERE NOT EXISTS) — corre en cada cold start sin
  -- duplicar filas, y de paso sirve de red de seguridad si algún trabajador
  -- nuevo llegara a crearse sin su fila correspondiente en trabajador_obras.
  INSERT INTO trabajador_obras (trabajador_id, project_id, curp, activo, fecha_asignacion)
  SELECT t.id, t.project_id, t.curp, t.activo, COALESCE(t.fecha_ingreso::timestamptz, t.creado_en)
  FROM trabajadores t
  WHERE NOT EXISTS (SELECT 1 FROM trabajador_obras o WHERE o.trabajador_id = t.id);

  -- Fase 2 del roadmap "Desarrollador de Vivienda" (prompt-fase2-
  -- infraestructura-implementacion.md, diagnóstico previo en prompt-
  -- diagnostico-fase2-infraestructura.md). conceptos.grupo ya distingue de
  -- facto infraestructura de vivienda en datos reales (ej. "CALLE BARRANCAS",
  -- "RED HIDRAULICA" vs. "AZOTEA", "NIVEL 1-4", "TORRE A/B") pero es texto
  -- libre e inconsistente entre obras — esta tabla es la curación MANUAL
  -- admin/residente de esa clasificación, nunca inferida por keyword-matching
  -- (Forbidden Action explícita del prompt). Scoped por project_id a
  -- propósito: el mismo texto de grupo puede significar cosas distintas en
  -- obras distintas, así que la clasificación nunca se comparte entre obras.
  -- Solo 2 valores en el CHECK ('infraestructura'/'vivienda') — "sin
  -- clasificar" NUNCA se persiste como valor: es la ausencia de fila para ese
  -- (project_id, grupo), resuelta en tiempo de consulta vía LEFT JOIN (ver
  -- GET /api/projects/:id/avance-por-categoria en server/app.js). Sin
  -- relación con la tabla lotes (Fase 1) a propósito — Forbidden Action
  -- explícita, ninguna FK ni JOIN cruzado entre ambas tablas en esta fase.
  CREATE TABLE IF NOT EXISTS conceptos_grupo_categoria (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES proyectos(id) ON DELETE CASCADE,
    grupo TEXT NOT NULL,
    categoria TEXT NOT NULL CHECK (categoria IN ('infraestructura', 'vivienda')),
    creado_por INTEGER REFERENCES usuarios(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, grupo)
  );
  CREATE INDEX IF NOT EXISTS idx_conceptos_grupo_categoria_project ON conceptos_grupo_categoria(project_id);
`;

// prompt-fix-error-permiso-trabajadores.md → el diagnóstico de ese prompt no
// encontró ningún bug real ligado a 'trabajadores' (reproducido sin éxito
// contra Postgres desechable y vía UI real); en su lugar, los logs de
// runtime de Vercel mostraron deadlocks reales y recurrentes (10-34
// ocurrencias, activos desde el 3 hasta el 20 de julio) con initSchema() en
// el stack trace. Causa: api/index.js corre initSchema() una vez por cada
// cold start de cada instancia serverless (ensureInit() en api/index.js);
// si dos instancias arrancan en frío casi al mismo tiempo, sus dos
// ejecuciones concurrentes de este bloque —varios ALTER TABLE, cada uno
// toma un lock ACCESS EXCLUSIVE— pueden tomar locks en tablas distintas en
// orden distinto y deadlockear entre sí. Como ensureInit() no envuelve el
// await en try/catch, el error sube crudo y Vercel responde 500 genérico a
// cualquier request que haya coincidido con ese cold start — sin relación
// alguna con qué sección de permisos se estuviera guardando en ese momento.
//
// Fix: pg_advisory_xact_lock serializa las ejecuciones concurrentes de
// initSchema() — la segunda transacción espera aquí (antes de tocar
// cualquier tabla) en vez de competir por locks de tabla más abajo. Se
// libera solo al hacer COMMIT/ROLLBACK (withTransaction ya maneja ambos),
// sin necesidad de un unlock manual. hashtext(...) da un identificador
// estable y legible en vez de un número mágico arbitrario.
async function initSchema() {
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ctrl-ppto:initSchema'))");
    await client.query(SCHEMA);
  });
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listProjects() {
  const { rows } = await pool.query('SELECT * FROM proyectos ORDER BY id DESC');
  return rows;
}

async function getProject(id) {
  const { rows } = await pool.query('SELECT * FROM proyectos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createProjectRecord(nombre, archivoOriginal, clienteId) {
  const { rows } = await pool.query(
    'INSERT INTO proyectos (nombre, archivo_original, cliente_id) VALUES ($1, $2, $3) RETURNING *',
    [nombre, archivoOriginal, clienteId]
  );
  return rows[0];
}

async function deleteProject(id) {
  return withTransaction(async (client) => {
    // Varias FK no tienen ON DELETE CASCADE, lo que hace que el DELETE en
    // cascada falle con FK-violation. Las eliminamos manualmente en el orden
    // correcto antes de borrar el proyecto para que el CASCADE maneje el resto.
    await client.query(`
      DELETE FROM recepcion_items
      WHERE recepcion_id IN (
        SELECT r.id FROM recepciones r
        JOIN ordenes_compra oc ON r.orden_compra_id = oc.id
        WHERE oc.project_id = $1
      )`, [id]);
    await client.query(`
      DELETE FROM orden_compra_items
      WHERE orden_compra_id IN (SELECT id FROM ordenes_compra WHERE project_id = $1)
    `, [id]);
    // requisicion_items.insumo_id → insumos(id) no tiene CASCADE; si existen
    // filas cuando el CASCADE intenta borrar insumos, lanza FK-violation.
    await client.query(`
      DELETE FROM requisicion_items
      WHERE requisicion_id IN (SELECT id FROM requisiciones WHERE project_id = $1)
    `, [id]);
    await client.query(`
      DELETE FROM nomina_items
      WHERE nomina_id IN (SELECT id FROM nominas WHERE project_id = $1)
    `, [id]);
    const { rowCount } = await client.query('DELETE FROM proyectos WHERE id = $1', [id]);
    return rowCount > 0;
  });
}

module.exports = { pool, initSchema, withTransaction, listProjects, getProject, createProjectRecord, deleteProject };
