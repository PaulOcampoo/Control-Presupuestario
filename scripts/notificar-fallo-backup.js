'use strict';

// prompt-p6-backup-neon.md (punto 3, "idealmente reusar el mecanismo de
// notificaciones ya existente"): corre solo si el job de backup falló
// (ver `if: failure()` en .github/workflows/backup-neon.yml). Inserta una
// notificación in-app para admin y desarrollador, mismo patrón/tabla que
// notificarAdmins() en server/notificaciones.js — sin depender de un
// endpoint HTTP nuevo, ya que este script corre con acceso directo a la
// misma DATABASE_URL de producción que usó pg_dump en el paso anterior.
// El log de GitHub Actions (visible en la pestaña Actions del run fallido)
// sigue siendo el registro mínimo obligatorio; esto es la capa adicional
// "idealmente".

const { Pool } = require('pg');

async function main() {
  // DIAGNÓSTICO TEMPORAL (quitar una vez confirmada la causa de "relation
  // usuarios does not exist" en la corrida real del 2026-07-28): imprime a
  // qué host/base se está conectando realmente, sin exponer el password —
  // para confirmar si DATABASE_URL trae o no el nombre de base (si falta,
  // libpq conecta por default a una base con el nombre del rol, no a
  // 'neondb', lo que explicaría el error aunque el servidor/rol estén bien).
  try {
    const u = new URL(process.env.DATABASE_URL || '');
    const db = u.pathname.replace(/^\//, '') || '(vacío — tomará el default de libpq, probablemente el nombre del rol)';
    console.log(`[diagnóstico temporal] host=${u.hostname} db=${db}`);
  } catch (e) {
    console.log('[diagnóstico temporal] DATABASE_URL no parseable como URL:', e.message);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows: admins } = await pool.query(
    "SELECT id FROM usuarios WHERE puesto IN ('admin', 'desarrollador') AND activo = true"
  );
  const mensaje = 'Falló el backup semanal de la base de datos (GitHub Actions) — revisa el log del workflow "Backup semanal de Neon a Vercel Blob" para el detalle.';
  for (const a of admins) {
    await pool.query(
      `INSERT INTO notificaciones (usuario_id, project_id, tipo, referencia_id, mensaje)
       VALUES ($1, NULL, 'backup_fallido', NULL, $2)`,
      [a.id, mensaje]
    );
  }
  console.log(`Notificación de fallo de backup insertada para ${admins.length} usuario(s) admin/desarrollador.`);
  await pool.end();
}

main().catch((err) => {
  // Best-effort: si ni siquiera esto puede insertarse (ej. la propia
  // DATABASE_URL falló, la misma razón del backup), el log de GitHub
  // Actions del job fallido ya es el registro mínimo garantizado.
  console.error('No se pudo insertar la notificación de fallo de backup:', err.message);
  process.exit(1);
});
