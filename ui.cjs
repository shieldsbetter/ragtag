const WebSocket=require("ws"), http=require("http"), fs=require("fs");
const OUT=process.argv[2];
const get=u=>new Promise((res,rej)=>http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)))}).on("error",rej));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const t=(await get("http://localhost:9332/json")).find(x=>x.type==="page"&&x.url.includes("8304"));
  const cdp=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>cdp.on("open",r));
  let id=0; const pend=new Map();
  cdp.on("message",m=>{const j=JSON.parse(m);if(pend.has(j.id)){pend.get(j.id)(j.result);pend.delete(j.id)}});
  const cmd=(me,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);cdp.send(JSON.stringify({id:i,method:me,params:p}))});
  const ev=async e=>(await cmd("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const shot=async f=>{const r=await cmd("Page.captureScreenshot");if(r&&r.data)fs.writeFileSync(`${OUT}/${f}`,Buffer.from(r.data,"base64"));};
  const click=async(x,y,mod)=>{for(const type of ["mousePressed","mouseReleased"])
    await cmd("Input.dispatchMouseEvent",{type,x,y,button:"left",buttons:type==="mousePressed"?1:0,clickCount:1,modifiers:mod||0});};
  const tapToggle=async()=>{const b=JSON.parse(await ev(`(()=>{const r=document.getElementById('detailsToggle').getBoundingClientRect();return JSON.stringify([r.left+23|0,r.top+23|0])})()`));await click(b[0],b[1]);await sleep(500);};
  await cmd("Runtime.enable"); await cmd("Page.enable"); await sleep(3500);

  await tapToggle();                                   // get the panel out of the way
  const spot=JSON.parse(await ev(`(()=>{const c=window.__cam,f=window.__fleet,s=f[1];
    return JSON.stringify([Math.round(innerWidth/2+(s.x-c.x)*c.zoom), Math.round(innerHeight/2+(s.y-c.y)*c.zoom), f.map(q=>q.id)])})()`));
  console.log(`  fleet ${JSON.stringify(spot[2])}; shift-clicking the second at ${spot[0]},${spot[1]}`);
  await click(spot[0], spot[1], 8);
  await sleep(700);
  await tapToggle();                                   // and back

  const state=async()=>JSON.parse(await ev(`JSON.stringify({
    rows:[...document.querySelectorAll('#details .shiphead')].map(h=>h.textContent.replace(/\\s+/g,' ').trim()),
    open:[...document.querySelectorAll('#details .shiphead.open')].map(h=>(h.textContent.match(/ship \\d+/)||[''])[0]),
    envs:[...document.querySelectorAll('#details .env .envhead')].map(e=>e.textContent),
    stops:document.querySelectorAll('#details .env .stop').length })`));
  let s=await state();
  s.rows.forEach(r=>console.log(`    row  ${r}`));
  console.log(`  expanded ${JSON.stringify(s.open)}   editors ${JSON.stringify(s.envs)}   handles ${s.stops}`);
  await shot("p_accordion.png");
  if(s.rows.length<2){console.log("  (only one row -- selection did not grow)");process.exit(1);}

  const box=async n=>JSON.parse(await ev(`(()=>{const h=document.querySelectorAll('#details .shiphead')[${n}].getBoundingClientRect();return JSON.stringify([h.left+h.width/2|0,h.top+h.height/2|0])})()`));
  const b1=await box(1); await click(b1[0],b1[1]); await sleep(500);
  s=await state();
  console.log(`  tapped the second row -> expanded ${JSON.stringify(s.open)}   (exactly one open: ${s.open.length===1})`);
  await shot("p_accordion2.png");

  const svg=JSON.parse(await ev(`(()=>{const s=document.querySelector('#details .env svg').getBoundingClientRect();return JSON.stringify([s.left,s.top,s.width,s.height])})()`));
  const hx=svg[0]+svg[2]*(9/240), hy=svg[1]+svg[3]*0.2;
  await cmd("Input.dispatchMouseEvent",{type:"mousePressed",x:hx,y:hy,button:"left",buttons:1,clickCount:1});
  for(let i=1;i<=8;i++){await cmd("Input.dispatchMouseEvent",{type:"mouseMoved",x:hx,y:hy+(svg[1]+svg[3]-hy)*i/8,button:"left",buttons:1});await sleep(45);}
  await cmd("Input.dispatchMouseEvent",{type:"mouseReleased",x:hx,y:svg[1]+svg[3],button:"left",buttons:0,clickCount:1});
  await sleep(1200);
  const openId=await ev(`(()=>{const h=document.querySelector('#details .shiphead.open');return h?h.textContent.match(/ship (\\d+)/)[1]:null})()`);
  console.log(`  dragged the closest-range stop of the first editor to the floor (ship ${openId}):`);
  console.log(`    editor shows      ${await ev(`document.querySelector('#details .env .envhead b').textContent`)}`);
  console.log(`    flagged "do not engage": ${await ev(`document.querySelectorAll('#details .env .stop.off').length`)} handle(s)`);
  console.log(`    server echoes     ${await ev(`(()=>{const s=window.__fleet.find(s=>s.id==${openId});return s&&s.pr?JSON.stringify(s.pr):'none'})()`)}`);
  console.log(`    other ship's      ${await ev(`(()=>{const s=window.__fleet.find(s=>s.id!=${openId});return s&&s.pr?JSON.stringify(s.pr.rock):'none'})()`)}  (untouched)`);
  await shot("p_dragged.png");
  process.exit(0);
})().catch(e=>{console.log("FAIL "+e.message.split("\n")[0]);process.exit(1)});
