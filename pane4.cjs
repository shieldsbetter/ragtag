const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=(await get("http://localhost:9325/json")).find(x=>x.type==="page"&&x.url.includes("8293"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const shot=async f=>{const r=await cmd("Page.captureScreenshot"); if(r&&r.data) fs.writeFileSync(`${OUT}/${f}`,Buffer.from(r.data,"base64"));};
  await cmd("Runtime.enable"); await cmd("Page.enable"); await sleep(3500);
  const [W,H]=JSON.parse(await ev(`JSON.stringify([innerWidth,innerHeight])`));
  const hud=async()=>{const s=await ev(`document.getElementById("hud").textContent`);
    return {z:parseFloat(s.match(/\(([\d.]+)x\)/)[1]),
            x:+s.split("\n")[1].split("  ")[0].split(",")[0], y:+s.split("\n")[1].split("  ")[0].split(",")[1]};};
  const pane=async()=>JSON.parse(await ev(`JSON.stringify((window.__pane||[]).map(c=>({
      k:c.kind, pinned:c.pinned, a:+c.angle.toFixed(3), cx:c.cx, cy:c.cy, track:c.track, x:c.pos.x, y:c.pos.y})))`));
  const report=async label=>{
    const c=await hud(), p=await pane();
    if(p.length<2){console.log(`  ${label}: only ${p.length} control`); return;}
    const gap=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)*c.z;
    const cl=p.find(q=>q.k==='clear'), ro=p.find(q=>q.k==='rotate');
    console.log(`  ${label}: rotate@${ro.a.toFixed(2)}  dismiss@${cl.a.toFixed(2)} (home -2.36)  gap ${gap.toFixed(0)}px${Math.abs(cl.a+2.356)>0.01?"   NUDGED":""}`);
  };
  await report("start");
  // drag the heading handle round to where the dismiss icon lives
  let c=await hud(); let p=await pane();
  const ro=p.find(q=>q.k==='rotate');
  const scr=(x,y)=>[W/2+(x-c.x)*c.z, H/2+(y-c.y)*c.z];
  const from=scr(ro.x,ro.y);
  const target=-Math.PI*0.75;
  const to=scr(ro.cx+Math.cos(target)*ro.track, ro.cy+Math.sin(target)*ro.track);
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:from[0],y:from[1],button:"left",buttons:1,clickCount:1});
  for(let i=1;i<=12;i++){
    await cmd("Input.dispatchMouseEvent",{type:"mouseMoved",
      x:from[0]+(to[0]-from[0])*i/12, y:from[1]+(to[1]-from[1])*i/12, button:"left",buttons:1});
    await sleep(45);
  }
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:to[0],y:to[1],button:"left",buttons:0,clickCount:1});
  await sleep(900);
  await report("after dragging the heading onto the dismiss icon");
  await shot("pane_nudged.png");
  // and both must still be pressable where they are drawn
  c=await hud(); p=await pane();
  const cl=p.find(q=>q.k==='clear');
  const cs=scr(cl.x,cl.y);
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:cs[0],y:cs[1],button:"left",buttons:1,clickCount:1});
  await sleep(60);
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:cs[0],y:cs[1],button:"left",buttons:0,clickCount:1});
  await sleep(600);
  const after=await pane();
  console.log(`  tapping the dismiss icon where it was drawn: ${after.length===0?"cleared the selection":"still "+after.length+" controls"}`);
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
