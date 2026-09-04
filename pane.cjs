const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const probe=new WebSocket("ws://localhost:8290"); let snap=null,pid=null;
  probe.on("open",()=>probe.send(JSON.stringify({t:"hello",session:"probe"})));
  probe.on("message",r=>{const m=JSON.parse(r); if(m.t==="welcome")pid=m.id; else if(m.t==="s")snap=m;});
  const t=(await get("http://localhost:9322/json")).find(x=>x.type==="page"&&x.url.includes("8290"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const shot=async f=>{const r=await cmd("Page.captureScreenshot"); if(r&&r.data) fs.writeFileSync(`${OUT}/${f}`,Buffer.from(r.data,"base64"));};
  const errs=[]; cdp.on("message",m=>{const j=JSON.parse(m); if(j.method==="Runtime.exceptionThrown") errs.push(j.params.exceptionDetails.text);});
  await cmd("Runtime.enable"); await cmd("Page.enable"); await sleep(3500);

  const hud=async()=>{const s=await ev(`document.getElementById("hud").textContent`);
    const z=parseFloat(s.match(/\(([\d.]+)x\)/)[1]);
    const [x,y]=s.split("\n")[1].split("  ")[0].split(",").map(Number); return {z,x,y}};
  const [W,H]=JSON.parse(await ev(`JSON.stringify([innerWidth,innerHeight])`));
  // one ship selected: heading ring and group ring share a centre, so the two controls
  // can be driven into each other by turning the ship
  const c=await hud();
  const A=snap.ships.filter(s=>s.owner!==null&&s.owner!==pid)[0];
  const scr=(x,y)=>[W/2+(x-c.x)*c.z, H/2+(y-c.y)*c.z];
  // point the heading at the clear icon's home bearing (-135 degrees)
  probe.send(JSON.stringify({t:"hello",session:"probe"}));
  await sleep(200);
  const sep=async()=>ev(`(()=>{
     if (pane.length < 2) return "only "+pane.length+" control";
     const a=pane[0].pos, b=pane[1].pos;
     const px=Math.hypot(a.x-b.x,a.y-b.y)*cam.zoom;
     return {gap:+px.toFixed(1), kinds:pane.map(c=>c.kind).join("+"),
             angles:pane.map(c=>+c.angle.toFixed(2))};})()`);
  console.log(`  before turning: ${JSON.stringify(await sep())}`);
  await shot("pane_before.png");
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
