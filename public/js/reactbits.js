/**
 * reactbits.js — React Bits 组件库的内置移植版
 *
 * React Bits（reactbits.dev）是一套"复制即用"的动态 React 组件：
 * Text Animations / Animations / Components / Backgrounds / Micro Interactions
 * 四个大类，每个组件有 JS-CSS、JS-TW、TS-CSS、TS-TW 四种口味，
 * 官方还提供 llms.txt 索引和 shadcn 的 MCP 安装通道。
 *
 * 画布里跑的是 HTML 片段，不是 React 工程，所以这里做的是等价移植：
 * 把每个组件翻译成不依赖任何库的原生 HTML + CSS + JS，
 * 保持原来的动画节奏、交互方式和视觉特征，直接能塞进 html 元素或当背景。
 *
 * 用法：
 *   import { RB_COMPONENTS, rbSearch, rbGet, rbIndexText } from './reactbits.js';
 *   rbSearch('发光文字')  → 命中的组件数组
 *   rbGet('shiny-text')   → 单个组件的完整实现
 *   rbIndexText()         → 一份 llms.txt 风格的目录，拼进系统提示用
 */

/* 组件按 React Bits 的原分类归档。keywords 同时收录中英文叫法，
   用户说"发光字""跑马灯""光斑背景"都能命中。 */
