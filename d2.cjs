const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=(await get("http://localhost:9329/json")).find(x=>x.type==="page"&&x.url.includes("8297"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const shot=async f=>{const r=await cmd("Page.captureScreenshot"); if(r&&r.data) fs.writeFileSync(`${OUT}/${f}`,Buffer.from(r.data,"base64"));};
  await cmd("Runtime.enable"); await cmd("Page.enable"); await sleep(3500);
  const geom=async()=>JSON.parse(await ev(`(()=>{const d=document.getElementById('details').getBoundingClientRect(),
      b=document.getElementById('detailsToggle').getBoundingClientRect();
    return JSON.stringify({vw:innerWidth,vh:innerHeight,open:document.body.classList.contains('details-open'),
      panel:[d.left|0,d.top|0,d.width|0,d.height|0], btn:[b.left|0,b.top|0],
      free:window.__free, rows:document.querySelectorAll('#details .ship').length});})()`));
  const tapBtn=async g=>{
    for(const type of ["mousePressed","mouseReleased"])
      await cmd("Input.dispatchMouseEvent",{type,x:g.btn[0]+23,y:g.btn[1]+23,button:"left",buttons:type==="mousePressed"?1:0,clickCount:1});
    await sleep(600);
  };
  const line=(name,g)=>console.log(`  ${name}: viewport ${g.vw}x${g.vh}  open=${g.open}  panel [x${g.panel[0]} y${g.panel[1]} ${g.panel[2]}x${g.panel[3]}]  toggle ${g.btn}  free x${g.free.x0}-${g.free.x1.toFixed(0)} y${g.free.y0}-${g.free.y1.toFixed(0)}`);

  console.log("wide (desktop) -- opens by default beside the game");
  let g=await geom(); line("open", g); await shot("d2_wide_open.png");
  await tapBtn(g); g=await geom(); line("collapsed", g); await shot("d2_wide_closed.png");
  await tapBtn(g);

  console.log("phone, upright -- drawer over the bottom half, shut until the FAB is tapped");
  await cmd("Emulation.setDeviceMetricsOverride",{width:420,height:820,deviceScaleFactor:2,mobile:true});
  await sleep(1000); g=await geom(); line("shut", g); await shot("d2_portrait_fab.png");
  await tapBtn(g); g=await geom(); line("open", g); await shot("d2_portrait_open.png");

  console.log("phone, sideways -- right half instead");
  await cmd("Emulation.setDeviceMetricsOverride",{width:820,height:420,deviceScaleFactor:2,mobile:true});
  await sleep(1000); g=await geom(); line("open", g); await shot("d2_landscape_open.png");
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
