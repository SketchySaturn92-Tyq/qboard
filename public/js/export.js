/**
 * export.js — 把画布导出成独立可用的单文件 HTML
 * 布局、层级、旋转、动效、HTML 内部的脚本与交互全部保留。
 * 所有素材都是 data URL，所以导出文件自包含，双击就能看。
 */

import { animationValue, KEYFRAMES } from './anim.js';
import { gradientCss } from './canvas.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-pointer-lock';

function bgCss(bg) {
  const b = bg || {};
  // 动态媒体背景由底层元素自己画，stage 只留一个兜底底色
  if (b.type === 'html' || b.type === 'video' || b.type === 'svg') return 'background:#0d0d12;';
  if (b.type === 'image' && b.dataUrl) {
    return `background:#0b0b0e url("${b.dataUrl}") center/${b.fit || 'cover'} no-repeat;`;
  }
  if (b.type === 'gradient') return `background:${gradientCss(b.value) || b.value || '#fff'};`;
  return `background:${b.value || '#fff'};`;
}

function fragmentDoc(n) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
*{box-sizing:border-box}
${n.css || ''}
</style></head><body>${n.html || ''}${n.js ? `<script>try{${n.js}}catch(e){console.error(e)}<\/script>` : ''}</body></html>`;
}

function fileInner(n) {
  if (!n.src) return '<div class="qb-missing">文件丢失</div>';
  const ext = (n.ext || '').toLowerCase();

  if (ext === 'pdf') {
    return `<iframe src="${n.src}#toolbar=0&navpanes=0&view=FitH" style="width:100%;height:100%;border:0;display:block;background:#fff"></iframe>`;
  }
  if (n.preview || n.fullText || ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yml', 'yaml', 'xml', 'js', 'ts', 'css', 'py', 'sh'].includes(ext)) {
    // 画布上只显示前几千字，导出用完整原文，保证内容不变
    const body = n.fullText || n.preview || '（点开原文件查看）';
    return `<pre style="width:100%;height:100%;margin:0;overflow:auto;padding:10px;background:#14141a;color:#d8d8e0;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word">${esc(body)}</pre>`;
  }
  const kb = n.size ? (n.size / 1048576 >= 1 ? (n.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n.size / 1024)) + ' KB') : '';
  return `<a class="qb-file" href="${n.src}" download="${esc(n.name || 'file')}" target="_blank" rel="noopener"
    style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:#f4f4f6;color:#22222a;text-decoration:none;font:500 12px/1.4 system-ui;padding:8px;text-align:center">
    <b style="font-size:11px;letter-spacing:.08em;padding:2px 7px;border-radius:4px;background:#22222a;color:#b8f65a">${esc((ext || 'FILE').toUpperCase().slice(0, 6))}</b>
    <span style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.name || '文件')}</span>
    <span style="color:#8b8b96;font-size:10.5px">${esc(kb)} 点击下载</span>
  </a>`;
}

function nodeInner(n) {
  if (n.type === 'text') {
    return `<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:${
      n.valign === 'middle' ? 'center' : n.valign === 'bottom' ? 'flex-end' : 'flex-start'
    };font-size:${n.fs}px;font-weight:${n.fw};color:${n.color};text-align:${n.align};line-height:${
      n.lh};letter-spacing:${n.ls || 0}px;white-space:pre-wrap;word-break:break-word">${esc(n.text)}</div>`;
  }
  if (n.type === 'shape') {
    const bg = n.grad ? (gradientCss(n.grad) || n.fill) : n.fill;
    return `<div style="width:100%;height:100%;background:${bg};border-radius:${
      n.shape === 'ellipse' ? '9999px' : 'inherit'}"></div>`;
  }
  if (n.type === 'image') {
    return `<img src="${n.src}" alt="${esc(n.name)}" style="width:100%;height:100%;object-fit:${
      n.fit || 'cover'};display:block;border-radius:inherit" />`;
  }
  if (n.type === 'video') {
    return `<video src="${n.src}" ${n.loop ? 'loop' : ''} muted autoplay playsinline preload="metadata"
      style="width:100%;height:100%;object-fit:${n.fit || 'cover'};display:block;border-radius:inherit"></video>`;
  }
  if (n.type === 'audio') {
    return `<div style="width:100%;height:100%;display:flex;align-items:center;gap:8px;padding:8px 10px;background:#14141a;color:#ececef;border-radius:inherit">
      <span style="flex:none;width:22px;height:22px;border-radius:99px;background:#b8f65a;color:#0c1100;display:grid;place-items:center;font-size:12px">♪</span>
      <div style="flex:1;min-width:0">
        <div style="font:600 11px/1.3 system-ui;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.name || '音频')}</div>
        <audio src="${n.src}" controls ${n.loop ? 'loop' : ''} style="width:100%;height:22px;margin-top:2px"></audio>
      </div>
    </div>`;
  }
  if (n.type === 'html') {
    return `<iframe srcdoc="${esc(fragmentDoc(n))}" sandbox="${SANDBOX}"
      style="width:100%;height:100%;border:0;display:block;background:transparent"></iframe>`;
  }
  if (n.type === 'embed') {
    return `<iframe src="${esc(n.url)}" sandbox="${SANDBOX}"
      style="width:100%;height:100%;border:0;display:block;background:transparent"></iframe>`;
  }
  if (n.type === 'file') return fileInner(n);
  return '';
}

