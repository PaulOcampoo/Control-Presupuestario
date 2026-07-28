'use strict';

// prompt-p8-migracion-permisos-navegacion.md (punto 2, "MIGRACIÓN DE SIEMBRA").
//
// Siembra permisos_usuario para usuarios EXISTENTES cuyo puesto no es
// admin/desarrollador (esos dos bypasean permisos_usuario por completo, no
// necesitan fila). Por cada usuario, calcula auth.defaultPermisosParaRol(puesto)
// — la misma función que ya usa POST /api/usuarios al dar de alta un usuario
// nuevo — e inserta las filas con proyecto_id NULL (aplican a todas las obras)
// que todavía no existan.
//
// Idempotente por diseño: NO usa `ON CONFLICT (usuario_id, proyecto_id, seccion)
// DO NOTHING` porque Postgres no trata NULL=NULL como conflicto en un índice
// único (dos filas con el mismo usuario_id+seccion y proyecto_id NULL no
// chocan entre sí) — mismo problema ya documentado en PUT /api/permisos/:id
// (server/app.js). En vez de eso, cada INSERT lleva su propio
// `WHERE NOT EXISTS (...)` verificando explícitamente por proyecto_id IS NULL.
// Nunca hace UPDATE ni pisa una fila ya existente (aunque esa fila diga
// puede_ver=false) — un permiso ya personalizado por Paul se queda intacto.
//
// Uso: node --env-file=.env scripts/seed-permisos-usuario.js
//      node --env-file=.env scripts/seed-permisos-usuario.js --dry-run

const { Pool } = require('pg');
const auth = require('../server/auth');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: users } = await pool.query(
    `SELECT id, usuario, puesto FROM usuarios
     WHERE activo = true AND puesto NOT IN ('admin', 'desarrollador')
     ORDER BY puesto, id`
  );

  console.log(`Usuarios a sembrar: ${users.length}${DRY_RUN ? ' (--dry-run, sin escribir)' : ''}`);
  console.log('');

  let totalInsertadas = 0;
  const resumenPorUsuario = [];

  for (const u of users) {
    const defaults = auth.defaultPermisosParaRol(u.puesto);
    let insertadasUsuario = 0;
    const seccionesInsertadas = [];

    for (const p of defaults) {
      const { rows: existe } = await pool.query(
        `SELECT 1 FROM permisos_usuario
         WHERE usuario_id = $1 AND proyecto_id IS NULL AND seccion = $2`,
        [u.id, p.seccion]
      );
      if (existe.length) continue; // ya hay fila (personalizada o de siembra previa) — no se toca

      if (!DRY_RUN) {
        await pool.query(
          `INSERT INTO permisos_usuario
             (usuario_id, proyecto_id, seccion, puede_ver, puede_crear, puede_editar, puede_editar_precios, puede_eliminar)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
          [u.id, p.seccion, p.puede_ver, p.puede_crear, p.puede_editar, p.puede_editar_precios, p.puede_eliminar]
        );
      }
      insertadasUsuario++;
      seccionesInsertadas.push(p.seccion);
    }

    totalInsertadas += insertadasUsuario;
    resumenPorUsuario.push({ id: u.id, usuario: u.usuario, puesto: u.puesto, insertadas: insertadasUsuario, secciones: seccionesInsertadas });
    console.log(`#${u.id} ${u.usuario} (${u.puesto}): ${insertadasUsuario} fila(s) nueva(s)${seccionesInsertadas.length ? ' -> [' + seccionesInsertadas.join(', ') + ']' : ''}`);
  }

  console.log('');
  console.log(`Total filas ${DRY_RUN ? 'a insertar' : 'insertadas'}: ${totalInsertadas}`);

  await pool.end();
  return resumenPorUsuario;
}

main().catch((err) => { console.error(err); process.exit(1); });
