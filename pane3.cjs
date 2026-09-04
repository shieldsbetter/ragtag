const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=(await get("http://localhost:9324/json")).find(x=>x.type==="page"&&x.url.includes("8292"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const shot=async f=>{const r=await cmd("Page.captureScreenshot"); if(r&&r.data) fs.writeFileSync(`${OUT}/${f}`,Buffer.from(r.data,"base64"));};
  await cmd("Runtime.enable"); await cmd("Page.enable"); await sleep(3500);
  const [W,H]=JSON.parse(await ev(`JSON.stringify([innerWidth,innerHeight])`));
  const zoomOf=async()=>parseFloat((await ev(`document.getElementById("hud").textContent`)).match(/\(([\d.]+)x\)/)[1]);
  const read=async()=>{
    const z=await zoomOf();
    const p=JSON.parse(await ev(`JSON.stringify((window.__pane||[]).map(c=>({k:c.kind,a:+c.angle.toFixed(3),x:c.pos.x,y:c.pos.y})))`));
    if(p.length<2) return {z, n:p.length};
    const gap=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)*z;
    return {z, gapPx:+gap.toFixed(1), clearAngle:p.find(c=>c.k==='clear').a, rotAngle:p.find(c=>c.k==='rotate').a};
  };
  console.log(`  zoom   gap(px)  rotate angle (pinned)   dismiss angle (home -2.356)`);
  for (let i=0;i<7;i++){
    const r=await read();
    if(r.gapPx!==undefined)
      console.log(`  ${r.z.toFixed(2)}   ${String(r.gapPx).padStart(6)}   ${r.rotAngle.toFixed(3).padStart(7)}                 ${r.clearAngle.toFixed(3)}${Math.abs(r.clearAngle+2.356)>0.01?"  <- nudged":""}`);
    await cmd("Input.dispatchMouseEvent",{type:"mouseWheel",x:W/2,y:H/2,deltaX:0,deltaY:150});
    await sleep(400);
  }
  await shot("pane_zoomed.png");
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
