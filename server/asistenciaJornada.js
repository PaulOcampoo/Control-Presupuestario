'use strict';

// Registro de jornada (entrada / comida / salida) — helpers puros de cálculo
// y validación (prompt-registro-jornada-nomina.md). Todo trabaja con strings
// 'HH:MM' de hora de pared (México); NUNCA con Date/zona horaria del servidor.

const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

// 'HH:MM' | 'HH:MM:SS' (lo que devuelve TIME de Postgres) -> 'HH:MM' | null
function normalizarHora(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(s);
  return m ? `${m[1]}:${m[2]}` : s;
}

function aMinutos(hhmm) {
  const m = RE_HORA.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ¿Qué horas requiere el registro para estar "completo"?
function horasRequeridas(tipoJornada, sinComida) {
  if (tipoJornada === 'corrida') return ['hora_entrada', 'hora_salida'];
  if (sinComida) return ['hora_entrada', 'hora_salida'];
  return ['hora_entrada', 'hora_salida_comida', 'hora_regreso_comida', 'hora_salida'];
}

// Cálculo al leer (no se almacena). Devuelve trabajadas_min/extra_min = null
// si falta cualquier hora requerida (completo=false).
function calcularJornada(reg, { tipo_jornada = 'con_comida', horas_jornada = 8 } = {}) {
  if (!reg) return { completo: false, trabajadas_min: null, extra_min: null };
  const sinComida = !!reg.sin_comida;
  const comidaAplica = tipo_jornada === 'con_comida' && !sinComida;
  const req = horasRequeridas(tipo_jornada, sinComida);
  const completo = req.every((k) => !!reg[k]);
  if (!completo) return { completo: false, trabajadas_min: null, extra_min: null };
  const bruto = aMinutos(normalizarHora(reg.hora_salida)) - aMinutos(normalizarHora(reg.hora_entrada));
  const comida = comidaAplica
    ? aMinutos(normalizarHora(reg.hora_regreso_comida)) - aMinutos(normalizarHora(reg.hora_salida_comida))
    : 0;
  const trabajadas = bruto - comida;
  const extra = Math.max(0, trabajadas - Math.round(Number(horas_jornada) * 60));
  return { completo: true, trabajadas_min: trabajadas, extra_min: extra };
}

// Valida un payload de horas. Devuelve { error } (400) o { warnings }.
// Jornada que cruza medianoche NO soportada (entrada < salida obligatorio).
function validarHoras(p, { tipo_jornada = 'con_comida' } = {}) {
  const campos = ['hora_entrada', 'hora_salida_comida', 'hora_regreso_comida', 'hora_salida'];
  const v = {};
  for (const c of campos) {
    const val = p[c] == null || p[c] === '' ? null : String(p[c]);
    if (val !== null && !RE_HORA.test(val)) return { error: `Formato de hora inválido en ${c} (usa HH:MM)` };
    v[c] = val;
  }
  const sinComida = !!p.sin_comida;
  if (tipo_jornada === 'corrida' || sinComida) {
    // Jornada sin comida: los campos de comida no aplican y se descartan.
    v.hora_salida_comida = null;
    v.hora_regreso_comida = null;
  }
  const e = aMinutos(v.hora_entrada), sc = aMinutos(v.hora_salida_comida);
  const rc = aMinutos(v.hora_regreso_comida), s = aMinutos(v.hora_salida);
  if (e != null && s != null && !(e < s)) return { error: 'La hora de entrada debe ser anterior a la salida (no se soportan jornadas que cruzan medianoche)' };
  if (sc != null && e != null && !(sc > e)) return { error: 'La salida a comer debe ser posterior a la entrada' };
  if (rc != null && sc != null && !(rc > sc)) return { error: 'El regreso de comer debe ser posterior a la salida a comer' };
  if (s != null && rc != null && !(s > rc)) return { error: 'La salida debe ser posterior al regreso de comer' };
  if (rc != null && sc == null) return { error: 'Falta la hora de salida a comer' };
  if (s != null && sc != null && rc == null) {
    // permitido guardar incompleto, pero salida no puede quedar antes de salida a comer
    if (!(s > sc)) return { error: 'La salida debe ser posterior a la salida a comer' };
  }
  if (e == null && (sc != null || rc != null || s != null)) return { error: 'Captura primero la hora de entrada' };

  const warnings = [];
  const calc = calcularJornada({ ...v, sin_comida: sinComida }, { tipo_jornada, horas_jornada: p.horas_jornada ?? 8 });
  if (sc != null && rc != null && rc - sc > 90) warnings.push('La comida dura más de 90 minutos');
  if (e != null && s != null && s - e > 12 * 60) warnings.push('La jornada dura más de 12 horas');
  if (calc.extra_min != null && calc.extra_min > 180) warnings.push('Más de 3 horas extra');
  return { valores: v, sin_comida: sinComida, warnings };
}

// Campos comparables para bitácora / detección de "cambio real".
const CAMPOS_LOG = ['hora_entrada', 'hora_salida_comida', 'hora_regreso_comida', 'hora_salida', 'sin_comida'];

function diffCampos(anterior, nuevo) {
  const out = [];
  for (const c of CAMPOS_LOG) {
    const a = c === 'sin_comida' ? String(!!anterior[c]) : normalizarHora(anterior[c]);
    const n = c === 'sin_comida' ? String(!!nuevo[c]) : normalizarHora(nuevo[c]);
    if ((a ?? null) !== (n ?? null)) out.push({ campo: c, valor_anterior: a ?? null, valor_nuevo: n ?? null });
  }
  return out;
}

// Serializa una fila de BD a la forma de API (strings HH:MM + calculados).
function filaAApi(row, trab) {
  if (!row) return null;
  const reg = {
    hora_entrada: normalizarHora(row.hora_entrada),
    hora_salida_comida: normalizarHora(row.hora_salida_comida),
    hora_regreso_comida: normalizarHora(row.hora_regreso_comida),
    hora_salida: normalizarHora(row.hora_salida),
    sin_comida: !!row.sin_comida,
  };
  return { id: row.id, ...reg, ...calcularJornada(reg, trab), editado: !!row.actualizado_en, actualizado_por_nombre: row.actualizado_por_nombre || null, actualizado_en: row.actualizado_en || null };
}

module.exports = { RE_HORA, normalizarHora, aMinutos, horasRequeridas, calcularJornada, validarHoras, diffCampos, filaAApi, CAMPOS_LOG };