export const RB_COMPONENTS = [
  /* ── Text Animations ─────────────────────────────── */
  {
    id: 'split-text',
    name: 'SplitText 逐字入场',
    category: 'Text Animations',
    desc: '标题按字符拆开，依次上浮淡入，常用于首屏大标题',
    keywords: ['逐字', '拆字', '文字入场', '标题动画', 'splittext', 'split text', '打字', '字一个个'],
    html: '<div class="rb-split" data-text="把每个字拆开再落下来"></div>',
    css: `.rb-split{display:flex;flex-wrap:wrap;gap:.02em;font:800 clamp(28px,7vw,72px)/1.15 system-ui,-apple-system,"PingFang SC",sans-serif;color:#f4f4f7;letter-spacing:-.02em}
.rb-split span{display:inline-block;transform:translateY(.45em);opacity:0;animation:rbSplit .72s cubic-bezier(.22,.61,.36,1) forwards}
@keyframes rbSplit{to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.rb-split span{animation:none;opacity:1;transform:none}}`,
    js: `const box=document.querySelector('.rb-split');
const text=box.dataset.text||box.textContent;
box.textContent='';
[...text].forEach((ch,i)=>{
  const s=document.createElement('span');
  s.textContent=ch===' '?'\\u00a0':ch;
  s.style.animationDelay=(i*46)+'ms';
  box.appendChild(s);
});`,
  },
  {
    id: 'shiny-text',
    name: 'ShinyText 流光文字',
    category: 'Text Animations',
    desc: '文字上有一道高光反复扫过，适合强调短语、按钮文案',
    keywords: ['流光', '扫光', '高光文字', 'shinytext', 'shiny', '发亮', '发光', '发光文字', '闪光字', '金属光', '文字效果'],
    html: '<span class="rb-shiny">限时 · 现在就开始</span>',
    css: `.rb-shiny{
  font:700 clamp(20px,3.4vw,40px)/1.3 system-ui,-apple-system,"PingFang SC",sans-serif;
  background:linear-gradient(100deg,#6b6b76 20%,#ffffff 42%,#ffffff 52%,#6b6b76 74%);
  background-size:220% 100%;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  animation:rbShine 3.4s linear infinite;
}
@keyframes rbShine{0%{background-position:180% 0}100%{background-position:-60% 0}}
@media (prefers-reduced-motion:reduce){.rb-shiny{animation:none;background-position:50% 0}}`,
    js: '',
  },
  {
    id: 'gradient-text',
    name: 'GradientText 渐变文字',
    category: 'Text Animations',
    desc: '文字填一段流动的多色渐变，几乎不抢注意力但很有质感',
    keywords: ['渐变文字', '彩色字', 'gradienttext', 'gradient text', '彩虹字', '彩色标题'],
    html: '<span class="rb-grad">Flow with the gradient</span>',
    css: `.rb-grad{
  font:800 clamp(22px,4vw,52px)/1.2 system-ui,-apple-system,"PingFang SC",sans-serif;
  background:linear-gradient(90deg,#a78bfa,#22d3ee,#f472b6,#a78bfa);
  background-size:300% 100%;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  animation:rbGrad 6s linear infinite;
}
@keyframes rbGrad{to{background-position:300% 0}}
@media (prefers-reduced-motion:reduce){.rb-grad{animation:none}}`,
    js: '',
  },
  {
    id: 'decrypted-text',
    name: 'DecryptedText 解码文字',
    category: 'Text Animations',
    desc: '字符先乱码再逐个定住，有科技感的揭示效果',
    keywords: ['解码', '乱码', '黑客字', 'decryptedtext', 'decrypt', '解密', '字符跳动'],
    html: '<div class="rb-decrypt" data-text="SYSTEM ONLINE"></div>',
    css: `.rb-decrypt{font:700 clamp(20px,3.6vw,44px)/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b8f65a;letter-spacing:.06em}`,
    js: `const el=document.querySelector('.rb-decrypt');
const final=el.dataset.text||el.textContent||'';
const pool='!<>-_\\\\/[]{}=+*^?#________';
let frame=0;
function tick(){
  let out='';
  for(let i=0;i<final.length;i++){
    const ch=final[i];
    out += (i < frame/2) ? ch : (ch===' '?' ':pool[Math.floor(Math.random()*pool.length)]);
  }
  el.textContent=out;
  frame++;
  if(frame/2 < final.length) requestAnimationFrame(()=>setTimeout(tick,32));
  else el.textContent=final;
}
el.textContent=final.replace(/\\S/g,'·'.repeat(1));
tick();`,
  },
  {
    id: 'count-up',
    name: 'CountUp 数字滚动',
    category: 'Text Animations',
    desc: '数字从 0 滚到目标值，进入视野时触发，适合数据面板',
    keywords: ['数字滚动', 'countup', 'count up', '数值动画', '计数器', '数据滚动'],
    html: '<div class="rb-count" data-to="18420" data-suffix="+"></div>',
    css: `.rb-count{font:800 clamp(28px,5vw,64px)/1 system-ui,-apple-system,"PingFang SC",sans-serif;color:#f4f4f7;font-variant-numeric:tabular-nums;letter-spacing:-.02em}`,
    js: `const el=document.querySelector('.rb-count');
const to=Number(el.dataset.to||0), suf=el.dataset.suffix||'';
const dur=1600; let t0=0;
function step(t){
  if(!t0) t0=t;
  const p=Math.min(1,(t-t0)/dur);
  const e=1-Math.pow(1-p,3);
  el.textContent=Math.round(to*e).toLocaleString('en-US')+suf;
  if(p<1) requestAnimationFrame(step);
}
requestAnimationFrame(step);`,
  },

  /* ── Animations ──────────────────────────────────── */
  {
    id: 'blur-text',
    name: 'BlurText 模糊渐显',
    category: 'Animations',
    desc: '文字从虚焦变清晰，比单纯淡入更有镜头感',
    keywords: ['模糊', '虚焦', 'blurtext', 'blur', '渐显', '景深'],
    html: '<p class="rb-blur">慢一点，看清楚每个字</p>',
    css: `.rb-blur{font:600 clamp(18px,2.6vw,34px)/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:#e8e8ee;filter:blur(12px);opacity:0;animation:rbBlur 1.1s cubic-bezier(.22,.61,.36,1) forwards}
@keyframes rbBlur{to{filter:blur(0);opacity:1}}
@media (prefers-reduced-motion:reduce){.rb-blur{animation:none;filter:none;opacity:1}}`,
    js: '',
  },
  {
    id: 'magnet-lines',
    name: 'MagnetLines 磁吸点阵',
    category: 'Animations',
    desc: '点阵随鼠标偏移角度，像被磁铁吸住',
    keywords: ['磁吸', '点阵', 'magnetlines', 'magnet', '吸引', '跟随鼠标'],
    html: '<div class="rb-magnet"></div>',
    css: `.rb-magnet{display:grid;grid-template-columns:repeat(14,1fr);gap:10px;padding:18px}
.rb-magnet i{display:block;height:26px;border-radius:2px;background:#8b8b96;transform-origin:50% 100%;transition:transform .18s ease-out}`,
    js: `const box=document.querySelector('.rb-magnet');
const cols=14, rows=6;
for(let i=0;i<cols*rows;i++) box.appendChild(document.createElement('i'));
const items=[...box.querySelectorAll('i')];
function onMove(e){
  const r=box.getBoundingClientRect();
  const mx=(e.clientX-r.left)/r.width, my=(e.clientY-r.top)/r.height;
  items.forEach((el,i)=>{
    const cx=(i%cols+.5)/cols, cy=(Math.floor(i/cols)+.5)/rows;
    const dx=mx-cx, dy=my-cy;
    const dist=Math.hypot(dx,dy);
    const pull=Math.max(0,1-dist*2.2);
    el.style.transform='rotate('+(Math.atan2(dy,dx)*180/Math.PI+90)*pull+'deg)';
  });
}
box.addEventListener('pointermove',onMove);
box.addEventListener('pointerleave',()=>items.forEach(el=>el.style.transform='none'));`,
  },
  {
    id: 'click-spark',
    name: 'ClickSpark 点击迸发',
    category: 'Animations',
    desc: '点哪儿炸开一圈短线，交互反馈用',
    keywords: ['点击火花', 'clickspark', 'click spark', '点击特效', '迸发', '点击反馈'],
    html: '<div class="rb-spark-host"><button class="rb-spark-btn">点我试试</button></div>',
    css: `.rb-spark-host{position:relative;display:grid;place-items:center;padding:28px}
.rb-spark-btn{height:44px;padding:0 22px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#1a1a20;color:#f0f0f4;font:600 14px/1 system-ui,-apple-system,"PingFang SC",sans-serif;cursor:pointer}
.rb-spark-btn:hover{background:#22222a}
.rb-spark{position:absolute;width:2px;height:14px;background:#b8f65a;border-radius:2px;pointer-events:none;transform-origin:50% 0;animation:rbSpark .6s ease-out forwards}
@keyframes rbSpark{from{opacity:1;transform:translate(-50%,0) rotate(var(--a)) translateY(0) scaleY(1)}to{opacity:0;transform:translate(-50%,0) rotate(var(--a)) translateY(38px) scaleY(.4)}}`,
    js: `const host=document.querySelector('.rb-spark-host');
const btn=document.querySelector('.rb-spark-btn');
btn.addEventListener('click',(e)=>{
  const r=host.getBoundingClientRect();
  const cx=e.clientX-r.left, cy=e.clientY-r.top;
  for(let i=0;i<12;i++){
    const s=document.createElement('span');
    s.className='rb-spark';
    s.style.left=cx+'px'; s.style.top=cy+'px';
    s.style.setProperty('--a',(i*30)+'deg');
    host.appendChild(s);
    setTimeout(()=>s.remove(),620);
  }
});`,
  },

  /* ── Components ──────────────────────────────────── */
  {
    id: 'spotlight-card',
    name: 'SpotlightCard 聚光卡片',
    category: 'Components',
    desc: '鼠标位置有一团柔光跟着走，卡片立刻有层次',
    keywords: ['聚光', 'spotlightcard', 'spotlight', '光斑卡片', '卡片光效', '跟随光'],
    html: `<div class="rb-spot">
  <h3>Pro 版</h3>
  <p>鼠标在卡片上移动，聚光会跟着走。</p>
</div>`,
    css: `.rb-spot{
  position:relative;width:min(360px,86vw);padding:26px 24px;border-radius:16px;
  background:#14141a;border:1px solid rgba(255,255,255,.09);overflow:hidden;
  color:#ececf1;font:500 15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;
}
.rb-spot h3{margin:0 0 8px;font-size:20px;font-weight:700}
.rb-spot p{margin:0;color:#9a9aa4;font-size:14px}
.rb-spot::before{
  content:'';position:absolute;inset:0;pointer-events:none;opacity:0;
  transition:opacity .3s ease;
  background:radial-gradient(320px circle at var(--x,50%) var(--y,50%),rgba(184,246,90,.16),transparent 62%);
}
.rb-spot:hover::before{opacity:1}`,
    js: `const card=document.querySelector('.rb-spot');
card.addEventListener('pointermove',(e)=>{
  const r=card.getBoundingClientRect();
  card.style.setProperty('--x',(e.clientX-r.left)+'px');
  card.style.setProperty('--y',(e.clientY-r.top)+'px');
});`,
  },
  {
    id: 'star-border',
    name: 'StarBorder 描边流光',
    category: 'Components',
    desc: '按钮或卡片边缘有一道光绕圈跑',
    keywords: ['描边流光', 'starborder', 'star border', '跑光边框', '边框动画', '流光边框'],
    html: '<button class="rb-star">Get Started</button>',
    css: `.rb-star{
  position:relative;height:48px;padding:0 28px;border:0;border-radius:999px;
  background:#14141a;color:#f4f4f7;font:650 15px/1 system-ui,-apple-system,"PingFang SC",sans-serif;
  cursor:pointer;isolation:isolate;
}
.rb-star::before{
  content:'';position:absolute;inset:-1px;border-radius:inherit;z-index:-1;
  background:conic-gradient(from 0deg,transparent 0 62%,#b8f65a 76%,#22d3ee 84%,transparent 92%);
  animation:rbStar 3s linear infinite;
}
.rb-star::after{content:'';position:absolute;inset:1px;border-radius:inherit;background:#14141a;z-index:-1}
@keyframes rbStar{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.rb-star::before{animation:none}}`,
    js: '',
  },
  {
    id: 'tilt-card',
    name: 'TiltCard 3D 倾斜',
    category: 'Components',
    desc: '卡片随鼠标做 3D 倾斜，带一点反光',
    keywords: ['倾斜', '3d卡片', 'tiltcard', 'tilt', '立体', '翻转卡片'],
    html: `<div class="rb-tilt"><div class="rb-tilt-in">
  <strong>3D Card</strong>
  <span>鼠标移动试试</span>
</div></div>`,
    css: `.rb-tilt{perspective:900px;width:min(300px,82vw)}
.rb-tilt-in{
  padding:30px 24px;border-radius:16px;background:linear-gradient(160deg,#1b1b22,#101015);
  border:1px solid rgba(255,255,255,.1);color:#f0f0f4;
  display:flex;flex-direction:column;gap:6px;
  transition:transform .18s ease-out,box-shadow .25s ease;
  transform-style:preserve-3d;
}
.rb-tilt-in strong{font:700 20px/1.2 system-ui,-apple-system,"PingFang SC",sans-serif}
.rb-tilt-in span{font:500 13px/1.4 system-ui;color:#9a9aa4}`,
    js: `const wrap=document.querySelector('.rb-tilt');
const inner=document.querySelector('.rb-tilt-in');
wrap.addEventListener('pointermove',(e)=>{
  const r=wrap.getBoundingClientRect();
  const px=(e.clientX-r.left)/r.width-.5;
  const py=(e.clientY-r.top)/r.height-.5;
  inner.style.transform='rotateY('+(px*14)+'deg) rotateX('+(-py*14)+'deg) translateZ(8px)';
  inner.style.boxShadow=(px*14)+'px '+(py*18)+'px 40px -18px rgba(0,0,0,.9)';
});
wrap.addEventListener('pointerleave',()=>{inner.style.transform='none';inner.style.boxShadow='';});`,
  },

  /* ── Backgrounds ─────────────────────────────────── */
  {
    id: 'aurora',
    name: 'Aurora 极光背景',
    category: 'Backgrounds',
    desc: '几团低速飘动的色云，做深色页面底子最稳',
    keywords: ['极光', 'aurora', '色云', '氛围背景', '光晕背景', '流体背景'],
    html: '<div class="rb-aurora"><i></i><i></i><i></i></div>',
    css: `.rb-aurora{position:absolute;inset:0;overflow:hidden;background:#08080b}
.rb-aurora i{position:absolute;width:58vw;height:58vw;border-radius:50%;filter:blur(72px);opacity:.55;mix-blend-mode:screen}
.rb-aurora i:nth-child(1){background:#6d28d9;left:-14vw;top:-16vw;animation:rbA1 18s ease-in-out infinite}
.rb-aurora i:nth-child(2){background:#0891b2;right:-16vw;top:6vw;animation:rbA2 22s ease-in-out infinite}
.rb-aurora i:nth-child(3){background:#be185d;left:18vw;bottom:-22vw;animation:rbA3 26s ease-in-out infinite}
@keyframes rbA1{50%{transform:translate(9vw,7vw) scale(1.16)}}
@keyframes rbA2{50%{transform:translate(-8vw,9vw) scale(1.1)}}
@keyframes rbA3{50%{transform:translate(6vw,-9vw) scale(1.2)}}
@media (prefers-reduced-motion:reduce){.rb-aurora i{animation:none}}`,
    js: '',
  },
  {
    id: 'particles',
    name: 'Particles 粒子背景',
    category: 'Backgrounds',
    desc: '缓慢漂浮的小点，连线或不连线都能用',
    keywords: ['粒子', 'particles', '星空', '点点', '漂浮粒子', '粒子背景'],
    html: '<canvas class="rb-particles"></canvas>',
    css: `.rb-particles{position:absolute;inset:0;width:100%;height:100%;display:block;background:radial-gradient(120% 120% at 50% 0%,#101018,#07070a 70%)}`,
    js: `const cv=document.querySelector('.rb-particles');
const cx=cv.getContext('2d');
let W=0,H=0,dpr=1,ps=[];
function resize(){
  dpr=Math.min(2,window.devicePixelRatio||1);
  W=cv.clientWidth; H=cv.clientHeight;
  cv.width=W*dpr; cv.height=H*dpr;
  cx.setTransform(dpr,0,0,dpr,0,0);
  const n=Math.round(Math.min(120,(W*H)/14000));
  ps=Array.from({length:n},()=>({
    x:Math.random()*W, y:Math.random()*H,
    vx:(Math.random()-.5)*.18, vy:(Math.random()-.5)*.18,
    r:Math.random()*1.6+.6
  }));
}
let mx=-1e4,my=-1e4;
cv.addEventListener('pointermove',e=>{const r=cv.getBoundingClientRect();mx=e.clientX-r.left;my=e.clientY-r.top;});
cv.addEventListener('pointerleave',()=>{mx=my=-1e4;});
function frame(){
  cx.clearRect(0,0,W,H);
  for(const p of ps){
    const dx=p.x-mx, dy=p.y-my, d=Math.hypot(dx,dy);
    if(d<120){const f=(120-d)/120*.6;p.vx+=dx/d*f*.12;p.vy+=dy/d*f*.12;}
    p.vx*=.985; p.vy*=.985;
    p.x+=p.vx; p.y+=p.vy;
    if(p.x<0)p.x=W; if(p.x>W)p.x=0; if(p.y<0)p.y=H; if(p.y>H)p.y=0;
    cx.beginPath(); cx.arc(p.x,p.y,p.r,0,6.2832);
    cx.fillStyle='rgba(200,214,255,.72)'; cx.fill();
  }
  for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
    const a=ps[i],b=ps[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.hypot(dx,dy);
    if(d<110){cx.strokeStyle='rgba(150,170,220,'+(.14*(1-d/110))+')';cx.lineWidth=1;cx.beginPath();cx.moveTo(a.x,a.y);cx.lineTo(b.x,b.y);cx.stroke();}
  }
  requestAnimationFrame(frame);
}
resize(); window.addEventListener('resize',resize); requestAnimationFrame(frame);`,
  },
  {
    id: 'grid-motion',
    name: 'GridMotion 网格流光背景',
    category: 'Backgrounds',
    desc: '暗色网格加一道扫光，科技感强、开销极低',
    keywords: ['网格', 'gridmotion', 'grid', '科技背景', '线条背景', '扫光网格'],
    html: '<div class="rb-grid"></div>',
    css: `.rb-grid{
  position:absolute;inset:0;
  background:#08080b;
  background-image:linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px);
  background-size:44px 44px;
}
.rb-grid::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(115deg,transparent 38%,rgba(184,246,90,.12) 50%,transparent 62%);
  background-size:260% 260%;
  animation:rbGrid 9s linear infinite;
}
@keyframes rbGrid{from{background-position:0% 0%}to{background-position:100% 100%}}
@media (prefers-reduced-motion:reduce){.rb-grid::after{animation:none}}`,
    js: '',
  },

  /* ── Micro Interactions ──────────────────────────── */
  {
    id: 'magnetic-button',
    name: 'MagneticButton 磁吸按钮',
    category: 'Micro Interactions',
    desc: '按钮朝光标方向轻微移动，松手回弹',
    keywords: ['磁吸按钮', 'magneticbutton', 'magnetic', '吸附按钮', '按钮跟随'],
    html: '<div class="rb-mag-host"><button class="rb-mag">Hover me</button></div>',
    css: `.rb-mag-host{display:grid;place-items:center;padding:26px}
.rb-mag{
  height:46px;padding:0 26px;border-radius:999px;border:0;cursor:pointer;
  background:#b8f65a;color:#0c1100;font:650 15px/1 system-ui,-apple-system,"PingFang SC",sans-serif;
  transition:transform .28s cubic-bezier(.22,.61,.36,1),box-shadow .28s ease;
  will-change:transform;
}`,
    js: `const host=document.querySelector('.rb-mag-host');
const btn=document.querySelector('.rb-mag');
host.addEventListener('pointermove',(e)=>{
  const r=btn.getBoundingClientRect();
  const dx=(e.clientX-(r.left+r.width/2))*0.34;
  const dy=(e.clientY-(r.top+r.height/2))*0.34;
  btn.style.transform='translate('+dx+'px,'+dy+'px)';
  btn.style.boxShadow=(dx*.5)+'px '+(dy*.5)+'px 24px -8px rgba(184,246,90,.6)';
});
host.addEventListener('pointerleave',()=>{btn.style.transform='none';btn.style.boxShadow='';});`,
  },
  {
    id: 'glare-hover',
    name: 'GlareHover 悬停扫光',
    category: 'Micro Interactions',
    desc: '鼠标进入时一道斜光扫过卡片',
    keywords: ['扫光', 'glarehover', 'glare', '悬停光效', '反光'],
    html: `<div class="rb-glare">
  <b>Hover 我</b>
  <span>一道光会扫过去</span>
</div>`,
    css: `.rb-glare{
  position:relative;width:min(300px,82vw);padding:30px 24px;border-radius:14px;
  background:#15151b;border:1px solid rgba(255,255,255,.1);overflow:hidden;
  display:flex;flex-direction:column;gap:6px;color:#f0f0f4;
  font:500 14px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;
}
.rb-glare b{font-size:18px;font-weight:700}
.rb-glare span{color:#9a9aa4;font-size:13px}
.rb-glare::after{
  content:'';position:absolute;top:-60%;left:-140%;width:70%;height:240%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.22),transparent);
  transform:rotate(12deg);pointer-events:none;
  transition:left .7s cubic-bezier(.22,.61,.36,1);
}
.rb-glare:hover::after{left:150%}`,
    js: '',
  },
];