function nodeHtml(n) {
  const common = [
    `left:${n.x}px`, `top:${n.y}px`,
    `width:${n.w}px`, `height:${n.h}px`,
    `z-index:${n.z || 1}`,
    n.rot ? `transform:rotate(${n.rot}deg)` : '',
    `opacity:${n.opacity ?? 1}`,
    n.radius ? `border-radius:${n.radius}px` : '',
  ].filter(Boolean).join(';');

  const anim = animationValue(n.anim);
  const animation = anim ? `;animation:${anim}` : '';
  const dataAnim = anim ? ` data-anim="${esc(anim)}"` : '';

  return `<div class="qb-node" style="${common}${animation}"${dataAnim}>${nodeInner(n)}</div>`;
}

/** 动态背景在导出文件里也要是活的：内联成 srcdoc 的 iframe */
function liveBackgroundLayer(bg) {
  const b = bg || {};

  // 视频背景：直接带进导出文件，静音循环
  if (b.type === 'video' && b.dataUrl) {
    return `<video class="qb-bg" muted loop autoplay playsinline aria-hidden="true"
      src="${b.dataUrl}"
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:${b.fit || 'cover'};border:0;display:block;pointer-events:none;z-index:0"></video>`;
  }

  // SVG 背景：内联进文档，SMIL 动画照常跑
  if (b.type === 'svg' && b.svg) {
    return `<div class="qb-bg" aria-hidden="true"
      style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">${b.svg}</div>`;
  }

  if (b.type !== 'html' || !(b.html || b.css || b.js)) return '';
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
*{box-sizing:border-box}
${b.css || ''}
</style></head><body>${b.html || ''}${b.js ? `<script>try{${b.js}}catch(e){console.error(e)}<\/script>` : ''}</body></html>`;
  return `<iframe class="qb-bg" aria-hidden="true" tabindex="-1" src="${esc(`data:text/html;charset=utf-8,${encodeURIComponent(doc)}`)}"
    sandbox="allow-scripts"
    style="position:absolute;inset:0;width:100%;height:100%;border:0;display:block;pointer-events:none;z-index:0"></iframe>`;
}

export function buildExportHtml(project) {
  const { w: W, h: H } = project.artboard;
  const nodes = [...project.nodes].filter((n) => !n.hidden).sort((a, b) => (a.z || 0) - (b.z || 0));
  const body = nodes.map(nodeHtml).join('\n');
  const bgLayer = liveBackgroundLayer(project.background);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QBoard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;min-height:100%;background:#0a0a0c;overflow-x:hidden}
  body{display:flex;justify-content:center;align-items:flex-start;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  #qb-viewport{position:relative;width:${W}px;transform-origin:top center}
  #qb-stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;${bgCss(project.background)}}
  .qb-node{position:absolute;transform-origin:center center;overflow:hidden}
  .qb-node iframe,.qb-node video,.qb-node audio{pointer-events:auto}
  .qb-bg > svg{width:100%;height:100%;display:block}
  .qb-missing{width:100%;height:100%;display:grid;place-items:center;background:#14141a;color:#6b6b75;font-size:11px}
  @media (prefers-reduced-motion: reduce){ .qb-node{animation:none !important} }
  @media print{ #qb-viewport{transform:none !important} }
${KEYFRAMES}
</style>
</head>
<body>
<div id="qb-viewport"><div id="qb-stage">
${bgLayer}
${body}
</div></div>
<script>
(function () {
  var W = ${W}, H = ${H};
  var vp = document.getElementById('qb-viewport');
  var stage = document.getElementById('qb-stage');
  function fit() {
    // 只在窗口比画板窄时缩放，避免放大后糊掉
    var s = Math.min(1, window.innerWidth / W);
    vp.style.transform = s < 1 ? 'scale(' + s + ')' : 'none';
    vp.style.marginBottom = s < 1 ? (-(1 - s) * H) + 'px' : '0px';
    document.body.style.minHeight = (H * s) + 'px';
    stage.style.maxWidth = '100%';
  }
  fit();
  window.addEventListener('resize', fit);
})();
</script>
</body>
</html>`;
}

