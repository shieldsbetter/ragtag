const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=(await get("http://localhost:9327/json")).find(x=>x.type==="page"&&x.url.includes("8295"));
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
  const drag=async(fx,fy,tx,ty,n=10)=>{
    await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:fx,y:fy,button:"left",buttons:1,clickCount:1});
    for(let i=1;i<=n;i++){await cmd("Input.dispatchMouseEvent",{type:"mouseMoved",x:fx+(tx-fx)*i/n,y:fy+(ty-fy)*i/n,button:"left",buttons:1});await sleep(35);}
    await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:tx,y:ty,button:"left",buttons:0,clickCount:1});
    await sleep(400);
  };
  const show=async label=>{
    const c=await hud(), p=await pane();
    const cl=p.find(q=>q.k==='clear'); if(!cl){console.log(`  ${label}: no dismiss control`);return null;}
    const sx=W/2+(cl.x-c.x)*c.z, sy=H/2+(cl.y-c.y)*c.z;
    const on = sx>0&&sy>0&&sx<W&&sy<H;
    console.log(`  ${label}: dismiss at screen ${sx.toFixed(0)},${sy.toFixed(0)}  bearing ${cl.a.toFixed(2)} (home -2.36)  ${on?"on screen":"OFF SCREEN"}`);
    return {c,cl,sx,sy,on};
  };
  await show("before panning");
  // shove the map so the ship sits in the top-left corner; the icon's home bearing
  // (up and to the left) then wants to be off the edge
  const st=await hud(); let p=await pane(); const cl0=p.find(q=>q.k==='clear');
  const shipSX=W/2+(cl0.cx-st.x)*st.z, shipSY=H/2+(cl0.cy-st.y)*st.z;
  await drag(W*0.75, H*0.75, W*0.75+(60-shipSX), H*0.75+(60-shipSY), 14);
  const after=await show("after panning ship into the corner");
  await shot("pane_edge.png");
  if(after && after.on){
    await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:after.sx,y:after.sy,button:"left",buttons:1,clickCount:1});
    await sleep(60);
    await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:after.sx,y:after.sy,button:"left",buttons:0,clickCount:1});
    await sleep(600);
    console.log(`  tapping it there: ${(await pane()).length===0?"cleared the selection":"did not clear"}`);
  }
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
