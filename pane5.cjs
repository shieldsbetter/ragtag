const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=(await get("http://localhost:9326/json")).find(x=>x.type==="page"&&x.url.includes("8294"));
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
      k:c.kind, a:+c.angle.toFixed(3), cx:c.cx, cy:c.cy, track:c.track, x:c.pos.x, y:c.pos.y})))`));
  // zoom until the two rings are the same size on screen
  for(let i=0;i<3;i++){ await cmd("Input.dispatchMouseEvent",{type:"mouseWheel",x:W/2,y:H/2,deltaX:0,deltaY:150}); await sleep(350); }
  await sleep(600);
  let c=await hud(), p=await pane();
  const ro=p.find(q=>q.k==='rotate'), cl=p.find(q=>q.k==='clear');
  console.log(`  zoom ${c.z.toFixed(2)}: heading ring ${(ro.track*c.z).toFixed(0)}px, group ring ${(cl.track*c.z).toFixed(0)}px on screen`);
  const scr=(x,y)=>[W/2+(x-c.x)*c.z, H/2+(y-c.y)*c.z];
  const from=scr(ro.x,ro.y);
  const target=-Math.PI*0.75;
  const to=scr(ro.cx+Math.cos(target)*ro.track, ro.cy+Math.sin(target)*ro.track);
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:from[0],y:from[1],button:"left",buttons:1,clickCount:1});
  for(let i=1;i<=14;i++){
    await cmd("Input.dispatchMouseEvent",{type:"mouseMoved",
      x:from[0]+(to[0]-from[0])*i/14, y:from[1]+(to[1]-from[1])*i/14, button:"left",buttons:1});
    await sleep(45);
  }
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:to[0],y:to[1],button:"left",buttons:0,clickCount:1});
  await sleep(900);
  c=await hud(); p=await pane();
  const ro2=p.find(q=>q.k==='rotate'), cl2=p.find(q=>q.k==='clear');
  const gap=Math.hypot(ro2.x-cl2.x,ro2.y-cl2.y)*c.z;
  console.log(`  heading dragged to ${ro2.a.toFixed(2)} (pinned, = the real heading)`);
  console.log(`  dismiss sits at ${cl2.a.toFixed(2)}, home is -2.36  ${Math.abs(cl2.a+2.356)>0.01?"-> NUDGED clear of it":"-> unmoved"}`);
  console.log(`  gap between them: ${gap.toFixed(0)}px  (threshold ${18+18+12})`);
  await shot("pane_final.png");
  // both still hit where drawn
  const cs=scr(cl2.x,cl2.y);
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:cs[0],y:cs[1],button:"left",buttons:1,clickCount:1});
  await sleep(60);
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:cs[0],y:cs[1],button:"left",buttons:0,clickCount:1});
  await sleep(600);
  console.log(`  tapping the dismiss icon at its nudged position: ${(await pane()).length===0?"cleared the selection":"did not clear"}`);
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
