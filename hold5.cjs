const WebSocket=require("ws"), http=require("http");
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const probe=new WebSocket("ws://localhost:8287"); let snap=null,pid=null;
  probe.on("open",()=>probe.send(JSON.stringify({t:"hello",session:"probe"})));
  probe.on("message",r=>{const m=JSON.parse(r); if(m.t==="welcome")pid=m.id; else if(m.t==="s")snap=m;});
  const t=(await get("http://localhost:9319/json")).find(x=>x.type==="page"&&x.url.includes("8287"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  await cmd("Runtime.enable"); await sleep(3200);
  // Only the hold arc lives at 62 world units when zoom is 1; traverse arcs are at 40
  // and the rotate handle at 7.
  await ev(`(()=>{
    const A=Path2D.prototype.arc;
    window.__firstHold=null; window.__pressAt=null; window.__radii=new Set();
    Path2D.prototype.arc=function(x,y,r,s,e,...rest){
      window.__radii.add(Math.round(r));
      if (window.__pressAt && window.__firstHold===null && r>55 && r<70)
        window.__firstHold=performance.now()-window.__pressAt;
      return A.call(this,x,y,r,s,e,...rest); };
    addEventListener('pointerdown',()=>{window.__pressAt=performance.now(); window.__firstHold=null;},true);
  })()`);
  const hud=async()=>{const s=await ev(`document.getElementById("hud").textContent`);
    const z=parseFloat(s.match(/\(([\d.]+)x\)/)[1]);
    const [x,y]=s.split("\n")[1].split("  ")[0].split(",").map(Number); return {z,x,y}};
  const [W,H]=JSON.parse(await ev(`JSON.stringify([innerWidth,innerHeight])`));
  const c=await hud();
  console.log(`  zoom ${c.z}; arc radii drawn each frame: ${await ev(`JSON.stringify([...window.__radii].sort((a,b)=>a-b))`)}`);
  const A=snap.ships.filter(s=>s.owner!==null&&s.owner!==pid)[0];
  const sx=W/2+(A.x-c.x)*c.z, sy=H/2+(A.y-c.y)*c.z;
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:sx,y:sy,button:"left",buttons:1,clickCount:1});
  await sleep(700);
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:sx,y:sy,button:"left",buttons:0,clickCount:1});
  const held=await ev(`window.__firstHold`);
  await sleep(700);
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:sx,y:sy,button:"left",buttons:1,clickCount:1});
  await sleep(90);
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:sx,y:sy,button:"left",buttons:0,clickCount:1});
  await sleep(250);
  const tapped=await ev(`window.__firstHold`);
  console.log(`  long press : arc first drawn ${held===null?"never":held.toFixed(0)+"ms"} in   (HOLD_DELAY=150)`);
  console.log(`  90ms tap   : arc drawn ${tapped===null?"never - no clutter":"after "+tapped.toFixed(0)+"ms"}`);
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
