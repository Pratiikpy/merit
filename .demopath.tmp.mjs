import { chromium } from "playwright";
const B="https://www.onmerit.xyz";
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1440,height:900}});
const p=await c.newPage();
const say=(s,m)=>console.log(`${s}  ${m}`);

// 1. hero verifier — the hero moment (numeric gate, no LLM)
await p.goto(B+"/",{waitUntil:"domcontentloaded"}); await p.waitForTimeout(3000);
await p.evaluate(()=>{document.querySelector('#hv-ex-fab').click();document.querySelector('#hv-go').click();});
let out="";
for(let i=0;i<40;i++){out=await p.evaluate(()=>(document.querySelector('#hv-result')?.innerText||'').trim());if(out)break;await p.waitForTimeout(700);}
say(out.includes("REFUSED")?"[PASS]":"[FAIL]", `hero refusal: ${out.split("\n")[0]||"(nothing)"}`);

// 2. hero verifier — true claim (needs NLI)
await p.evaluate(()=>{document.querySelector('#hv-ex-true').click();document.querySelector('#hv-go').click();});
out="";
for(let i=0;i<40;i++){const t=await p.evaluate(()=>(document.querySelector('#hv-result')?.innerText||'').trim());if(t&&t!==out){out=t;if(/SUPPORTED|REFUSED|unavailable/i.test(t))break;}await p.waitForTimeout(700);}
say(/SUPPORTED/i.test(out)?"[PASS]":"[WARN]", `hero supported: ${out.split("\n")[0]||"(nothing)"}`);

// 3. Verified Inference — LLM dependent. What does a judge SEE when it fails?
await p.goto(B+"/inference.html",{waitUntil:"domcontentloaded"}); await p.waitForTimeout(3000);
await p.evaluate(()=>{const t=document.getElementById('at-prompt');if(t){t.value='Say the word ok.';t.dispatchEvent(new Event('input',{bubbles:true}));}});
const runBtn=await p.$('#at-run, button.btn');
if(runBtn){ await runBtn.click(); }
let inf="";
for(let i=0;i<30;i++){inf=await p.evaluate(()=>{const e=document.querySelector('.err');return e?e.innerText.trim():'';});if(inf)break;await p.waitForTimeout(700);}
say(inf?"[INFO]":"[INFO]", `inference on failure shows: "${inf.slice(0,150)||"(no error element yet)"}"`);

await b.close();