/** 分类清单，顺序固定，界面和提示都按这个排 */
export const RB_CATEGORIES = [
  'Text Animations',
  'Animations',
  'Components',
  'Backgrounds',
  'Micro Interactions',
];

const norm = (s) => String(s == null ? '' : s).toLowerCase();

/** 按 id 或名称取一个组件 */
export function rbGet(id) {
  const key = norm(id).trim();
  if (!key) return null;
  return RB_COMPONENTS.find((c) => norm(c.id) === key || norm(c.name).startsWith(key)) || null;
}

/** 按关键词 / 分类搜组件。空的 query 返回全部。 */
export function rbSearch(query, limit = 6) {
  const q = norm(query).trim();
  if (!q) return RB_COMPONENTS.slice(0, limit);
  const scored = RB_COMPONENTS.map((c) => {
    let score = 0;
    if (norm(c.id).includes(q)) score += 6;
    if (norm(c.name).includes(q)) score += 5;
    if (norm(c.category).includes(q)) score += 4;
    if (norm(c.desc).includes(q)) score += 2;
    for (const kw of c.keywords) {
      const k = norm(kw);
      if (k === q) score += 6;
      else if (k.includes(q) || q.includes(k)) score += 3;
    }
    return { c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}

/** 把组件展开成可直接放进画布 html 节点的三段代码 */
export function rbToNode(component, opts = {}) {
  if (!component) return null;
  const w = opts.w || 720;
  const h = opts.h || 420;
  return {
    type: 'html',
    props: {
      name: component.name,
      w, h,
      html: component.html,
      css: component.css,
      js: component.js || '',
      interactive: component.category === 'Micro Interactions' || component.category === 'Components',
    },
  };
}

/** llms.txt 风格的目录文本：只列 id / 名称 / 分类 / 一句话，
    正文按需再取，避免每次请求都背着全部实现代码。 */
export function rbIndexText() {
  const lines = RB_COMPONENTS.map(
    (c) => `- ${c.id} | ${c.name} | ${c.category} | ${c.desc}`
  );
  return lines.join('\n');
}

/** 命中某个组件时，把它的完整实现拼成提示片段 */
export function rbCodeBlock(component) {
  const c = component;
  if (!c) return '';
  return [
    `▍${c.name}（${c.category}）`,
    `HTML:\n${c.html}`,
    `CSS:\n${c.css}`,
    c.js ? `JS:\n${c.js}` : 'JS: （纯 CSS，无需脚本）',
  ].join('\n\n');
}