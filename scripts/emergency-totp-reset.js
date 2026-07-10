// Reset de emergencia de 2FA — SOLO para cuando un Admin/Desarrollador se
// queda sin acceso a su propio dispositivo TOTP y a sus backup codes, y por
// lo tanto nadie puede usar el reset normal desde la app (POST
// /api/usuarios/:id/totp-reset), ya que ese requiere estar autenticado.
//
// Deliberadamente NO es un endpoint web: solo se puede ejecutar con acceso
// directo a las variables de entorno de producción (DATABASE_URL), el mismo
// nivel de acceso que ya hace falta para todo lo demás en este proyecto.
//
// Uso:
//   node --env-file=.env scripts/emergency-totp-reset.js <usuario>
//   (o con las env vars de producción exportadas/pulled vía `vercel env pull`)
'use strict';

const readline = require('readline');
const { Pool } = require('pg');

async function confirm(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(pregunta, (respuesta) => { rl.close(); resolve(respuesta.trim()); });
  });
}

async function main() {
  const usuario = process.argv[2];
  if (!usuario) {
    console.error('Uso: node --env-file=.env scripts/emergency-totp-reset.js <usuario>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL no está en el entorno — este script necesita acceso directo a la base de datos.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    const { rows } = await pool.query(
      'SELECT id, nombre, usuario, puesto, totp_enabled FROM usuarios WHERE usuario = $1',
      [usuario]
    );
    if (!rows[0]) {
      console.error(`No existe ningún usuario con "usuario" = "${usuario}".`);
      process.exit(1);
    }
    const target = rows[0];
    console.log(`\nSe va a resetear el 2FA de:`);
    console.log(`  id: ${target.id}  nombre: ${target.nombre}  usuario: ${target.usuario}  puesto: ${target.puesto}`);
    console.log(`  2FA actualmente: ${target.totp_enabled ? 'activo' : 'no inscrito'}\n`);

    const respuesta = await confirm(`Escribe exactamente "${target.usuario}" para confirmar: `);
    if (respuesta !== target.usuario) {
      console.error('Confirmación no coincide — cancelado, no se hizo ningún cambio.');
      process.exit(1);
    }

    await pool.query(
      'UPDATE usuarios SET totp_secret = NULL, totp_enabled = false, totp_backup_codes = NULL WHERE id = $1',
      [target.id]
    );
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_usuario, accion, target_id, target_usuario, ip)
       VALUES (NULL, $1, 'emergency_totp_reset', $2, $3, 'cli-directo')`,
      [`cli:${process.env.USER || process.env.USERNAME || 'desconocido'}`, target.id, target.usuario]
    );

    console.log(`\n2FA reseteado para "${target.usuario}". Se le pedirá inscribirse de nuevo (escanear un QR nuevo) en su próximo login.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
