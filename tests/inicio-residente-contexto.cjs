'use strict';
const request=require('supertest'),assert=require('node:assert/strict');const app=require('../server/app'),db=require('../server/db'),auth=require('../server/auth');
const A=t=>({Authorization:'Bearer '+t});
async function crear(){
 assert(new URL(process.env.DATABASE_URL).hostname.startsWith('ep-noisy-shadow'),'Solo Preview');
 const c={marca:'QA_RESACCESOS_'+Date.now(),users:[],password:'QaResAccesos123!'};
 const login=async(usuario,password)=>{const r=await request(app).post('/api/auth/login').send({usuario,password});assert.equal(r.status,200);return r.body.token};
 c.adminToken=await login(process.env.ADMIN_USER||'admin',process.env.ADMIN_PASSWORD);
 c.cid=(await request(app).post('/api/clientes').set(A(c.adminToken)).send({nombre:c.marca+'_cliente'})).body.id;
 c.pid=(await db.pool.query('INSERT INTO proyectos(nombre,cliente_id) VALUES($1,$2) RETURNING id',[c.marca+'_obra',c.cid])).rows[0].id;
 try { for(const [perfil,puesto] of [['tipico','residente'],['solo','residente'],['ninguno','residente'],['admin','admin'],['dev','desarrollador'],['sinobra','residente'],['compras','compras']]){
 const usuario=c.marca+'_'+perfil,r=await request(app).post('/api/usuarios').set(A(c.adminToken)).send({nombre:usuario,usuario,password:c.password,puesto});assert.equal(r.status,201);const u={id:r.body.id,usuario,password:c.password,perfil,puesto};c.users.push(u);c[perfil]=u;
 if(perfil!=='sinobra') assert.equal((await request(app).put('/api/usuarios/'+u.id+'/proyectos').set(A(c.adminToken)).send({project_ids:[c.pid]})).status,200);
 if(['solo','ninguno'].includes(perfil)){assert.equal((await request(app).put('/api/permisos/'+u.id).set(A(c.adminToken)).send({proyecto_id:null,permisos:auth.SECCIONES_PERMISOS.map(seccion=>({seccion,puede_ver:perfil==='solo'&&seccion==='avance',puede_crear:false,puede_editar:false}))})).status,200)}
 u.token=await login(usuario,c.password);
 }
 } catch(e) { await limpiar(c); throw e; }
 return c;
}
async function limpiar(c){if(!c)return;const p=(await db.pool.query('SELECT nombre FROM proyectos WHERE id=$1',[c.pid])).rows[0];assert(p?.nombre===c.marca+'_obra');const cl=(await db.pool.query('SELECT nombre FROM clientes WHERE id=$1',[c.cid])).rows[0];assert(cl?.nombre===c.marca+'_cliente');for(const u of c.users){const row=(await db.pool.query('SELECT usuario FROM usuarios WHERE id=$1',[u.id])).rows[0];assert(row?.usuario.startsWith(c.marca));assert.equal((await request(app).delete('/api/usuarios/'+u.id).set(A(c.adminToken))).status,200)}await db.pool.query('DELETE FROM proyectos WHERE id=$1 AND nombre=$2',[c.pid,c.marca+'_obra']);await db.pool.query('DELETE FROM clientes WHERE id=$1 AND nombre=$2',[c.cid,c.marca+'_cliente']);console.log('LIMPIEZA MARCADOR VERIFICADO:',c.marca,JSON.stringify((await db.pool.query('SELECT (SELECT COUNT(*) FROM usuarios WHERE usuario LIKE $1)::int AS usuarios,(SELECT COUNT(*) FROM proyectos WHERE nombre LIKE $1)::int AS proyectos,(SELECT COUNT(*) FROM clientes WHERE nombre LIKE $1)::int AS clientes',[c.marca+'%'])).rows[0]));}
module.exports={crear,limpiar,A};
