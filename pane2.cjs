const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const probe=new WebSocket("ws://localhost:8291"); let snap=null,pid=null;
  probe.on("open",()=>probe.send(JSON.stringify({t:"hello",session:"probe"})));
  probe.on("message",r=>{const m=JSON.parse(r); if(m.t==="welcome")pid=m.id; else if(m.t==="s")snap=m;});
  const t=(await get("http://localhost:9323/json")).find(x=>x.type==="page"&&x.url.includes("8291"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const shot=async f=>{const r=await cmd("Page.captureScreenshot"); if(r&&r.data) fs.writeFileSync(`${OUT}/${f}`,Buffer.from(r.data,"base64"));};
  await cmd("Runtime.enable"); await cmd("Page.enable"); await sleep(3500);
  const pane=async()=>JSON.parse(await ev(`JSON.stringify((window.__pane||[]).map(c=>({
      kind:c.kind, pinned:c.pinned, angle:+c.angle.toFixed(3), x:+c.pos.x.toFixed(1), y:+c.pos.y.toFixed(1)})))`));
  const gap=async()=>ev(`(()=>{const p=window.__pane||[]; if(p.length<2) return -1;
      return +(Math.hypot(p[0].pos.x-p[1].pos.x,p[0].pos.y-p[1].pos.y)*cam.zoom).toFixed(1);})()`);
  const zoom=async()=>ev(`cam.zoom`);
  console.log(`  controls on the pane: ${JSON.stringify(await pane())}`);
  // Aim the heading at the clear icon's home bearing so they want the same spot.
  const A=(await pane()).length ? snap.ships.filter(s=>s.owner!==null&&s.owner!==pid)[0] : null;
  probe.send(JSON.stringify({t:"face", ship:A.id, a:-Math.PI*0.75}));
  await sleep(1500);
  console.log(`  after aiming the heading at the dismiss icon's home bearing:`);
  console.log(`    ${JSON.stringify(await pane())}`);
  console.log(`    screen gap between the two: ${await gap()}px  (need > ${18+18+12})`);
  await shot("pane_collide.png");
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
