// Verifica que el agente de Windows (token de estación, 365 días) puede leer
// la cola y confirmar impresiones, igual que hace el .ps1 en el local.
const API = process.env.GESTIVA_API || 'http://127.0.0.1:3100';
const req=async(p,{method='GET',body,token}={})=>{
  const r=await fetch(API+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json().catch(()=>({}))};
};
let pass=0,fail=0;
const check=(n,ok,d)=>{ok?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(d?'  → '+d:'')));};
(async()=>{
  const email=`station-${Date.now()}@t.local`;
  const reg=await req('/auth/register',{method:'POST',body:{email,password:'Secreta123',restaurantName:'Station Test'}});
  const owner=reg.data.token;
  await req('/api/waiters',{method:'POST',token:owner,body:{name:'Luis',pin:'2222'}});
  const tables=await req('/api/tables',{token:owner});
  const mesa=tables.data[0];

  console.log('\n\x1b[1mLA PC DEL LOCAL SE VINCULA (como al instalar la comandera)\x1b[0m');
  const tok=await req('/api/print-station/token',{method:'POST',token:owner});
  check('el panel entrega el token de estación',tok.status===200&&!!tok.data.token);
  check('vence recién en 365 días',tok.data.expiresInDays===365);
  const station=tok.data.token;

  console.log('\n\x1b[1mEL MOZO MANDA UN PEDIDO\x1b[0m');
  const mozo=(await req('/waiter/login',{method:'POST',body:{email,pin:'2222'}})).data.token;
  await req('/waiter/open-tables',{method:'POST',token:mozo,body:{tableId:mesa.id}});
  const t=await req('/waiter/kitchen',{method:'POST',token:mozo,
    body:{tableId:mesa.id,clientTicketId:'st-1',items:[{name:'Asado',qty:1,cat:'Comida'}]}});
  check('comanda creada',t.status===200);

  console.log('\n\x1b[1mEL AGENTE DE WINDOWS TRABAJA CON SU PROPIO TOKEN\x1b[0m');
  const cola=await req('/api/print-queue?maxAgeMin=30',{token:station});
  check('el agente lee la cola de impresión',cola.status===200&&cola.data.length===1,`status=${cola.status} n=${cola.data.length}`);
  check('recibe los datos del ticket',cola.data[0]?.items?.[0]?.name==='Asado');
  check('sabe la mesa y el mozo',cola.data[0]?.table_num!=null&&cola.data[0]?.waiter_name==='Luis',
        `mesa=${cola.data[0]?.table_num} mozo=${cola.data[0]?.waiter_name}`);

  const ack=await req('/api/print-queue/ack',{method:'POST',token:station,body:{ids:[cola.data[0].id]}});
  check('confirma la impresión con su token',ack.status===200&&ack.data.acked.length===1,`status=${ack.status}`);
  const cola2=await req('/api/print-queue',{token:station});
  check('no la vuelve a imprimir',cola2.data.length===0);

  console.log('\n\x1b[1mSI LA IMPRESORA FALLA, LA COMANDA NO SE PIERDE\x1b[0m');
  await req('/waiter/kitchen',{method:'POST',token:mozo,
    body:{tableId:mesa.id,clientTicketId:'st-2',items:[{name:'Flan',qty:2,cat:'Postres'}]}});
  // el agente la lee pero NO confirma (se trabó el papel)
  const c3=await req('/api/print-queue',{token:station});
  check('la ve en la cola',c3.data.length===1);
  const c4=await req('/api/print-queue',{token:station});
  check('sigue en la cola tras el fallo (se reintenta)',c4.data.length===1,`n=${c4.data.length}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(fail===0?`\x1b[32m\x1b[1m✅ ${pass}/${pass+fail} — la comandera funciona con su token\x1b[0m`:`\x1b[31m${fail} fallaron\x1b[0m`);
  process.exit(fail?1:0);
})();