/* ── 一键导出：整个工作台 → 一页纵向连贯滚动 ────────────── */

/**
 * 把所有画布拼成**一页连续滚动**的网页。
 * 不再有分页签、不用一块块点开：从上往下滚就是完整的一条线。
 * 段与段之间严丝合缝（无间隙、无分隔条），进入视野时轻微上浮淡入，
 * 并做 proximity 级别的滚动吸附，停在哪儿就稳在哪儿。
 */
export function buildProjectHtml(doc, activeId) {
  /* 文档有两代结构：新的是多工作台，旧的是平铺的一层画布。
     导出只导当前工作台，别把别的工作台的内容也拼进来。 */
  const boards = Array.isArray(doc?.boards)
    ? doc.boards
    : (() => {
      const all = Array.isArray(doc?.workspaces) ? doc.workspaces : [];
      if (!all.length) return [];
      const ws = all.find((w) => w.id === doc.activeWorkspaceId) || all[0];
      return Array.isArray(ws?.boards) ? ws.boards : [];
    })();
  if (!boards.length) return buildExportHtml({ ...(doc || {}), nodes: [], background: {} });

  const first = boards.find((b) => b.id === activeId) || boards[0];
  const W0 = first.artboard?.w || 1440;
  const H0 = first.artboard?.h || 900;

  // 只保留真的有东西的画布，避免导出里出现几屏完全空白
  const scenes = boards.filter((b) => {
    const hasNodes = (b.nodes || []).some((n) => !n.hidden);
    const bg = b.background || {};
    const hasBg = (bg.type === 'html' && (bg.html || bg.css || bg.js))
      || (bg.type === 'video' && bg.dataUrl)
      || (bg.type === 'svg' && bg.svg);
    return hasNodes || hasBg;
  });
  const list = scenes.length ? scenes : boards;

  const sections = list.map((b, i) => {
    const nodes = [...(b.nodes || [])].filter((n) => !n.hidden).sort((x, y) => (x.z || 0) - (y.z || 0));
    const inner = nodes.map(nodeHtml).join('\n');
    const bg = liveBackgroundLayer(b.background);
    const bw = b.artboard?.w || W0;
    const bh = b.artboard?.h || H0;
    return `<section class="qb-scene${i === 0 ? ' is-in' : ''}" data-w="${bw}" data-h="${bh}">
  <div class="qb-hold">
    <div class="qb-stage" style="width:${bw}px;height:${bh}px;${bgCss(b.background)}">
${bg}
${inner}
    </div>
  </div>
</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(first.name || doc?.name || 'QBoard')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  html,body{width:100%;min-height:100%;background:#0a0a0c;overflow-x:hidden}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
  }

  /* 每一屏一段，段与段之间没有间隙、没有分割线 —— 滚动时是连着的 */
  .qb-scene{
    position:relative;
    width:100%;
    overflow:hidden;
    scroll-snap-align:start;
  }
  .qb-scene + .qb-scene{ margin-top:0 }

  /* 进入视野时轻微淡入+微缩放。用 scale 不用位移：
     位移会在段与段之间露出空隙，那就不是"连成一条"了。 */
  .qb-scene{ opacity:0; }
  .qb-scene > .qb-hold{ transform:scale(1.012); }
  .qb-scene.is-in{ opacity:1; }
  .qb-scene.is-in > .qb-hold{ transform:none; }
  .qb-scene{ transition:opacity .75s cubic-bezier(.22,.61,.36,1); }
  .qb-scene > .qb-hold{ transition:transform .9s cubic-bezier(.22,.61,.36,1); }

  .qb-hold{ position:relative; width:100%; display:block; }
  .qb-stage{
    position:relative;
    transform-origin:top left;
    overflow:hidden;
    will-change:transform;
  }

  .qb-node{position:absolute;transform-origin:center center;overflow:hidden}
  .qb-node iframe,.qb-node video,.qb-node audio{pointer-events:auto}
  .qb-bg{pointer-events:none}
  .qb-bg > svg{width:100%;height:100%;display:block}
  .qb-missing{width:100%;height:100%;display:grid;place-items:center;background:#14141a;color:#6b6b75;font-size:11px}

  @media (prefers-reduced-motion: reduce){
    html{scroll-behavior:auto}
    .qb-scene{opacity:1 !important;transform:none !important;transition:none !important}
    .qb-node{animation:none !important}
  }
  @media print{
    body{background:#fff}
    .qb-scene{opacity:1 !important;transform:none !important;break-after:page}
  }
${KEYFRAMES}
</style>
</head>
<body>
${sections}
<script>
(function () {
  var scenes = [].slice.call(document.querySelectorAll('.qb-scene'));
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 按视口宽度等比缩到刚好铺满，避免横向溢出、也不需要左右拖动
  function layout() {
    var vw = document.documentElement.clientWidth;
    scenes.forEach(function (sc) {
      var stage = sc.querySelector('.qb-stage');
      var hold = sc.querySelector('.qb-hold');
      if (!stage || !hold) return;
      var W = Number(sc.dataset.w) || ${W0};
      var H = Number(sc.dataset.h) || ${H0};
      var s = Math.min(1, vw / W);
      stage.style.transform = s < 1 ? 'scale(' + s + ')' : 'none';
      hold.style.height = (H * s) + 'px';
      sc.style.height = (H * s) + 'px';
    });
  }

  // 进视野就淡入；已经露脸的保持住，不来回闪
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.06 });
    scenes.forEach(function (sc) { io.observe(sc); });
  } else {
    scenes.forEach(function (sc) { sc.classList.add('is-in'); });
  }

  // 分段吸附：滚一格就是一屏，但保留自由滚动的手感
  if (CSS.supports && CSS.supports('scroll-snap-type', 'y proximity') && !reduce) {
    document.documentElement.style.scrollSnapType = 'y proximity';
  }

  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);
  // 字体、图片加载完高度会变，再校一次
  window.addEventListener('load', layout);
  setTimeout(layout, 260);
})();
</script>
</body>
</html>`;
}
