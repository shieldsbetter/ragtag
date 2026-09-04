const WebSocket=require("ws"), http=require("http");
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const probe=new WebSocket("ws://localhost:8284"); let snap=null,pid=null;
  probe.on("open",()=>probe.send(JSON.stringify({t:"hello",session:"probe"})));
  probe.on("message",r=>{const m=JSON.parse(r); if(m.t==="welcome")pid=m.id; else if(m.t==="s")snap=m;});
  const t=(await get("http://localhost:9316/json")).find(x=>x.type==="page"&&x.url.includes("8284"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  await cmd("Runtime.enable"); await sleep(3200);
  // the hold arc is the only partial arc drawn at HOLD_R; record every arc's sweep
  await ev(`(()=>{const P=CanvasRenderingContext2D.prototype, a0=P.arc;
    window.__sweeps=[];
    P.arc=function(x,y,r,s,e,...rest){ window.__sweeps.push(+(Math.abs(e-s)).toFixed(3));
      return a0.call(this,x,y,r,s,e,...rest); };})()`);
  const hud=async()=>{const s=await ev(`document.getElementById("hud").textContent`);
    const z=parseFloat(s.match(/\(([\d.]+)x\)/)[1]);
    const [x,y]=s.split("\n")[1].split("  ")[0].split(",").map(Number); return {z,x,y}};
  const [W,H]=JSON.parse(await ev(`JSON.stringify([innerWidth,innerHeight])`));
  const c=await hud();
  const A=snap.ships.filter(s=>s.owner!==null&&s.owner!==pid)[0];
  const sx=W/2+(A.x-c.x)*c.z, sy=H/2+(A.y-c.y)*c.z;
  // a partial arc (sweep strictly between 0 and 2pi) that is not the rotate handle
  const partials=async()=>ev(`(()=>{const s=window.__sweeps; window.__sweeps=[];
    return s.filter(v=>v>0.02 && v<6.0 && Math.abs(v-5.583)>0.01).length;})()`);
  await partials();
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:sx,y:sy,button:"left",buttons:1,clickCount:1});
  await sleep(100); const p100=await partials();
  await sleep(120); const p220=await partials();
  await sleep(180); const p400=await partials();
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:sx,y:sy,button:"left",buttons:0,clickCount:1});
  await sleep(500); await partials();
  // a quick tap, the case this change is for
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:sx,y:sy,button:"left",buttons:1,clickCount:1});
  await sleep(80);
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:sx,y:sy,button:"left",buttons:0,clickCount:1});
  const tap=await partials();
  console.log(`  partial arcs drawn during a hold:`);
  console.log(`    first 100ms : ${p100}   ${p100===0?"nothing (tap territory)":"DREW"}`);
  console.log(`    100-220ms   : ${p220}   ${p220>0?"sweeping":"nothing"}`);
  console.log(`    220-400ms   : ${p400}   ${p400>0?"sweeping":"nothing"}`);
  console.log(`  partial arcs drawn during an 80ms tap: ${tap}  ${tap===0?"clean":"CLUTTER"}`);
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
