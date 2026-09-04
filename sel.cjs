const WebSocket=require("ws"), http=require("http");
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const probe=new WebSocket("ws://localhost:8250"); let snap=null,pid=null;
  probe.on("open",()=>probe.send(JSON.stringify({t:"hello",session:"probe"})));
  probe.on("message",r=>{const m=JSON.parse(r); if(m.t==="welcome")pid=m.id; else if(m.t==="s")snap=m;});
  const t=(await get("http://localhost:9301/json")).find(x=>x.type==="page"&&x.url.includes("8250"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  await cmd("Runtime.enable"); await sleep(3200);
  const hud=async()=>{const s=await ev(`document.getElementById("hud").textContent`);
    const z=parseFloat(s.match(/\(([\d.]+)x\)/)[1]);
    const [x,y]=s.split("\n")[1].split("  ")[0].split(",").map(Number); return {z,x,y}};
  const [W,H]=JSON.parse(await ev(`JSON.stringify([innerWidth,innerHeight])`));
  for(let i=0;i<5;i++){await cmd("Input.dispatchMouseEvent",{type:"mouseWheel",x:W/2,y:H/2,deltaX:0,deltaY:300});await sleep(140);}
  await sleep(700);
  let c=await hud();
  const mine=snap.ships.filter(s=>s.owner!==null&&s.owner!==pid);
  const scr=s=>[W/2+(s.x-c.x)*c.z, H/2+(s.y-c.y)*c.z];
  const [A,B]=mine;
  const press=async([x,y],ms)=>{
    await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
    await sleep(ms);
    await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
  };
  console.log(`  fleet: ${A.id}, ${B.id}`);
  await press(scr(A), 60); await sleep(400);        // tap A -> selection = {A}
  await press(scr(B), 700); await sleep(500);       // long-press B -> add B, designate B
  const posA=snap.ships.find(s=>s.id===A.id), posB=snap.ships.find(s=>s.id===B.id);
  const cx=(posA.x+posB.x)/2, cy=(posA.y+posB.y)/2;
  c=await hud();
  const target={x:c.x+600,y:c.y+600};
  const [tx,ty]=[W/2+(target.x-c.x)*c.z, H/2+(target.y-c.y)*c.z];
  await press([tx,ty], 60); await sleep(900);
  const a2=snap.ships.find(s=>s.id===A.id), b2=snap.ships.find(s=>s.id===B.id);
  console.log(`  after tap in space:`);
  console.log(`    ship ${A.id} ordered: ${a2.dx!==undefined}  ship ${B.id} ordered: ${b2.dx!==undefined}  (want both)`);
  if(a2.dx!==undefined&&b2.dx!==undefined){
    const offA=[a2.dx-target.x, a2.dy-target.y], offB=[b2.dx-target.x, b2.dy-target.y];
    console.log(`    offset from tap: ${A.id} (${offA[0].toFixed(0)},${offA[1].toFixed(0)})  vs its offset from group centre (${(posA.x-cx).toFixed(0)},${(posA.y-cy).toFixed(0)})`);
    console.log(`    offset from tap: ${B.id} (${offB[0].toFixed(0)},${offB[1].toFixed(0)})  vs its offset from group centre (${(posB.x-cx).toFixed(0)},${(posB.y-cy).toFixed(0)})`);
    const sep0=Math.hypot(posA.x-posB.x,posA.y-posB.y), sep1=Math.hypot(a2.dx-b2.dx,a2.dy-b2.dy);
    console.log(`    formation kept: separation ${sep0.toFixed(0)} -> destinations ${sep1.toFixed(0)}`);
  }
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
