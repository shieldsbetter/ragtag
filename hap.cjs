const WebSocket=require("ws"), http=require("http");
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const probe=new WebSocket("ws://localhost:8252"); let snap=null,pid=null;
  probe.on("open",()=>probe.send(JSON.stringify({t:"hello",session:"probe"})));
  probe.on("message",r=>{const m=JSON.parse(r); if(m.t==="welcome")pid=m.id; else if(m.t==="s")snap=m;});
  const t=(await get("http://localhost:9302/json")).find(x=>x.type==="page"&&x.url.includes("8252"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m); if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  await cmd("Runtime.enable"); await sleep(3200);
  // record every vibrate call, since headless chrome has no vibrator to observe
  await ev(`(()=>{window.__buzz=[];
    navigator.vibrate = p => { window.__buzz.push(JSON.stringify(p)); return true; };})()`);
  const hud=async()=>{const s=await ev(`document.getElementById("hud").textContent`);
    const z=parseFloat(s.match(/\(([\d.]+)x\)/)[1]);
    const [x,y]=s.split("\n")[1].split("  ")[0].split(",").map(Number); return {z,x,y}};
  const [W,H]=JSON.parse(await ev(`JSON.stringify([innerWidth,innerHeight])`));
  for(let i=0;i<5;i++){await cmd("Input.dispatchMouseEvent",{type:"mouseWheel",x:W/2,y:H/2,deltaX:0,deltaY:300});await sleep(140);}
  await sleep(700);
  const c=await hud();
  const mine=snap.ships.filter(s=>s.owner!==null&&s.owner!==pid);
  const scr=s=>[W/2+(s.x-c.x)*c.z, H/2+(s.y-c.y)*c.z];
  const press=async([x,y],ms)=>{
    await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
    await sleep(ms);
    await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
  };
  const [A,B]=mine;
  await press(scr(A),60); await sleep(300);
  console.log(`  after a plain tap:            ${await ev(`JSON.stringify(window.__buzz)`)}`);
  await press(scr(B),700); await sleep(400);
  console.log(`  after long-press to add:      ${await ev(`JSON.stringify(window.__buzz)`)}`);
  await press(scr(B),700); await sleep(400);
  console.log(`  after long-press to remove:   ${await ev(`JSON.stringify(window.__buzz)`)}`);
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
