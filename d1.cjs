const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=(await get("http://localhost:9328/json")).find(x=>x.type==="page"&&x.url.includes("8296"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const shot=async f=>{const r=await cmd("Page.captureScreenshot"); if(r&&r.data) fs.writeFileSync(`${OUT}/${f}`,Buffer.from(r.data,"base64"));};
  await cmd("Runtime.enable"); await cmd("Page.enable"); await sleep(3500);
  const geom=async()=>JSON.parse(await ev(`(()=>{const d=document.getElementById('details').getBoundingClientRect(),
      b=document.getElementById('detailsToggle').getBoundingClientRect(),cs=getComputedStyle(document.getElementById('details'));
    return JSON.stringify({vw:innerWidth,vh:innerHeight,sel:document.body.classList.contains('has-selection'),
      open:document.body.classList.contains('details-open'),
      panel:[d.left|0,d.top|0,d.width|0,d.height|0], btn:[b.left|0,b.top|0], btnVis:cs.display!=='none',
      rows:document.querySelectorAll('#details .ship').length,
      text:document.getElementById('detailsBody').textContent.slice(0,70)});})()`));
  const paneScr=async()=>JSON.parse(await ev(`(()=>{const p=window.__pane||[];return JSON.stringify(p.map(c=>c.kind))})()`));

  console.log("WIDE 1000x760");
  let g=await geom();
  console.log(`  selection=${g.sel} open=${g.open}  panel x=${g.panel[0]} w=${g.panel[2]} h=${g.panel[3]}  toggle at ${g.btn}  rows=${g.rows}`);
  console.log(`  body: ${JSON.stringify(g.text)}`);
  await shot("d_wide_open.png");
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:g.btn[0]+23,y:g.btn[1]+23,button:"left",buttons:1,clickCount:1});
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:g.btn[0]+23,y:g.btn[1]+23,button:"left",buttons:0,clickCount:1});
  await sleep(500); g=await geom();
  console.log(`  after clicking toggle: open=${g.open}  panel x=${g.panel[0]} (offscreen if >= ${g.vw})  toggle at ${g.btn}`);
  await shot("d_wide_closed.png");
  // reopen
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:g.btn[0]+23,y:g.btn[1]+23,button:"left",buttons:1,clickCount:1});
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:g.btn[0]+23,y:g.btn[1]+23,button:"left",buttons:0,clickCount:1});
  await sleep(500);

  // does a control keep clear of the open panel?
  const hud=async()=>{const s=await ev(`document.getElementById("hud").textContent`);
    return {z:parseFloat(s.match(/\(([\d.]+)x\)/)[1]),x:+s.split("\n")[1].split("  ")[0].split(",")[0],y:+s.split("\n")[1].split("  ")[0].split(",")[1]};};
  const pane=async()=>JSON.parse(await ev(`JSON.stringify((window.__pane||[]).map(c=>({k:c.kind,a:+c.angle.toFixed(3),cx:c.cx,cy:c.cy,x:c.pos.x,y:c.pos.y})))`));
  let c=await hud(), p=await pane(); const cl0=p.find(q=>q.k==='clear');
  const W=1000,H=760;
  const shipSX=W/2+(cl0.cx-c.x)*c.z, shipSY=H/2+(cl0.cy-c.y)*c.z;
  // put the ship right beside the panel edge, so the icon's home bearing lands under it
  const tx=(W-340)+40, ty=H/2;
  const fx=W*0.25, fy=H*0.75;
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:fx,y:fy,button:"left",buttons:1,clickCount:1});
  for(let i=1;i<=14;i++){await cmd("Input.dispatchMouseEvent",{type:"mouseMoved",x:fx+((tx-shipSX))*i/14,y:fy+((ty-shipSY))*i/14,button:"left",buttons:1});await sleep(35);}
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:fx+(tx-shipSX),y:fy+(ty-shipSY),button:"left",buttons:0,clickCount:1});
  await sleep(600);
  c=await hud(); p=await pane(); const cl=p.find(q=>q.k==='clear');
  const sx=W/2+(cl.x-c.x)*c.z, sy=H/2+(cl.y-c.y)*c.z;
  console.log(`  with panel open, dismiss icon at screen x=${sx.toFixed(0)} (panel starts at 660)  bearing ${cl.a.toFixed(2)}  ${sx<660?"clear of the panel":"UNDER THE PANEL"}`);
  await shot("d_wide_occlusion.png");

  console.log("NARROW 420x820 portrait");
  await cmd("Emulation.setDeviceMetricsOverride",{width:420,height:820,deviceScaleFactor:2,mobile:true});
  await sleep(900); g=await geom();
  console.log(`  open=${g.open} (drawer starts shut)  toggle visible=${g.btnVis} at ${g.btn} of ${g.vw}x${g.vh}`);
  await shot("d_narrow_fab.png");
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:g.btn[0]+23,y:g.btn[1]+23,button:"left",buttons:1,clickCount:1});
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:g.btn[0]+23,y:g.btn[1]+23,button:"left",buttons:0,clickCount:1});
  await sleep(600); g=await geom();
  console.log(`  after tapping FAB: open=${g.open}  drawer ${JSON.stringify(g.panel)} of ${g.vw}x${g.vh}  toggle at ${g.btn}`);
  await shot("d_narrow_open.png");

  console.log("NARROW 820x420 landscape");
  await cmd("Emulation.setDeviceMetricsOverride",{width:820,height:420,deviceScaleFactor:2,mobile:true});
  await sleep(900); g=await geom();
  console.log(`  open=${g.open}  drawer ${JSON.stringify(g.panel)} of ${g.vw}x${g.vh}  toggle at ${g.btn}`);
  await shot("d_land_open.png");
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
