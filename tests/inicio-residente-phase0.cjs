'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const request=require('supertest'),{chromium,webkit}=require('playwright-core');
const app=require('../server/app'),db=require('../server/db'),auth=require('../server/auth');
const A=t=>({Authorization:'Bearer '+t});
const marca='QA_RESINICIO_'+Date.now(),users=[];let pid,cid,admin,server;
const password='QaResInicio123!';
const dir=path.resolve('.claude/inicio-residente-phase0');fs.mkdirSync(dir,{recursive:true});
async function login(usuario,password){const r=await request(app).post('/api/auth/login').send({usuario,password});assert.equal(r.status,200);return r.body.token;}
async function crear(nombre,puesto){const usuario=marca+'_'+nombre;const r=await request(app).post('/api/usuarios').set(A(admin)).send({nombre:usuario,usuario,password,puesto});assert.equal(r.status,201);const u={id:r.body.id,usuario,password,perfil:nombre};users.push(u);assert.equal((await request(app).put('/api/usuarios/'+u.id+'/proyectos').set(A(admin)).send({project_ids:[pid]})).status,200);u.token=await login(usuario,password);return u;}
async function perfilPermisos(u,secciones){const r=await request(app).put('/api/permisos/'+u.id).set(A(admin)).send({proyecto_id:null,permisos:auth.SECCIONES_PERMISOS.map(seccion=>({seccion,puede_ver:secciones.includes(seccion),puede_crear:false,puede_editar:false,puede_editar_precios:false,puede_eliminar:false}))});assert.equal(r.status,200);}
async function capturar(browser,engine,u,simular=false){
 const ctx=await browser.newContext({viewport:{width:engine==='webkit'?390:1280,height:844},serviceWorkers:'block'}),page=await ctx.newPage();const errores=[],consola=[],red=[];
 page.on('pageerror',e=>errores.push(e.message));page.on('console',m=>{if(m.type()==='error')consola.push(m.text())});page.on('response',r=>{if(r.url().includes('/api/')&&!r.url().includes('/auth/login'))red.push({path:new URL(r.url()).pathname,status:r.status()})});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.fill('#loginUsuario',u.usuario);await page.fill('#loginPassword',u.password);await page.click('#loginForm button[type=submit]');await page.waitForFunction(()=>typeof state!=='undefined'&&state.token&&state.projects?.length);
 await page.evaluate(async args=>{showApp();if(args.simular)startSimulation('residente');await selectProject(args.pid,'inicio');}, {pid,simular});await page.waitForTimeout(1200);
 const nombre=engine+'_'+u.perfil+(simular?'_simulado':'');
 const datos=await page.evaluate(()=>({html:document.querySelector('#view').innerHTML,allowedTabs:state.allowedTabs,simulado:state.simulatedPuesto,sidebar:[...document.querySelectorAll('#sidebarNav [data-sbar-goto]')].map(e=>e.dataset.sbarGoto),secciones:seccionesVisiblesParaRol().map(s=>({id:s.id,tabs:s.tabs})),displaySecciones:document.querySelector('.inicio-secciones')&&getComputedStyle(document.querySelector('.inicio-secciones')).display,resumen:state.allowedTabs.includes('resumen'),mobileVisible:!!document.querySelector('#mobileNav')&&getComputedStyle(document.querySelector('#mobileNav')).display!=='none'}));
 console.log('PERFIL '+nombre+'\n'+JSON.stringify(datos));console.log('PAGEERROR '+nombre+' '+JSON.stringify(errores));console.log('CONSOLEERROR '+nombre+' '+JSON.stringify(consola));console.log('RED '+nombre+' '+JSON.stringify(red));
 fs.writeFileSync(path.join(dir,nombre+'.json'),JSON.stringify({datos,errores,consola,red},null,2));for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);await page.waitForTimeout(400);await page.screenshot({path:path.join(dir,nombre+'_'+theme+'.png')});}
 if(u.perfil==='ninguno'||u.perfil==='solo_avance')for(const tab of datos.allowedTabs){const antes=red.length;await page.evaluate(tab=>switchToView(tab),tab);await page.waitForTimeout(1200);console.log('ABRIR MODULO '+nombre+' '+tab+' '+JSON.stringify(red.slice(antes)));}
 await ctx.close();return datos;
}
(async()=>{
 const host=new URL(process.env.DATABASE_URL).hostname;assert(host.startsWith('ep-noisy-shadow'));console.log('SHELL PowerShell; HOST Preview:',host);
 admin=await login(process.env.ADMIN_USER||'admin',process.env.ADMIN_PASSWORD);
 const cl=await request(app).post('/api/clientes').set(A(admin)).send({nombre:marca+'_cliente'});assert.equal(cl.status,201);cid=cl.body.id;
 pid=(await db.pool.query('INSERT INTO proyectos(nombre,cliente_id) VALUES($1,$2) RETURNING id',[marca+'_obra',cid])).rows[0].id;
 const tipico=await crear('tipico','residente'),solo=await crear('solo_avance','residente'),ninguno=await crear('ninguno','residente'),dev=await crear('dev','desarrollador');await perfilPermisos(solo,['avance']);await perfilPermisos(ninguno,[]);
 console.log('FIXTURES:',JSON.stringify({marca,pid,cid,usuarios:users.map(u=>({id:u.id,perfil:u.perfil}))}));
 for(const u of [tipico,solo,ninguno]){const r=await request(app).get('/api/projects/'+pid+'/nav-tabs').set(A(u.token));console.log('GET nav-tabs '+u.perfil+':',r.status,JSON.stringify(r.body));}
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]){const browser=await type.launch();try{for(const u of [tipico,solo,ninguno])await capturar(browser,engine,u);await capturar(browser,engine,{usuario:process.env.ADMIN_USER||'admin',password:process.env.ADMIN_PASSWORD,perfil:'admin'},true);await capturar(browser,engine,dev,true);}finally{await browser.close();}}
 console.log('CAPTURAS:',dir);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 if(pid){const p=(await db.pool.query('SELECT nombre FROM proyectos WHERE id=$1',[pid])).rows[0];assert(p?.nombre.startsWith(marca));for(const u of users){const row=(await db.pool.query('SELECT usuario FROM usuarios WHERE id=$1',[u.id])).rows[0];assert(row?.usuario.startsWith(marca));await request(app).delete('/api/usuarios/'+u.id).set(A(admin));}await db.pool.query('DELETE FROM proyectos WHERE id=$1 AND nombre=$2',[pid,marca+'_obra']);}
 if(cid){const c=(await db.pool.query('SELECT nombre FROM clientes WHERE id=$1',[cid])).rows[0];assert(c?.nombre===marca+'_cliente');await db.pool.query('DELETE FROM clientes WHERE id=$1 AND nombre=$2',[cid,marca+'_cliente']);}
 const count=(await db.pool.query('SELECT (SELECT COUNT(*) FROM usuarios WHERE usuario LIKE $1)::int AS usuarios,(SELECT COUNT(*) FROM proyectos WHERE nombre LIKE $1)::int AS proyectos,(SELECT COUNT(*) FROM clientes WHERE nombre LIKE $1)::int AS clientes',[marca+'%'])).rows[0];console.log('LIMPIEZA MARCADOR VERIFICADO:',marca,JSON.stringify(count));if(server)await new Promise(resolve=>server.close(resolve));await db.pool.end();
});
