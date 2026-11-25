/* ═══════════════════════════════════════════════════════
   QBoard · 素材画布主控
   素材自由摆放 → 元素级 agent 定向修改 → 导出保真 HTML
   ═══════════════════════════════════════════════════════ */

import { Store, makeNode, nextZ, TYPE_LABEL, uid } from './store.js';
import { Canvas, escapeHtml, wrapFragment, gradientCss, clamp } from './canvas.js';
import { installKeyframes, normalizeAnim } from './anim.js';
import { buildExportHtml, buildProjectHtml } from './export.js';
import { SKILLS, DEFAULT_ENABLED, matchSkills, REACTBITS_ID } from './skills.js';
import { REA_MAIN, REA_REFS } from './rea-skill.js';
import { BACKGROUNDS, findBackground } from './backgrounds.js';
import { RB_COMPONENTS, RB_CATEGORIES, rbSearch, rbGet, rbIndexText, rbCodeBlock, rbToNode } from './reactbits.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const store = new Store();
const state = {
  tool: 'select',
  config: null,
  busy: false,
  focusId: null,
  // 本次会话临时输入的 Key；保存到账号后清空，不落浏览器
  draftProvider: null,
  // 每个对话线程上一次读到的网页材料，用来接住"1:1复刻"这类指代
  lastWeb: {},
  // 每个线程本轮待发送的图片（粘贴/拖入的），发完清空
  attached: {},
};

/* ── DOM ──────────────────────────────────────────────── */

const dom = {
  stage: $('#stage'),
  viewport: $('#viewport'),
  world: $('#world'),
  artboard: $('#artboard'),
  artboardBg: $('#artboardBg'),
  layer: $('#layer'),
  guides: $('#guides'),
  selOverlay: $('#selOverlay'),
  marquee: $('#marquee'),
  zoomVal: $('#zoomVal'),
};

const canvas = new Canvas({ store, dom });

/* ── Toast ────────────────────────────────────────────── */

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toastWrap').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 2400);
}

/* ── 元素创建 ─────────────────────────────────────────── */

/** 在视口中心附近找一块空地放新元素，尽量不与已有元素重叠 */
function defaultSpot(w, h) {
  const ab = store.project.artboard;
  const r = dom.viewport.getBoundingClientRect();
  const p = canvas.toBoard(r.left + r.width / 2, r.top + r.height / 2);
  const centerX = clamp(Math.round(p.x - w / 2), 0, Math.max(0, ab.w - w));
  const centerY = clamp(Math.round(p.y - h / 2), 0, Math.max(0, ab.h - h));

  const pad = 14;
  const hit = (x, y) => store.project.nodes.some((n) => !n.hidden &&
    x < n.x + n.w + pad && x + w + pad > n.x &&
    y < n.y + n.h + pad && y + h + pad > n.y);

  if (!hit(centerX, centerY)) return { x: centerX, y: centerY };

  // 以中心为原点向外螺旋找空位
  const stepX = Math.max(40, Math.round(w * 0.42));
  const stepY = Math.max(40, Math.round(h * 0.42));
  for (let ring = 1; ring <= 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = clamp(centerX + dx * stepX, 0, Math.max(0, ab.w - w));
        const y = clamp(centerY + dy * stepY, 0, Math.max(0, ab.h - h));
        if (!hit(x, y)) return { x, y };
      }
    }
  }
  // 实在放不下就叠在中心并稍微错位
  const n = store.project.nodes.length;
  return {
    x: clamp(centerX + (n % 6) * 22 - 55, 0, Math.max(0, ab.w - w)),
    y: clamp(centerY + (n % 6) * 22 - 55, 0, Math.max(0, ab.h - h)),
  };
}

function addNode(type, props = {}) {
  let id = null;
  store.commit((p) => {
    const node = makeNode(type, props, p);
    p.nodes.push(node);
    id = node.id;
  });
  canvas.render();
  canvas.select(id);
  syncInspector();
  return id;
}

function addText() {
  const w = 420, h = 72;
  const spot = defaultSpot(w, h);
  const id = addNode('text', { ...spot, w, h, text: '双击编辑文字', fs: 40, fw: 650, color: '#111111' });
  setTimeout(() => canvas.startInlineEdit(id), 60);
}

function addShape() {
  const w = 180, h = 180;
  addNode('shape', { ...defaultSpot(w, h), w, h, shape: 'rect', fill: '#111111', radius: 12 });
}

/* ── 文件导入 ─────────────────────────────────────────── */

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'];
const VID_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];
const AUD_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('读取失败'));
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(file);
  });
}

/** 位图压缩到合理体积；GIF / 动画 WebP 原样保留字节，但仍然量出真实尺寸 */
async function importBitmap(file, maxSide = 1600) {
  const isAnim = /gif/i.test(file.type) || /\.gif$/i.test(file.name) ||
    /animated/i.test(file.type);
  const url = await readAsDataUrl(file);

  const probe = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = url;
  });

  // 动图不能重编码，否则帧就没了；只把尺寸报给上层用于算布局
  if (isAnim) return { src: url, mime: file.type, w: probe.w, h: probe.h, animated: true };

  if (!probe.w || !probe.h) return { src: url, mime: file.type, w: 0, h: 0 };

  const scale = Math.min(1, maxSide / Math.max(probe.w, probe.h));
  if (scale >= 1 && url.length < 1_200_000) {
    return { src: url, mime: file.type, w: probe.w, h: probe.h };
  }

  const cv = document.createElement('canvas');
  cv.width = Math.round(probe.w * scale);
  cv.height = Math.round(probe.h * scale);
  const ctx = cv.getContext('2d');
  await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, cv.width, cv.height); resolve(); };
    img.onerror = () => resolve();
    img.src = url;
  });
  let out = url;
  try { out = cv.toDataURL('image/jpeg', 0.9); } catch { /* 保留原图 */ }
  return { src: out, mime: file.type, w: cv.width, h: cv.height };
}

/**
 * 把一张图压成适合发给模型的尺寸。
 *
 * 原始截图动辄几 MB，直接塞进请求会超限、也会拖慢首字节。
 * 模型看的是"内容"不是"像素"，长边 1280、JPEG 0.82 已经足够判断
 * 配色、构图、字体层级。同时保留 PNG（带透明）转 JPEG 前的白底，
 * 否则透明区域会变成黑块，模型会误判成深色背景。
 */
async function shrinkForModel(file, maxSide = 1280) {
  const url = await readAsDataUrl(file);

  const probe = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  if (!probe) return '';

  const w = probe.naturalWidth || probe.width;
  const h = probe.naturalHeight || probe.height;
  if (!w || !h) return '';

  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d');
  // 先铺白底，透明 PNG 才不会变黑
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(probe, 0, 0, cw, ch);

  try {
    return cv.toDataURL('image/jpeg', 0.82);
  } catch {
    return url;
  }
}

/**
 * 压缩一个 dataURL 图片。
 *
 * 画布上的图片元素可能是用户上传的原图，几 MB 很常见。
 * 直接塞进请求会超限、首字节也会很慢，所以统一压到长边 1280 再发。
 * 压完还是过大的（比如超大噪点图）直接放弃，不拿它拖垮整次请求。
 */
async function shrinkDataUrl(src, maxSide = 1280, maxBytes = 480000) {
  if (!src || typeof src !== 'string' || !src.startsWith('data:image/')) return '';
  if (src.length <= maxBytes / 2) return src;   // 已经够小，不用动

  const probe = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  if (!probe) return src.length <= maxBytes ? src : '';

  const w = probe.naturalWidth || probe.width;
  const h = probe.naturalHeight || probe.height;
  if (!w || !h) return '';

  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(probe, 0, 0, cw, ch);

  let out = src;
  try { out = cv.toDataURL('image/jpeg', 0.82); } catch { /* 保底用原图 */ }
  return out.length <= maxBytes ? out : '';
}

/** 取出某张图片元素的可用地址；不是图片就返回空 */
function imageSrcOf(n) {
  if (!n) return '';
  if (n.type === 'image' && n.src) return n.src;
  // 图片类文件也当图看待
  if (n.type === 'file' && n.src && /^image\//.test(n.mime || '') ) return n.src;
  return '';
}

async function probeVideoSize(file) {
  const url = await readAsDataUrl(file);
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve({ src: url, w: v.videoWidth || 640, h: v.videoHeight || 360 });
    v.onerror = () => resolve({ src: url, w: 640, h: 360 });
    v.src = url;
  });
}

async function importFiles(files, dropPoint) {
  const list = [...files];
  if (!list.length) return;
  let count = 0;

  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    // 多个文件同时落下时按序号级联错位，避免全叠在同一点
    const drop = dropPoint
      ? { x: dropPoint.x + (i % 3) * 26, y: dropPoint.y + Math.floor(i / 3) * 26 }
      : null;
    try {
      if (f.type.startsWith('image/') || IMG_EXT.includes(ext)) {
        const { src, mime, w, h } = await importBitmap(f);
        const ab = store.project.artboard;
        const ratio = w && h ? w / h : 1;
        // 小图（比如 1×1 的占位 GIF）不能放大成一大块，按原始尺寸给一个合理默认值
        const ceiling = Math.min(ab.w * 0.42, 520);
        let nw = w && h ? clamp(w, 160, ceiling) : ceiling;
        let nh = nw / ratio;
        if (nh > ab.h * 0.55) { nh = ab.h * 0.55; nw = nh * ratio; }
        const spot = drop || defaultSpot(nw, nh);
        store.commit((p) => {
          p.nodes.push(makeNode('image', {
            x: Math.round(spot.x - (drop ? nw / 2 : 0)),
            y: Math.round(spot.y - (drop ? nh / 2 : 0)),
            w: Math.round(nw), h: Math.round(nh),
            src, mime, fit: 'cover', name: f.name,
          }, p));
        });
        count++;
      } else if (f.type.startsWith('video/') || VID_EXT.includes(ext)) {
        const { src, w, h } = await probeVideoSize(f);
        const ab = store.project.artboard;
        const ratio = w / h;
        let nw = Math.min(ab.w * 0.42, 560);
        let nh = nw / ratio;
        if (nh > ab.h * 0.55) { nh = ab.h * 0.55; nw = nh * ratio; }
        const spot = drop || defaultSpot(nw, nh);
        store.commit((p) => {
          p.nodes.push(makeNode('video', {
            x: Math.round(spot.x - (drop ? nw / 2 : 0)),
            y: Math.round(spot.y - (drop ? nh / 2 : 0)),
            w: Math.round(nw), h: Math.round(nh),
            src, mime: f.type, fit: 'cover', name: f.name,
          }, p));
        });
        count++;
      } else if (f.type.startsWith('audio/') || AUD_EXT.includes(ext)) {
        const src = await readAsDataUrl(f);
        const spot = drop || defaultSpot(360, 96);
        store.commit((p) => {
          p.nodes.push(makeNode('audio', {
            x: Math.round(spot.x), y: Math.round(spot.y), w: 360, h: 96,
            src, mime: f.type, name: f.name,
          }, p));
        });
        count++;
      } else if (ext === 'html' || ext === 'htm') {
        const text = await f.text();
        const parts = splitHtmlDoc(text);
        const ab = store.project.artboard;
        let nw = Math.round(Math.min(ab.w * 0.55, 620));
        let nh = Math.round(nw * 0.66);
        if (nh > ab.h * 0.7) { nh = Math.round(ab.h * 0.7); nw = Math.round(nh / 0.66); }
        const spot = drop || defaultSpot(nw, nh);
        store.commit((p) => {
          p.nodes.push(makeNode('html', {
            x: Math.round(spot.x - (drop ? nw / 2 : 0)),
            y: Math.round(spot.y - (drop ? nh / 2 : 0)),
            w: nw, h: nh,
            html: parts.html, css: parts.css, js: parts.js,
            sourceDoc: text.slice(0, 200000),
            name: f.name, interactive: true,
          }, p));
        });
        count++;
      } else if (ext === 'pdf') {
        const src = await readAsDataUrl(f);
        const ab = store.project.artboard;
        const nw = Math.round(Math.min(ab.w * 0.5, 520));
        const nh = Math.round(nw * 1.414);
        const spot = drop || defaultSpot(nw, nh);
        store.commit((p) => {
          p.nodes.push(makeNode('file', {
            x: Math.round(spot.x - (drop ? nw / 2 : 0)),
            y: Math.round(spot.y - (drop ? nh / 2 : 0)),
            w: nw, h: Math.min(nh, Math.round(ab.h * 0.8)),
            src, mime: 'application/pdf', ext: 'pdf', size: f.size, name: f.name,
          }, p));
        });
        count++;
      } else if (/^(txt|md|markdown|json|csv|log|rtf)$/.test(ext) || f.type === 'text/plain') {
        const text = (await f.text()).slice(0, 6000);
        const lines = Math.max(2, Math.min(12, text.split('\n').length));
        const nw = 460, nh = lines * 30 + 20;
        const spot = drop || defaultSpot(nw, nh);
        store.commit((p) => {
          p.nodes.push(makeNode('text', {
            x: Math.round(spot.x), y: Math.round(spot.y), w: nw, h: Math.round(nh),
            text, fs: 16, fw: 400, lh: 1.65, name: f.name,
          }, p));
        });
        count++;
      } else {
        // 其它类型一律保原件：导出时仍能下载，画布上显示文件卡片
        const src = await readAsDataUrl(f);
        const spot = drop || defaultSpot(240, 140);
        store.commit((p) => {
          p.nodes.push(makeNode('file', {
            x: Math.round(spot.x), y: Math.round(spot.y), w: 240, h: 140,
            src, mime: f.type || 'application/octet-stream', ext,
            size: f.size, name: f.name,
          }, p));
        });
        count++;
        toast(`${f.name}：按原文件保留，导出后仍可下载`, 'good');
      }
    } catch (err) {
      toast(`${f.name} 导入失败：${err.message}`, 'bad');
    }
  }

  if (count) {
    canvas.render();
    syncInspector();
    toast(`放入 ${count} 个素材`, 'good');
    const last = store.project.nodes[store.project.nodes.length - 1];
    if (last) canvas.select(last.id);
  }
}

/** 把一份完整 HTML 文档拆成 body / css / js 三段，便于 agent 分别改写 */
export function splitHtmlDoc(text) {
  let html = text;
  let css = '';
  let js = '';

  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(text))) css += m[1] + '\n';
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(text))) js += m[1] + '\n';

  try {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script, style, link[rel="stylesheet"]').forEach((el) => el.remove());
    html = (doc.body?.innerHTML || '').trim();
    // 内联样式也并进 css，缩放后不至于丢样式
    doc.querySelectorAll('[style]').forEach(() => {});
  } catch {
    html = text;
  }

  // 只留 body 里那段；原本就没有 body 标签时退回原文
  if (!html) html = text;
  return { html, css: css.trim(), js: js.trim() };
}

/* ── 背景 ─────────────────────────────────────────────── */

const BG_PRESETS = [
  { label: '纯白', bg: { type: 'color', value: '#ffffff' } },
  { label: '纸感', bg: { type: 'color', value: '#f6f3ec' } },
  { label: '墨黑', bg: { type: 'color', value: '#0d0d10' } },
  { label: '深夜蓝', bg: { type: 'gradient', value: '160deg,#0b1020,#1b2b4b,#0d1020' } },
  { label: '暖霞', bg: { type: 'gradient', value: '150deg,#fff1e6,#ffd9c0,#f7c8b7' } },
  { label: '薄荷', bg: { type: 'gradient', value: '135deg,#e8fff4,#c7f0e2,#eaf7ff' } },
  { label: '霓虹', bg: { type: 'gradient', value: '120deg,#1a0b2e,#3b0f52,#0b2545' } },
];

/** 动态背景卡片：点一下就把画板背景换成实时渲染的模板 */
function renderBgLive() {
  const box = $('#bgLive');
  if (!box) return;
  const bg = store.project.background || {};
  const curHtml = bg.type === 'html' ? (bg.html || '') : '';
  box.innerHTML = '';

  (BACKGROUNDS || []).forEach((tpl) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'bg-card' + (bg.type === 'html' && curHtml === (tpl.html || '') ? ' on' : '');
    card.style.background = tpl.swatch || 'linear-gradient(135deg,#2b1055,#ff4d8d)';
    card.title = tpl.desc || '';

    const name = document.createElement('span');
    name.className = 'bg-card-name';
    name.textContent = tpl.name;
    card.appendChild(name);

    card.onclick = () => {
      store.commit((p) => {
        p.background = {
          type: 'html',
          value: '#0d0d12',
          dataUrl: '',
          fit: 'cover',
          html: tpl.html || '',
          css: tpl.css || '',
          js: tpl.js || '',
        };
      });
      canvas.render();
      renderBgLive();
      const foot = $('#bgFoot');
      if (foot) {
        foot.className = 'sheet-foot ok';
        foot.textContent = `已换成「${tpl.name}」：这是实时动画，不是图片`;
      }
    };
    box.appendChild(card);
  });

  const tip = document.createElement('p');
  tip.className = 'bg-live-tip';
  tip.textContent = bg.type === 'html'
    ? '当前是动态背景，导出后仍然是动的。想回到静态，点上面的纯色或渐变。'
    : '这些都是实时动画（CSS 实现），不是贴图，导出后依然是动的。';
  box.appendChild(tip);
}

function renderBgPresets() {
  const box = $('#bgPresets');
  box.innerHTML = '';
  BG_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.onclick = () => {
      store.commit((pr) => {
        pr.background = { ...pr.background, ...p.bg, dataUrl: pr.background.dataUrl };
      });
      canvas.render();
      $$('#bgPresets button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      $('#bgFoot').textContent = `已应用：${p.label}`;
      $('#bgFoot').className = 'sheet-foot ok';
    };
    box.appendChild(b);
  });
}

/* ── 属性面板 ─────────────────────────────────────────── */

let binding = false;

function syncInspector() {
  const sel = canvas.selectedNodes();
  const empty = $('#inspEmpty');
  const body = $('#inspBody');

  if (sel.length !== 1) {
    empty.hidden = false;
    body.hidden = true;
    renderLayers();
    return;
  }
  const n = sel[0];
  empty.hidden = true;
  body.hidden = false;

  binding = true;
  $('#inspKind').textContent = TYPE_LABEL[n.type] || n.type;
  $('#inspName').value = n.name || '';
  $('#px').value = Math.round(n.x);
  $('#py').value = Math.round(n.y);
  $('#pw').value = Math.round(n.w);
  $('#ph').value = Math.round(n.h);
  $('#prot').value = Math.round(n.rot || 0);
  $('#pz').value = n.z || 1;
  $('#pop').value = n.opacity ?? 1;
  $('#popVal').textContent = Math.round((n.opacity ?? 1) * 100) + '%';
  $('#prad').value = n.radius || 0;
  $('#pradVal').textContent = n.radius || 0;

  $('#sectText').hidden = n.type !== 'text';
  $('#sectShape').hidden = n.type !== 'shape';
  $('#sectMedia').hidden = !['image', 'video', 'audio', 'file', 'html', 'embed'].includes(n.type);
  $('#sectHtml').hidden = n.type !== 'html';

  if (n.type === 'html') {
    $('#phtmlCss').value = n.css || '';
    $('#phtmlHtml').value = n.html || '';
    $('#phtmlJs').value = n.js || '';
  }

  if (n.type === 'text') {
    $('#ptext').value = n.text || '';
    $('#pfs').value = n.fs || 32;
    $('#pfw').value = String(n.fw || 400);
    $('#pcolor').value = n.color || '#111111';
    $('#palign').value = n.align || 'left';
    $('#plh').value = n.lh || 1.3;
    $('#pls').value = n.ls ?? 0;
  }
  if (n.type === 'shape') {
    $('#pshape').value = n.shape || 'rect';
    $('#pfill').value = n.fill || '#111111';
    $('#pgrad').value = n.grad || '';
  }
  if (['image', 'video', 'audio', 'file', 'html', 'embed'].includes(n.type)) {
    $('#mediaInfo').textContent = n.type === 'image'
      ? `${(n.src || '').slice(0, 30)}… · ${n.mime || '未知类型'}`
      : n.type === 'video' ? '视频 · 自动循环播放'
      : n.type === 'audio' ? '音频 · 可播放'
      : n.type === 'file' ? `${(n.ext || 'file').toUpperCase()} · ${n.name || ''}（导出后仍可下载原文件）`
      : 'HTML 片段 · 脚本和交互都会运行';
  }

  const a = normalizeAnim(n.anim);
  $('#pmEnter').value = a.enter;
  $('#pmLoop').value = a.loop;
  $('#pmDur').value = a.dur;
  $('#pmDelay').value = a.delay;
  $('#pmEase').value = a.ease;

  binding = false;
  renderLayers();
}

function patchSelected(patch, { commit = true } = {}) {
  const sel = canvas.selectedNodes();
  if (!sel.length) return;
  const apply = (p) => {
    sel.forEach((s) => {
      const n = p.nodes.find((x) => x.id === s.id);
      if (n) Object.assign(n, patch);
    });
  };
  if (commit) store.commit(apply);
  else { apply(store.project); store.touch('patch'); }
  canvas.render();
}

/** 连续输入的表单：先快照，失焦结算，避免每敲一个字进一次撤销栈 */
function liveBind(el, handler) {
  el.addEventListener('input', () => {
    if (binding) return;
    handler(el);
  });
  el.addEventListener('focus', () => store.captureSnapshot());
  el.addEventListener('blur', () => store.settleSnapshot());
  el.addEventListener('change', () => {
    if (binding) return;
    if (el.type === 'range' || el.type === 'number' || el.tagName === 'SELECT') {
      store.settleSnapshot();
      store.captureSnapshot();
    }
  });
}

/** 画板尺寸下拉跟着当前画布走；多画布不再有切换器与命名 */
function syncBoardUI() {
  const cur = store.project;
  if (!cur) return;
  const sel = $('#artSize');
  if (!sel) return;
  const key = `${cur.artboard.w}x${cur.artboard.h}`;
  if (![...sel.options].some((o) => o.value === key)) {
    sel.appendChild(new Option(`${cur.artboard.w} × ${cur.artboard.h}`, key));
  }
  sel.value = key;
}

/** 换画布 / 新建 / 删除之后，把画布、属性面板、对话全部重挂一遍。
    scrollTo 传画布 id 时，滚到那一块（新建后要一眼看见新画布）；
    传 true 沿用旧行为（适应视野）；传 false 保持当前视野。 */
function refreshAfterBoardChange(scrollTo = true) {
  canvas.selection.clear();
  canvas.interactiveId = null;
  canvas.render();
  if (typeof scrollTo === 'string') canvas.scrollToBoard(scrollTo);
  else if (scrollTo === true) canvas.fit();
  renderLayers();
  syncInspector();
  syncBoardUI();
  syncWorkspaceUI();
  renderCtxLog();
  syncDockFocus();
  updatePlaceholder();
}

/* ── 工作台 ──────────────────────────────────────────── */

/** 顶栏的工作台名字与下拉列表 */
function syncWorkspaceUI() {
  const ws = store.workspace;
  const nameEl = $('#wsName');
  if (nameEl) nameEl.textContent = ws?.name || '工作台';
  const countEl = $('#wsCount');
  const listEl = $('#wsList');
  if (!listEl) return;

  const all = store.workspaces;
  if (countEl) countEl.textContent = `${all.length} 个`;
  listEl.innerHTML = '';
  all.forEach((w) => {
    const row = document.createElement('div');
    row.className = 'ws-row' + (w.id === ws.id ? ' on' : '');
    row.innerHTML = `
      <span class="ws-row-name">${escapeHtml(w.name || '工作台')}</span>
      <span class="ws-row-meta">${(w.boards || []).length} 块</span>
      <button class="ws-row-del" type="button" title="删除这个工作台">✕</button>`;
    row.onclick = (e) => {
      if (e.target.closest('.ws-row-del')) return;
      if (store.setWorkspace(w.id)) closeWorkspaceMenu();
    };
    row.querySelector('.ws-row-del').onclick = (e) => {
      e.stopPropagation();
      if (all.length <= 1) return toast('至少保留一个工作台', 'bad');
      if (!confirm(`删除「${w.name}」，连同里面 ${(w.boards || []).length} 块画布？`)) return;
      if (store.removeWorkspace(w.id)) { toast('已删除工作台', 'good'); closeWorkspaceMenu(); }
    };
    listEl.appendChild(row);
  });
}

function openWorkspaceMenu() {
  const menu = $('#wsMenu');
  if (!menu) return;
  syncWorkspaceUI();
  menu.hidden = false;
}
function closeWorkspaceMenu() {
  const menu = $('#wsMenu');
  if (menu) menu.hidden = true;
}

/** 新建一个完全独立的工作台：空白起步，和现有画布互不影响 */
function addWorkspace() {
  const ws = store.addWorkspace();
  refreshAfterWorkspaceChange();
  closeWorkspaceMenu();
  toast(`已新建「${ws.name}」，和原来的工作台互不影响`, 'good');
  return ws;
}

/** 换工作台之后：画布整套换掉，视野回到适应窗口 */
function refreshAfterWorkspaceChange() {
  canvas.selection.clear();
  canvas.interactiveId = null;
  canvas.render();
  canvas.fit();
  renderLayers();
  syncInspector();
  syncBoardUI();
  syncWorkspaceUI();
  renderCtxLog();
  syncDockFocus();
  updatePlaceholder();
}

/** 在当前画布下面插一块新画布，并滚过去。三处「＋」都走这里。 */
function addBoardBelow(anchorId) {
  const after = anchorId || store.project.id;
  const board = store.addBoard(undefined, {}, after);
  refreshAfterBoardChange(board.id);
  toast('已在这块画布下面加了一块', 'good');
  return board;
}

function renderLayers() {
  const box = $('#layers');
  const nodes = [...store.project.nodes].sort((a, b) => (b.z || 0) - (a.z || 0));
  box.innerHTML = '';
  if (!nodes.length) {
    box.innerHTML = '<p class="muted small">还没有元素</p>';
    return;
  }
  nodes.forEach((n) => {
    const row = document.createElement('div');
    row.className = 'layer-item' + (canvas.selection.has(n.id) ? ' on' : '');
    row.innerHTML = `
      <span class="layer-type">${escapeHtml((TYPE_LABEL[n.type] || n.type).slice(0, 2))}</span>
      <span class="layer-name">${escapeHtml(n.name || '元素')}</span>
      <span class="layer-vis" title="显示 / 隐藏">${n.hidden ? '○' : '●'}</span>`;
    row.onclick = (e) => {
      if (e.target.classList.contains('layer-vis')) {
        store.commit((p) => {
          const node = p.nodes.find((x) => x.id === n.id);
          if (node) node.hidden = !node.hidden;
        });
        canvas.render();
        syncInspector();
        return;
      }
      canvas.select(n.id);
      $('#inspector').classList.add('open');
      syncInspector();
    };
    box.appendChild(row);
  });
}

/* ── 选中联动：聊天的焦点 chip ────────────────────────── */

canvas.onSelectionChange = (sel) => {
  syncInspector();
  state.focusId = sel.length === 1 ? sel[0].id : null;
  if (!$('#ctx').hidden) {
    // 菜单开着时选中变了，标题、常用动作、对话记录都换到那个元素
    syncCtxHeader();
    renderCtxActs();
    renderCtxLog();
  }
  syncDockFocus();
  updatePlaceholder();
};

canvas.onInteractive = ({ active, name }) => {
  const hint = $('#hint');
  if (hint) {
    hint.textContent = active
      ? `正在试「${name || 'HTML 元素'}」的交互 · 点元素框上的按钮或按 Esc 切回编辑`
      : '拖文件进来 · 双击编辑文字 · 空格拖动画面 · ⌘滚轮缩放';
  }
  // 模式变了，按钮文字和选中框都要跟着刷新
  canvas.updateOverlay?.();
};

/**
 * 在「编辑」和「嵌入」之间切换。
 * 编辑态：可以拖动、缩放、右键改，鼠标不吃进 iframe。
 * 嵌入态：鼠标事件交给里面的页面，可以点按钮、滚动。
 * 两种状态都能通过同一个按钮切回来，不会卡死在里面。
 */
function toggleEmbedMode(id) {
  const target = id || (canvas.selectedNodes()[0]?.id);
  const n = store.project.nodes.find((x) => x.id === target);
  if (!n || !canvas.canToggleEmbed(n)) return;
  if (canvas.interactiveId === n.id) {
    canvas.exitInteractive();
    toast('已切回编辑：可以拖动和右键修改', 'good');
  } else {
    canvas.enterInteractive(n.id);
    toast('已切到嵌入：鼠标交给里面的页面', 'good');
  }
  canvas.updateOverlay?.();
}

function bindEmbedToggle() {
  // 每块画布各有一个 .embed-toggle，用事件委托统一接
  const world = $('#world');
  if (!world || world.dataset.embedBound === '1') return;
  world.dataset.embedBound = '1';
  world.addEventListener('click', (e) => {
    if (!e.target.closest('.embed-toggle')) return;
    e.stopPropagation();
    e.preventDefault();
    toggleEmbedMode();
  });
  // 按钮自己不能触发画布上的拖动/框选
  world.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.embed-toggle')) e.stopPropagation();
  });
}

canvas.onExitPreview = () => {
  canvas.exitInteractive();
  if (previewOn) togglePreview(false);
};

canvas.onLiveTransform = () => {
  const sel = canvas.selectedNodes();
  if (sel.length !== 1) return;
  const n = sel[0];
  binding = true;
  $('#px').value = Math.round(n.x);
  $('#py').value = Math.round(n.y);
  $('#pw').value = Math.round(n.w);
  $('#ph').value = Math.round(n.h);
  $('#prot').value = Math.round(n.rot || 0);
  binding = false;
};

function updatePlaceholder() {
  const input = $('#ctxText');
  if (!input) return;
  const sel = canvas.selectedNodes();
  if (sel.length === 1) {
    const n = sel[0];
    const tag = TYPE_LABEL[n.type] || '元素';
    input.placeholder = n.type === 'html'
      ? '改这个片段，比如：不要每 5 秒闪，改成鼠标移上去才亮'
      : `「${n.name || tag}」怎么改？比如：2 秒后开始漂浮，周期 4 秒`;
  } else if (sel.length > 1) {
    input.placeholder = `这 ${sel.length} 个元素一起调整，比如：排成一行，间距 24`;
  } else {
    input.placeholder = '右键点一个元素下指令，或在这里问整体';
  }
}

/* ── agent：上下文构造 ────────────────────────────────── */

const SYS_PROMPT = `你是 QBoard 画布里的设计代理。画布是一块自由排布的素材板：图片、GIF、视频、音频、文字、HTML 片段、PDF、以及各种原始文件都可以放在任意位置，自由缩放和旋转。

你的工作：理解用户的自然语言指令，输出一份 JSON 补丁来修改画布。不要输出网页代码以外的解释。

【你可以发图给我看】
除了改画布，你还能在回复里附图。两种写法，放在同一个 JSON 顶层：
· "imageNode": "画布上某个图片元素的 id" —— 把那张图发给我（最常用，"把这张图发我"就用它）
· "image": "https://..." 或 data URL —— 直接给一个图片地址
发图时 say 写一句话说明这是什么。只发图不改画布是允许的，不用硬凑 ops。

【输出格式 · 必须严格遵守】
只输出一个 \`\`\`json 代码块：
{
  "ops": [
    { "action": "update", "id": "节点id", "set": { "x": 100, "y": 200, "anim": { "loop": "float", "dur": 4000, "delay": 2000 } } }
  ],
  "say": "一句话说明你做了什么"
}

【允许的 action】
- update：改现有元素，必须给 id 和 set
- add：新增元素，给 type 和 props
- delete：删除元素，给 id

【字段白名单 · 只能出现这些】
几何：x, y, w, h, rot, opacity, radius, z
文字：text, fs, fw, color, align, lh, ls, valign
形状：shape(rect|ellipse), fill, grad
媒体：src, fit(cover|contain), name
HTML：html, css, js
动效 anim：{ enter, loop, dur, delay, ease }
  enter 可选：none fadeIn fadeUp popIn slideLeft slideRight blurIn scaleIn
  loop 可选：none float pulse spin sway blink
  dur / delay：毫秒，80-20000
  ease 可选：spring ease-out ease-in-out linear

【改 HTML 元素内部的交互 · 重要】
如果用户选中的是 type 为 html 的元素，你会拿到它的 html / css / js 三段源码。
这时用户可以要求改它内部的交互行为，你要直接改写这三段代码，把结果放进 set 里：
- set.html：body 内部的结构
- set.css：样式，包括 :hover、transition、@keyframes
- set.js：脚本，注意不要带 <script> 标签，只要函数体
一次要给出完整的 html 和 css（不是 diff），保证替换后仍然完整可用。
典型改写：
· "5 秒闪一次" 改成 "鼠标悬停时亮" → 删掉 animation 定时，改成 .x:hover 里换颜色或加 transition
· 加点击切换 → 在 js 里写事件绑定
· 改颜色/字号/间距 → 直接改 css
改写时不要夹带用户没要求的变化，其余样式和结构原样保留。

【硬约束】
1. 只改用户要求的那部分，未提及的属性不要写进 set。
2. 用户选中了某个元素时，只输出针对它的 ops，不要动其他元素。
3. 只改一条动效时间时，只写 anim 里的 dur / delay。
4. add 时坐标要在画板范围内，尺寸别超过画板一半。
5. 不要编造图片地址；新增图片用 src: ""。
6. say 用中文，一句话，不要客套。

【示例一 · 改画布动效】
用户选中一个 logo：「2 秒后开始慢慢漂浮，一个周期 4 秒」
\`\`\`json
{"ops":[{"action":"update","id":"abc123","set":{"anim":{"enter":"none","loop":"float","dur":4000,"delay":2000,"ease":"ease-in-out"}}}],"say":"logo 延迟 2 秒开始漂浮，周期 4 秒"}
\`\`\`

【示例二 · 改 HTML 内部交互】
用户选中一个每 5 秒闪一次的卡片：「改成鼠标移上去才亮」
\`\`\`json
{"ops":[{"action":"update","id":"h1","set":{"html":"<div class=\\"card\\"><h3>标题</h3><p>说明</p></div>","css":".card{background:#14141a;color:#fff;padding:20px;border-radius:12px;transition:background .25s ease,box-shadow .25s ease}.card:hover{background:#b8f65a;color:#0c1100;box-shadow:0 0 28px rgba(184,246,90,.6)}","js":""}}],"say":"改成悬停时变亮，去掉了原来的定时闪烁"}
\`\`\``;

/* 背景与「动态效果」的专项规则。
   用户抱怨过：让它做 Color Bends 那种流动背景，结果贴了一张静态图。
   根因是背景模型以前只有纯色/渐变/图片，模型只能退化成图片；
   现在背景支持 html 实时渲染，这里把规则写死，避免它再走回头路。 */
const BG_PROMPT = `

【画布背景 · 专用操作】
改背景不要当成加元素，用独立操作：
{"action":"background","set":{"type":"html","html":"…","css":"…","js":"…"}}
可用字段：type(color|gradient|image|html|video|svg)、value、dataUrl、fit、html、css、js、svg
- color：纯色，value 写 #0d1117
- gradient：CSS 渐变，value 写 160deg,#0b1020,#1b2b4b
- image：位图背景，需要 dataUrl，只在用户上传图片时用
- video：视频背景，需要 dataUrl，自动静音循环
- svg：SVG 背景，给 svg 字段（整段 SVG 标记），内部动画照常跑
- html：实时背景。html/css/js 在同源 iframe 里真正运行，CSS 动画、Canvas、WebGL 都支持

【动态背景必须由你自己实现】
用户要「会动的流体 / 光斑 / 极光 / 粒子 / 着色器那种」背景时：
1. 用 type:"html"，亲手写出渲染代码。禁止贴静态图，禁止用 add 加 image 元素冒充背景，禁止说「模板里没有」。
2. 优先写原生 WebGL 片元着色器：canvas.getContext('webgl')、全屏四边形、片元里用 uv 和时间算色带与噪点，requestAnimationFrame 累加时间。
3. 代码必须自己兜底：拿不到 WebGL 上下文就退回 CSS 渐变，绝不留白屏；shader 编译失败要看日志并按提示修。
4. canvas 尺寸按 devicePixelRatio 缩放但上限 2，监听 resize 重设，避免糊和卡。
5. 只用原生 API，不引任何外部库或 CDN，因为页面 CSP 只允许同源。
6. 这类效果大多跟着鼠标动：光斑被光标吸引、粒子躲开指针、背景随鼠标轻微视差。
   用户提到鼠标、或这个效果本来就有交互时，必须写 pointermove 监听，不能交一个只会自己飘的版本。
   做法：坐标归一化成 0..1 存目标值，每帧插值（cur += (target-cur)*0.08），WebGL 用 uniform vec2 uMouse 传进去。
   背景在编辑态不接收鼠标（要能拖动），只有预览态生效，这是正常的，不要因此删掉鼠标逻辑。

【什么时候必须用 html 动态背景】
用户说「流动」「呼吸」「渐变流动」「光斑」「极光」「粒子」「波浪」「会动」「reactbits 那种」时：
1. 必须用 type:"html" 写真实的动画，用 @keyframes 或 canvas 实现，让它一直动。
2. 绝对禁止把动态效果做成静态图片，也禁止用 add 加一个 image 元素冒充背景。
3. 不要引用外部 CDN 的脚本或样式（页面 CSP 只允许同源），纯 CSS / Canvas 自己写。
4. 动画周期 8-30 秒，无限循环，首尾关键帧一致；尽量只动 transform 和 opacity，blur 半径不超过 80px。
5. 背景要留出可读性：整体偏中等暗，文字放上去仍然清楚。

【动态背景写法示例 · 流动光斑】
{"ops":[{"action":"background","set":{"type":"html",
 "html":"<div class=\"b b1\"></div><div class=\"b b2\"></div><div class=\"b b3\"></div>",
 "css":"html,body{margin:0;height:100%;overflow:hidden;background:#0d0d12}.b{position:absolute;border-radius:50%;filter:blur(60px);mix-blend-mode:screen;opacity:.85}.b1{width:70vmax;height:70vmax;left:-15vmax;top:-20vmax;background:radial-gradient(circle,#7b2ff7,#7b2ff700 70%);animation:f1 18s ease-in-out infinite}.b2{width:60vmax;height:60vmax;right:-10vmax;top:10vmax;background:radial-gradient(circle,#ff2e88,#ff2e8800 70%);animation:f2 22s ease-in-out infinite}.b3{width:65vmax;height:65vmax;left:10vmax;bottom:-25vmax;background:radial-gradient(circle,#38bdf8,#38bdf800 70%);animation:f3 26s ease-in-out infinite}@keyframes f1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(8vmax,6vmax) scale(1.12)}}@keyframes f2{0%,100%{transform:translate(0,0) scale(1.05)}50%{transform:translate(-7vmax,5vmax) scale(.95)}}@keyframes f3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(5vmax,-8vmax) scale(1.15)}}",
 "js":""}}],"say":"换成实时流动的光斑背景，不是图片"}

【硬约束 · 补充】
· 用户说「动态 / 会动 / 流动」时，交不出动画就算没做完；交一张静态图是错的。
· 改背景只动 background，不要顺手加元素。
· 已有背景是 html 且用户要微调时，读现有 html/css 再改，不要把整套动画删掉重画。`;

const BOARD_PROMPT = `

【多画布 · 一个工作台里有好几块画布】
这不是多个页面，而是一个工作台里纵向排开的几块画布；它们没有名字，也不要给它们起名字。
定位全靠 position：从上往下数第几块（第 1 块在最上面）。
你会收到一份清单：当前这块给完整状态，其余每块给摘要（id、position、尺寸、背景、元素列表）。

规则：
1. 用户说「下面那块」「第二块」「另一块画布」时，按清单里的 position 找对应的 id，不要凭空猜。
   绝不要在回复里说「画布 2」「画布 3」这种名字——用户看到的只是一叠画布，没有编号命名。
2. 要改的不是当前这块画布时，在 op 里带上 "board": "目标画布 id"：
   {"action":"background","board":"bvlpy0dmx","set":{"type":"html","html":"…","css":"…","js":"…"}}
   {"action":"add","board":"bvlpy0dmx","type":"text","props":{…}}
   {"action":"update","board":"bvlpy0dmx","id":"节点id","set":{…}}
   {"action":"delete","board":"bvlpy0dmx","id":"节点id"}
   不带 board 的 op 一律作用在当前这块画布上。
3. 允许一次给多个 board 的 ops —— 用户说「两块都换成 XX 背景」就分别写两条。
4. 清单里 other 画布的 background 直接给了 html / css / js 原文。
   用户说「和上面那块一样的背景」时，把那一块的 html/css/js 原样搬到目标画布，不要自己另写近似效果。
   要微调就在这份原文上改，不要当成空白重画。
5. 用户提到某块画布是「空的 / 白的」，以清单里的 nodeCount 和 background.type 为准，不要靠猜。
6. 不要顺手删掉或重建别的画布；只动用户点名的那块。`;

function nodeDigest(n) {
  const base = { id: n.id, type: n.type, name: n.name, x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) };
  if (n.rot) base.rot = n.rot;
  if (n.z) base.z = n.z;
  if (n.type === 'text') Object.assign(base, { text: (n.text || '').slice(0, 200), fs: n.fs, fw: n.fw, color: n.color, align: n.align });
  if (n.type === 'shape') Object.assign(base, { shape: n.shape, fill: n.fill, grad: n.grad || undefined });
  if (n.type === 'image' || n.type === 'video' || n.type === 'audio') Object.assign(base, { hasSrc: Boolean(n.src), fit: n.fit });
  if (n.type === 'file') Object.assign(base, { ext: n.ext, mime: n.mime, size: n.size, hasSrc: Boolean(n.src) });
  if (n.type === 'html') {
    // 把代码原样交给模型，否则它没法改交互
    base.html = n.html || '';
    base.css = n.css || '';
    if (n.js) base.js = n.js;
  }
  base.anim = n.anim;
  return base;
}

/* ── 技能 ─────────────────────────────────────────────
   技能是写给模型的专业约束：命中关键词时追加到系统提示后面。
   用户可以在「模型」面板里关掉某几个，也可以全部关掉。
   ─────────────────────────────────────────────────── */

const SKILL_KEY = 'qboard.skills.v1';

/* ── 账号偏好 ─────────────────────────────────────────
   技能开关、画布视图位置这类"小设置"跟着账号走。
   以前只存在浏览器里，换台设备登录就像换了个人。
   服务端 /api/prefs 是真源，本地只做兜底缓存。
   ─────────────────────────────────────────────────── */

const PREFS = { data: {}, timer: null, loaded: false };

async function loadPrefs() {
  try {
    const res = await fetch('api/prefs');
    if (res.ok) {
      const j = await res.json();
      PREFS.data = (j && j.prefs) || {};
      PREFS.loaded = true;
    }
  } catch { /* 断网就先用默认值 */ }
  return PREFS.data;
}

function savePrefs(patch) {
  Object.assign(PREFS.data, patch || {});
  clearTimeout(PREFS.timer);
  PREFS.timer = setTimeout(() => {
    fetch('api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: PREFS.data }),
    }).catch(() => { /* 失败下次再写 */ });
  }, 500);
}

function readEnabledSkills() {
  const valid = new Set(SKILLS.map((s) => s.id));
  const pick = (arr) => arr.filter((id) => valid.has(id));
  // 账号里有就用账号的；账号里没有才退回这台机器的旧设置
  if (PREFS.loaded && Array.isArray(PREFS.data.skills)) {
    return pick(PREFS.data.skills);
  }
  try {
    const raw = localStorage.getItem(SKILL_KEY);
    if (!raw) return [...DEFAULT_ENABLED];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [...DEFAULT_ENABLED];
    return pick(arr);
  } catch {
    return [...DEFAULT_ENABLED];
  }
}

function writeEnabledSkills(ids) {
  savePrefs({ skills: ids });
  try { localStorage.setItem(SKILL_KEY, JSON.stringify(ids)); } catch { /* 隐私模式忽略 */ }
}

/* REA 正文外置。命中时按这句在说哪一类目标，只追加相关的附录，
   而不是把 96KB 全塞进去 —— 那样首字节要慢好几秒，还容易让模型分心。 */
const REA_TOPICS = [
  { key: 'javascript-applications', re: /javascript|electron|asar|bundle|webpack|混淆|源码恢复|js\s*包|前端打包/i },
  { key: 'native-and-artifacts', re: /native|nativeaot|go\s*build|rust|firmware|固件|二进制|dotnet|\.net|安装包|dll|dylib|exe/i },
  { key: 'android-applications', re: /android|安卓|apk|jadx|dex|smali/i },
  { key: 'runtime-observation', re: /运行时|抓包|fiddler|cdp|devtools|调试|端口|进程/i },
  { key: 'evidence-workflows', re: /证据|对比|版本差异|验证|核查|引用/i },
  { key: 'connection-and-recovery', re: /连不上|没有工具|工具缺失|mcp|安装|配置|注册|doctor/i },
];

/* 这段限定必须放在正文前面。
   REA 原文假设你有 MCP 工具、能跑 npx；画布里的 agent 两样都没有。
   不写清楚，它会一本正经地"调用"根本不存在的工具，或者让用户白等一场。 */
const REA_GUARD = `先说清你在哪：你运行在 QBoard 的浏览器画布 agent 里，不是本机的命令行 agent。
下面是从 REA 项目完整搬来的规则，当作知识和方法论用，不是可调用的工具清单。

你手上真的有什么：
· 用户拖进画布的文件内容（文本、代码、页面、图片，能读到的部分）；
· 用户粘贴的代码或链接；
· 抓网页的能力（能打开公开页面拿正文和源码）。

你没有、也不许假装有的：
· 没有 REA 的 MCP 工具，不能调用 recover_javascript_sources、analyze_* 这类接口；
· 不能执行 npx、rea-agents、ghidra、hopper、jadx、ida，也不能安装任何东西；
· 不能对用户的二进制做真正的反编译、动态调试或抓运行时流量。

所以在这种环境里应该这么做：
1. 能读就读：把用户给的 JS / asar 内容、源码片段、页面代码当证据，直接分析结构和行为。
2. 说结论要带出处：指出是哪段代码、哪个字符串、哪个字段得出的判断，不要把猜测说成事实。
3. 缺证据就说缺：需要真正反编译才能回答时，明说"这步要在你本机跑"，并给出原文里对应的那条命令，
   让用户自己执行，而不是由你声称已经跑过。
4. 版本对比、行为还原、混淆逻辑解释这类不依赖本地引擎的问题，可以直接做。`;

function reaSuffix(text) {
  const t = String(text || '');
  const picked = REA_TOPICS.filter((x) => x.re.test(t)).map((x) => x.key);
  // 一份附录都没命中时给 JS 那份：绝大多数"帮我看看这个包"都是前端产物
  const keys = picked.length ? picked : ['javascript-applications'];
  const refs = keys
    .filter((k) => REA_REFS[k])
    .map((k) => `\n\n── 附录：${k} ──\n${REA_REFS[k]}`)
    .join('');
  return `${REA_GUARD}\n\n${REA_MAIN}${refs}`;
}

/** 按这句话命中的技能，命中的规则拼成系统提示的补充段 */
function skillSuffix(text) {
  let hits = [];
  try {
    hits = matchSkills(text, readEnabledSkills());
  } catch { hits = []; }
  state.lastSkills = hits.map((sk) => sk.name);
  if (!hits.length) return '';
  const body = hits.map((sk) => {
    // 正文外置的两个技能：命中时才去取，避免每次请求都背着全部代码
    if (sk.id === 'rea') return `▍${sk.name}（${sk.desc}）\n${reaSuffix(text)}`;
    if (sk.id === REACTBITS_ID) return `▍${sk.name}（${sk.desc}）\n${rbSuffix(text)}`;
    return `▍${sk.name}（${sk.desc}）\n${sk.rules}`;
  }).join('\n\n');
  return `\n\n【本次启用的技能 · 硬约束，必须遵守】\n${body}\n\n以上技能规则与前面的默认风格冲突时，以技能规则为准。`;
}

/** 命中的组件把完整实现带上；没命中具体组件就给目录，让模型自己挑 */
function rbSuffix(text) {
  const hits = rbSearch(text, 3);
  const head = `【React Bits 内置库】共 ${RB_COMPONENTS.length} 个组件，分 ${RB_CATEGORIES.length} 类：
${RB_CATEGORIES.join(' / ')}
用户要这类效果时，优先复用下面给的真实实现，不要自己另写近似版本、也不要去引 CDN。
做法：建一个 type:"html" 的元素，把 HTML 填进 html、CSS 填进 css、脚本填进 js，
尺寸按内容给（文字组件宽度按字数估，背景类铺满整块画板），然后照常提交补丁。
所有实现都是原生 HTML/CSS/JS，没有 React、没有外部依赖，粘进去就能跑。
装饰性循环动画同一屏不超过 2 个；正文和数据不要加循环。`;

  const pick = hits.length
    ? hits.map((c) => rbCodeBlock(c)).join('\n\n———\n\n')
    : `没有精确命中时，从这份目录里挑最贴近的一个，再按同样结构自己补齐实现（保持原动画节奏与交互特征）：
${rbIndexText()}`;

  return `${head}\n\n${pick}`;
}

/** 配置面板里的技能开关 */
function renderSkillGrid() {
  const box = $('#skillGrid');
  if (!box) return;
  const enabled = readEnabledSkills();
  box.innerHTML = '';
  SKILLS.forEach((sk) => {
    const on = enabled.includes(sk.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'skill-chip' + (on ? ' on' : '');
    b.title = sk.desc || '';
    b.innerHTML = `<span class="skill-ico">${sk.icon || '◆'}</span>`
      + `<span class="skill-meta"><span class="skill-name">${sk.name}</span>`
      + `<span class="skill-desc">${sk.desc || ''}</span></span>`;
    b.onclick = () => {
      const cur = readEnabledSkills();
      const next = cur.includes(sk.id) ? cur.filter((x) => x !== sk.id) : [...cur, sk.id];
      writeEnabledSkills(next);
      renderSkillGrid();
    };
    box.appendChild(b);
  });
  const count = $('#skillCount');
  if (count) count.textContent = `${enabled.length}/${SKILLS.length}`;
}

/**
 * 收集这一轮要交给模型的图片。
 *
 * 两个来源：
 * 1）用户刚粘贴或拖进聊天框的图（state.attached[key]）；
 * 2）他当前选中的图片元素——选中一张图下指令，说的就是这张图。
 *
 * 上限 4 张：再多请求体会过大，首字节也慢。
 */
/* ── 聊天里的图片附件 ───────────────────────────────────── */

/** 两个聊天框各自对应哪个线程，以及缩略图挂在哪 */
const ATTACH_SLOTS = [
  { form: '#dockForm', bar: '#dockAttach', key: () => CANVAS_KEY },
  { form: '#ctxForm', bar: '#ctxAttach', key: () => elementKey() },
];

/** 把某个线程的待发图片画成缩略图 */
function renderAttach(key) {
  ATTACH_SLOTS.forEach((slot) => {
    const k = (() => { try { return slot.key(); } catch { return ''; } })();
    if (k !== key) return;

    const bar = $(slot.bar);
    if (!bar) return;
    const list = state.attached[key] || [];

    if (!list.length) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }

    bar.hidden = false;
    bar.innerHTML = '';
    list.forEach((url, i) => {
      const box = document.createElement('div');
      box.className = 'attach-thumb';

      const img = document.createElement('img');
      img.src = url;
      img.alt = `图片 ${i + 1}`;
      box.appendChild(img);

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = '移除这张图';
      del.onclick = (e) => {
        e.stopPropagation();
        state.attached[key] = (state.attached[key] || []).filter((_, j) => j !== i);
        renderAttach(key);
      };
      box.appendChild(del);

      bar.appendChild(box);
    });
  });
}

/**
 * 把粘贴/拖进来的文件变成待发图片。
 * 图片压缩到长边 1280，避免请求体过大；非图片直接忽略。
 */
async function addAttachedFiles(key, files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return 0;

  const list = state.attached[key] || [];
  let added = 0;

  for (const f of imgs) {
    if (list.length >= 4) break;   // 上限 4 张
    try {
      const url = await shrinkForModel(f);
      if (url) { list.push(url); added++; }
    } catch { /* 单张失败不影响其它 */ }
  }

  state.attached[key] = list;
  renderAttach(key);
  if (added) toast(`已附加 ${added} 张图，可以看图说话了`, 'good');
  return added;
}

/** 给两个聊天框装上：粘贴图片、拖入图片 */
function bindAttachInputs() {
  ATTACH_SLOTS.forEach((slot) => {
    const form = $(slot.form);
    const ta = form?.querySelector('textarea');
    if (!form || !ta) return;

    const keyOf = () => { try { return slot.key(); } catch { return CANVAS_KEY; } };

    // 粘贴：聊天框里有图就不当文字粘
    ta.addEventListener('paste', async (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.some((f) => f.type.startsWith('image/'))) return;
      e.preventDefault();
      await addAttachedFiles(keyOf(), files);
    });

    // 拖入
    ['dragenter', 'dragover'].forEach((ev) => {
      form.addEventListener(ev, (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        form.classList.add('dragover');
      });
    });
    form.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      form.classList.remove('dragover');
    });
    form.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      form.classList.remove('dragover');
      await addAttachedFiles(keyOf(), e.dataTransfer.files);
    });
  });
}

function collectVisionImages(key) {
  // 发送前已经预处理过（压缩完毕），直接用那份
  const ready = state.visionReady?.[key];
  if (Array.isArray(ready)) return ready.slice(0, 4);

  const out = [];
  const seen = new Set();
  const push = (url, from) => {
    if (!url || typeof url !== 'string' || !url.startsWith('data:image/')) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, from });
  };

  (state.attached[key] || []).forEach((url) => push(url, 'attach'));
  if (key !== 'canvas') canvas.selectedNodes().forEach((n) => push(imageSrcOf(n), 'selection'));
  return out.slice(0, 4);
}

/**
 * 发送前把这一轮的图准备好：压缩、去重、限量。
 *
 * 必须在真正组消息之前做完，因为 buildMessages 是同步的，
 * 而压缩要等图片解码。所以先在 send 里算好，存进 state.visionReady。
 */
async function prepareVision(key) {
  const out = [];
  const seen = new Set();

  const add = async (src, from) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    const small = await shrinkDataUrl(src);
    if (!small) return;
    out.push({ url: small, from });
  };

  for (const url of (state.attached[key] || [])) {
    if (out.length >= 4) break;
    await add(url, 'attach');
  }

  if (key !== 'canvas') {
    for (const n of canvas.selectedNodes()) {
      if (out.length >= 4) break;
      await add(imageSrcOf(n), 'selection');
    }
  }

  state.visionReady = state.visionReady || {};
  state.visionReady[key] = out;
  return out;
}

/**
 * 从模型回复里取出要发给用户的图。
 *
 * 两种给法：
 *   image     —— 直接给地址（data URL 或 http 链接）
 *   imageNode —— 给画布上某个图片元素的 id，用那个元素的图
 * 后者更常用：用户说"把这张图发我"，模型指一下元素即可。
 */
function pickReplyImage(parsed) {
  const raw = typeof parsed?.image === 'string' ? parsed.image.trim() : '';
  if (raw && /^(data:image\/|https?:\/\/)/i.test(raw)) return raw;

  const nodeId = typeof parsed?.imageNode === 'string' ? parsed.imageNode.trim() : '';
  if (nodeId) {
    const n = store.project.nodes.find((x) => x.id === nodeId);
    const src = imageSrcOf(n);
    if (src) return src;
  }
  return '';
}

/** 一块画布的精简摘要：给模型看「一共有哪些画布、各放了什么」。
    画布本身不编号也不显示名字，这里用「从上往下的第几块」来定位。 */
function boardDigest(b, activeId, index) {
  const bg = b.background || {};
  const out = {
    id: b.id,
    position: index + 1,           // 从上往下第几块
    active: b.id === activeId,
    artboard: `${(b.artboard || {}).w || 1440}x${(b.artboard || {}).h || 900}`,
    background: {
      type: bg.type || 'color',
      value: bg.value || '',
      // 动态背景给原文，不是长度：否则模型没法照着复刻同款效果
      html: bg.type === 'html' ? (bg.html || '') : undefined,
      css: bg.type === 'html' ? (bg.css || '') : undefined,
      js: bg.type === 'html' ? (bg.js || '') : undefined,
      svg: bg.type === 'svg' ? (bg.svg || '') : undefined,
      hasDataUrl: Boolean(bg.dataUrl),
    },
    nodeCount: (b.nodes || []).length,
    nodes: (b.nodes || []).map((n) => ({
      id: n.id, type: n.type, name: n.name,
      x: Math.round(n.x), y: Math.round(n.y),
      w: Math.round(n.w), h: Math.round(n.h),
    })),
  };
  return out;
}

function buildMessages(userText, key = 'canvas', webContext = null, retryHint = '') {
  const p = store.project;
  // 每个线程只看自己的历史：元素线程不会带上整体对话，反之亦然
  const sel = key === 'canvas' ? [] : canvas.selectedNodes();

  // 当前画布的完整状态（含元素详情与背景代码）。
  // 画布不编号也不显示名字，只用「从上往下第几块」定位。
  const idx = Math.max(0, store.boards.findIndex((b) => b.id === p.id));
  const ctx = {
    boardId: p.id,
    position: idx + 1,
    isActive: true,
    artboard: p.artboard,
    background: {
      type: p.background.type,
      value: p.background.value,
      // 动态背景要告诉模型它已经有几行代码，避免它以为还是空白
      liveHtml: p.background.type === 'html' ? (p.background.html || '').length : 0,
    },
    nodeCount: p.nodes.length,
    selected: sel.map((n) => n.id),
    nodes: p.nodes.map(nodeDigest),
  };

  // 同一份文档里的其它画布：只给摘要，按「从上往下第几块」定位，不依赖名字
  const others = store.boards
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.id !== p.id)
    .map(({ b, i }) => boardDigest(b, p.id, i));

  const msgs = [{ role: 'system', content: SYS_PROMPT + BG_PROMPT + BOARD_PROMPT + skillSuffix(userText) }];
  const head = `当前画布状态：\n\`\`\`json\n${JSON.stringify(ctx, null, 1)}\n\`\`\``;
  const boardPart = others.length
    ? `\n\n同一个项目里的其它画布（同一页里纵向排开）：\n\`\`\`json\n${JSON.stringify(others, null, 1)}\n\`\`\``
    : '\n\n这个项目目前只有这一块画布。';
  msgs.push({ role: 'user', content: head + boardPart });

  // 历史只来自当前线程，避免一个元素的对话污染另一个。
  // 本次指令在发送前已经写进线程了，这里要把最后那条剔掉，否则会重复发给模型。
  const hist = threadMessages(key).slice(-10);
  const tail = hist[hist.length - 1];
  if (tail && tail.role === 'me' && tail.text === userText) hist.pop();

  hist.forEach((m) => {
    if (m.role === 'me') msgs.push({ role: 'user', content: m.text });
    else if (m.role === 'ai') msgs.push({ role: 'assistant', content: m.text });
  });

  /* 组件的真实源码：最高优先级，单独一条放在最前面。
     用户手动粘贴「Copy prompt」时，正文里只有安装说明，
     这里补的是从公开仓库取回来的那份实现（含 shader）。 */
  if (webContext?.source?.code) {
    const s = webContext.source;
    const bits = [
      '【原组件的真实实现源码 · 最高优先级，照它移植】',
      `文件：${s.file || s.name}（分类：${s.category || '未知'}）`,
      '这段是原组件的完整实现。shader、参数默认值、绘制逻辑一律按它来，不要自己另写近似效果。',
      '注意：画布页面的 CSP 只允许同源，不能 import three 或任何 npm 包。',
      '所以要把它改写成零依赖的原生 WebGL（或 Canvas 2D）：算法和参数照搬，只把渲染载体换掉。',
      '',
      s.code,
    ];
    if (s.css) bits.push('', '【它的样式】', s.css);
    msgs.push({ role: 'user', content: bits.join('\n') });
  }

  /* 联网抓到的材料单独一条。
     文字多的时候模型容易只看字面，所以有截图就一起给 ——
     颜色、密度、层次这些只有画面能说清。 */
  if (webContext && (webContext.text || (webContext.images || []).length)) {
    const intro = '以下是我从网上取到的真实内容，请严格以它为依据回答或动手：';
    if ((webContext.images || []).length) {
      const content = [{ type: 'text', text: webContext.text ? `${intro}\n\n${webContext.text}` : intro }];
      webContext.images.forEach((url) => {
        content.push({ type: 'image_url', image_url: { url } });
      });
      msgs.push({ role: 'user', content });
    } else {
      msgs.push({ role: 'user', content: `${intro}\n\n${webContext.text}` });
    }
  }

  /* 图片：既包括用户这轮粘贴/拖进来的，也包括他选中的那张图片元素。
     模型只有拿到像素才能判断配色、构图、字体层级；
     只给"有个 image 元素，w=300"这种元信息，它只能瞎猜。 */
  const vision = collectVisionImages(key);
  if (vision.length) {
    const head = [
      '【我给的图片】',
      '请直接看图判断，不要只看画布状态里的文字描述。',
      vision.length > 1 ? `共 ${vision.length} 张，按顺序对应。` : '',
      vision.some((v) => v.from === 'selection') ? '其中包含我当前选中的图片元素。' : '',
    ].filter(Boolean).join('\n');

    const content = [{ type: 'text', text: head }];
    vision.forEach((v) => content.push({ type: 'image_url', image_url: { url: v.url } }));
    msgs.push({ role: 'user', content });
  }

  // 重试时把上次失败原因附在这句后面，逼它这次直接给补丁
  msgs.push({ role: 'user', content: retryHint ? `${userText}\n\n${retryHint}` : userText });
  return msgs;
}

/* ── 联网取数 ─────────────────────────────────────────── */

/** 从一句话里挑出所有 http(s) 网址 */
function extractUrls(text) {
  const re = /https?:\/\/[^\s，。、）)】\]'"<>]+/gi;
  const found = String(text || '').match(re) || [];
  return [...new Set(found.map((u) => u.replace(/[.,;:]+$/, '')))].slice(0, 3);
}

/** 抓一个网页，返回 {title, url, content} 或 null */
async function fetchPage(url) {
  try {
    const res = await fetch('api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const j = await res.json();
    if (!j?.ok) return null;
    // 有的页面文字是空的、但画面有用，所以有图也算拿到了东西
    if (!j.content && !j.screenshot && !j.prompt) return null;
    return {
      url: j.url || url,
      title: j.title || '',
      content: j.content || '',
      // 页面自带的「复制提示词 / 代码」：比截图权威，优先用它
      prompt: j.prompt || '',
      codeBlocks: Array.isArray(j.codeBlocks) ? j.codeBlocks : [],
      // 服务端回的是 base64 JPEG，这里拼成可直接给模型的 data URL
      image: j.screenshot ? `data:image/jpeg;base64,${j.screenshot}` : '',
    };
  } catch {
    return null;
  }
}

/** 联网搜索；拿不到就返回空数组 */
async function searchWeb(query, count = 6) {
  try {
    const res = await fetch('api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count }),
    });
    const j = await res.json();
    return j?.ok && Array.isArray(j.results) ? j.results : [];
  } catch {
    return [];
  }
}

/** 判断用户是不是在问"最新/现在/查一下/搜一下"这类需要联网的东西 */
function looksLikeSearchNeed(text) {
  const t = String(text || '');
  if (extractUrls(t).length) return false;          // 已经给了网址，先抓那个
  return /(最新|现在|今天|目前|最近|实时|行情|价格|新闻|搜索|搜一下|查一下|帮我查|联网|网上)/.test(t);
}

/**
 * 这句话是不是在指"刚才那个网页"。
 *
 * 用户不会每次都重贴链接。他说"1:1复刻"，指的就是上一轮那个页面。
 * 认出来就把上一轮的材料接上，否则模型手上空着，只能凭空编 ——
 * 表现就是做出来的东西和原页面完全不像。
 */
function looksLikeReferBack(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return /(复刻|还原|一模一样|一比一|1\s*[:：比]\s*1|照着|按照|按这个|照这个|和?这个一样|就这个|刚才(那个|的)|上面(那个|的)|前面(那个|的)|继续|再来一次|再试一次|重做|改一下它|它)/.test(t);
}

/**
 * 组装本次要给模型的联网材料。
 * 给了网址就抓那个页面；没给但明显需要新信息，就先搜一轮再抓最有用的两条。
 * 抓不到不抛错，只留一句说明，让模型知道它没看到。
 */
/**
 * 从粘贴进来的说明里认出组件名。
 * 这类文本开头一般写着「## Integrate the <ColorBends /> component」，
 * 或者有「### Component: ColorBends」。
 */
function detectComponentName(text) {
  const t = String(text || '');
  const m = t.match(/##\s*Integrate the <([A-Za-z][A-Za-z0-9]{1,40})\s*\/?>/)
    || t.match(/###\s*Component:\s*([A-Za-z][A-Za-z0-9]{1,40})/)
    || t.match(/Integrate the <([A-Za-z][A-Za-z0-9]{1,40})\s*\/?>/);
  return m ? m[1] : '';
}

/**
 * 判断这段文字是不是"只有说明书、没有实现"。
 * 有 import 语句但没出现 shader / 绘制逻辑，基本就是集成说明。
 */
function looksIntegrationOnly(text) {
  const t = String(text || '');
  if (!t) return false;
  const hasCodeHints = /(gl_FragColor|fragmentShader|vertexShader|createShader|uniform\s|ShaderMaterial|useFrame|requestAnimationFrame|getContext\()/.test(t);
  return !hasCodeHints;
}

/** 去服务端取组件真实源码（含 shader） */
async function fetchComponentSource(name) {
  try {
    const res = await fetch('api/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const j = await res.json();
    return j?.ok ? j : null;
  } catch {
    return null;
  }
}

async function gatherWebContext(text) {
  const urls = extractUrls(text);
  const parts = [];
  const images = [];
  let gotPrompt = false;

  if (urls.length) {
    for (const u of urls) {
      const page = await fetchPage(u);
      if (!page) {
        parts.push(`【网页抓取失败】${u}\n这个地址没抓到正文，可能要求登录、需要交互，或者站点拒绝了抓取。不要凭记忆编造它的内容。`);
        continue;
      }
      /* 顺序就是优先级：
         页面自带的「复制提示词 / 源码」最重要 —— 那是站点写给 AI 的说明书，
         里面有尺寸、颜色、动画参数、依赖，比看着截图猜准得多。
         正文第二，截图最后，只用来校对视觉。 */
      const bits = [`【网页】${page.title || page.url}`, `URL: ${page.url}`];

      if (page.prompt) {
        /* 分清两件事：
           「源码」是真实实现，照着移植就对得上；
           「集成说明」只写了怎么装、有哪些参数，里面没有实现代码 ——
           拿它当实现来读，只能照着参数名自己编，做出来必然走形。 */
        const looksLikeCode = /(import\s|export\s|function\s|const\s|useEffect|useRef|gl_FragColor|uniform\s|createShader|class\s)/.test(page.prompt);
        const isSource = looksLikeCode || /source|code|代码/i.test(page.promptKind || '');

        if (isSource) {
          bits.push(
            '',
            '【这个页面自带的真实实现代码 · 最高优先级】',
            '这是原组件的源码。直接按它移植（WebGL/Canvas 的 shader 原样搬过来），',
            '参数和默认值都照抄，不要自己另写一套近似效果：',
            page.prompt
          );
        } else {
          bits.push(
            '',
            '【这个页面自带的 AI 说明 · 注意，这不是实现】',
            '下面这段只是"怎么安装、怎么传参"的说明，里面没有实现代码。',
            '它能告诉你这个效果叫什么、有哪些参数，但拿不到内部算法。',
            '所以：不要照它编一个大概像的渐变，也不要拿 CSS 模糊冒充。',
            '要真的做出来，就自己写 WebGL 片元着色器实现同类效果，形态对照截图：',
            '光带要有清晰的走向和峰值、背景要压暗、颜色沿带子渐变，而不是一团糊掉的色块。',
            page.prompt
          );
        }
      }

      if (page.codeBlocks.length) {
        bits.push('', '【页面里的代码】');
        page.codeBlocks.forEach((b, i) => {
          bits.push(`--- 代码 ${i + 1} ---`, String(b).slice(0, 12000));
        });
      }

      if (page.content) bits.push('', '【页面正文】', page.content);

      if (page.image) {
        bits.push('', '（另附这个网页的截图。截图只用来校对视觉：主色、层次、密度、留白。实现细节以上面的提示词和代码为准。）');
        images.push(page.image);
      }

      parts.push(bits.join('\n'));
      if (page.prompt) gotPrompt = true;
    }
    // hasPrompt 给上层拼进度提示用（"已拿到页面自带提示词"）
    return { text: parts.join('\n\n---\n\n'), images, hasPrompt: gotPrompt };
  }

  if (!looksLikeSearchNeed(text)) return { text: '', images: [] };

  const hits = await searchWeb(text, 6);
  if (!hits.length) {
    return { text: '【联网搜索无结果】这次没搜到东西，说明你没拿到新的外部信息，不要编造来源。', images: [] };
  }

  // 搜索摘要信息量有限，挑最相关的两条把正文和图也抓下来
  const deep = [];
  const deepImages = [];
  for (const h of hits.slice(0, 2)) {
    if (!h.url) continue;
    const page = await fetchPage(h.url);
    if (page?.content) deep.push(`【网页原文】${page.title || h.title}\nURL: ${h.url}\n\n${page.content.slice(0, 8000)}`);
    if (page?.image) {
      deep.push(`（上面对应的网页另附截图，视觉细节以截图为准。）`);
      deepImages.push(page.image);
    }
  }

  const list = hits.map((h, i) => {
    const bits = [`${i + 1}. ${h.title}`, h.url];
    if (h.site) bits.push(`来源：${h.site}`);
    if (h.date) bits.push(`日期：${h.date}`);
    if (h.summary) bits.push(h.summary.slice(0, 600));
    return bits.join('\n');
  }).join('\n\n');

  return {
    text: `【联网搜索结果】关键词：${text.slice(0, 60)}\n\n${list}${deep.length ? '\n\n---\n\n' + deep.join('\n\n---\n\n') : ''}`,
    images: deepImages,
  };
}

/* ── 流式 ─────────────────────────────────────────────── */

async function streamChat(messages, onDelta, onReasoning) {
  const res = await fetch('api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, provider: readProvider() }),
  });
  if (!res.ok || !res.body) {
    let msg = `请求失败（${res.status}）`;
    let hint = '';
    try {
      const j = await res.json();
      msg = j.message || msg;
      hint = j.hint || '';
    } catch { /* ignore */ }
    // hint 是要怎么修，单独一行放在原错误下面
    throw new Error(hint ? `${msg}\n\n${hint}` : msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let think = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j;
      try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error(j.error.message || '模型报错');
      const d0 = j.choices?.[0]?.delta || {};
      // 有的服务商把思考放在 reasoning_content，有的放在 reasoning
      const rc = d0.reasoning_content || d0.reasoning;
      if (typeof rc === 'string' && rc) {
        think += rc;
        onReasoning?.(think);
      }
      const delta = d0.content;
      if (delta) { full += delta; onDelta?.(full); }
    }
  }
  return full;
}

/**
 * 从一段可能夹带解释文字的回复里取出一个 JSON 对象。
 *
 * 不能简单用「第一个 { 到最后一个 }」：模型经常连着吐两个对象，
 * 那样切出来的字符串会有两段内容，JSON.parse 就报
 * "Unexpected non-whitespace character after JSON at position N"。
 * 这里按括号配对扫描，跳过字符串里的括号，只切出第一个完整对象。
 */
function sliceFirstJsonObject(text) {
  const src = String(text || '');
  const start = src.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  // 没配平就当没取到，交给上层当"没返回补丁"处理
  return '';
}

function extractJson(text) {
  const src = String(text || '');

  // 优先认围栏代码块：模型通常把补丁包在 ```json 里
  const fence = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```|$)/g;
  let m, best = '';
  while ((m = fence.exec(src))) {
    if (m[1].includes('ops') || m[1].includes('{')) best = m[1];
  }
  if (best) {
    const one = sliceFirstJsonObject(best);
    return (one || best).trim();
  }

  return sliceFirstJsonObject(src);
}

/**
 * 模型没给补丁时，把它说的话整理成人能看的一小段。
 * 去掉代码块和残缺的 JSON 片段，剩下说明文字就够。
 */
function trimModelNoise(text) {
  const t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*$/g, ' ')
    .replace(/^[\s\S]*?\{"ops"/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 300);
}

/** 解析补丁；解析不了返回 null，绝不把解析器的英文原文丢给用户 */
function parseOps(text) {
  const js = extractJson(text);
  if (!js) return null;
  try {
    const p = JSON.parse(js);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/* ── 应用 JSON 补丁 ───────────────────────────────────── */

const GEOM_KEYS = ['x', 'y', 'w', 'h', 'rot', 'opacity', 'radius', 'z'];
const TEXT_KEYS = ['text', 'fs', 'fw', 'color', 'align', 'lh', 'ls', 'valign'];
const SHAPE_KEYS = ['shape', 'fill', 'grad'];
const MEDIA_KEYS = ['src', 'fit', 'name'];
const ANIM_KEYS = ['enter', 'loop', 'dur', 'delay', 'ease'];
const HTML_KEYS = ['html', 'css', 'js', 'interactive'];
const ALLOWED = new Set([...GEOM_KEYS, ...TEXT_KEYS, ...SHAPE_KEYS, ...MEDIA_KEYS, ...HTML_KEYS, 'anim']);

function sanitizeSet(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw)) {
    if (!ALLOWED.has(k)) continue;
    if (k === 'anim') {
      const a = raw.anim || {};
      const anim = {};
      ANIM_KEYS.forEach((ak) => { if (a[ak] !== undefined) anim[ak] = a[ak]; });
      if (Object.keys(anim).length) out.anim = { ...anim };
      continue;
    }
    const v = raw[k];
    if (v === null || v === undefined) continue;
    if (['x', 'y', 'w', 'h', 'rot', 'opacity', 'radius', 'z', 'fs', 'fw', 'lh', 'ls'].includes(k)) {
      const num = Number(v);
      if (Number.isFinite(num)) out[k] = num;
    } else {
      out[k] = v;
    }
  }
  if (typeof out.opacity === 'number') out.opacity = clamp(out.opacity, 0, 1);
  if (typeof out.w === 'number') out.w = Math.max(12, out.w);
  if (typeof out.h === 'number') out.h = Math.max(12, out.h);
  return out;
}

function applyOps(ops) {
  let changed = 0;
  const notes = [];

  /* 多画布之后，一条 op 可能指向别的画布（op.board 写明目标 id）。
     按画布分组，一组提交一次：撤销栈里是一次干净的操作，也不会互相覆盖。 */
  const groups = new Map();     // boardId|null -> ops[]
  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    const bid = typeof op.board === 'string' && store.boardById(op.board) ? op.board : null;
    if (!groups.has(bid)) groups.set(bid, []);
    groups.get(bid).push(op);
  }

  for (const [bid, list] of groups) {
    store.commit((p) => {
      for (const op of list) {
        if (op.action === 'update') {
          const n = p.nodes.find((x) => x.id === op.id);
          if (!n) continue;
          const set = sanitizeSet(op.set);
          for (const k of Object.keys(set)) {
            if (k === 'anim') n.anim = normalizeAnim({ ...(n.anim || {}), ...set.anim });
            else n[k] = set[k];
          }
          changed++;
        } else if (op.action === 'add') {
          const type = ['text', 'shape', 'image', 'video', 'html', 'embed'].includes(op.type) ? op.type : 'text';
          const props = sanitizeSet(op.props || op.set || {});
          const node = makeNode(type, props, p);
          p.nodes.push(node);
          changed++;
          // 只有画在当前这块上的新元素才顺手选中，别处的选中会让人莫名其妙
          if (!bid || bid === store.project.id) notes.push(node.id);
        } else if (op.action === 'background') {
          // 允许 agent 直接改画板背景：纯色 / 渐变 / 图片 / 实时 html
          const b = op.set || op.props || op.background || {};
          const next = { ...(p.background || {}) };
          if (typeof b.type === 'string' && ['color', 'gradient', 'image', 'html', 'video', 'svg'].includes(b.type)) {
            next.type = b.type;
          }
          ['value', 'dataUrl', 'fit', 'html', 'css', 'js', 'svg', 'mime'].forEach((k) => {
            if (typeof b[k] === 'string') next[k] = b[k].slice(0, 200000);
          });
          p.background = next;
          changed++;
        } else if (op.action === 'delete') {
          const before = p.nodes.length;
          p.nodes = p.nodes.filter((x) => x.id !== op.id);
          if (p.nodes.length < before) changed++;
        }
      }
    }, { boardId: bid });
  }

  canvas.render();
  syncInspector();
  if (notes.length) canvas.select(notes);
  return changed;
}

/* ── 右键指令菜单 ─────────────────────────────────────── */

/** 菜单当前指向的元素；= null 表示指向整块画布 */
function ctxTargets() {
  const sel = canvas.selectedNodes();
  return sel;
}

/* ── 对话线程 ─────────────────────────────────────────
   每个元素一条独立线程，'canvas' 是整体 AI 的那条。
   两个入口各读各的：右键菜单看当前元素，悬浮窗永远看整体。
   ─────────────────────────────────────────────────── */

const CANVAS_KEY = 'canvas';

/** 右键菜单/元素指令的线程 key：只选中一个元素时用它自己的 id */
function elementKey() {
  const sel = canvas.selectedNodes();
  return sel.length === 1 ? sel[0].id : CANVAS_KEY;
}

function threadMessages(key) {
  const t = store.project.threads || (store.project.threads = {});
  if (!Array.isArray(t[key])) t[key] = [];
  return t[key];
}

function pushMsg(role, text, key = CANVAS_KEY, extra = null) {
  const list = threadMessages(key);
  // at 是跨机合并的依据：两台机器的对话并起来要靠它排先后、判重复
  const item = { role, text, at: Date.now() };
  // 思考过程跟着这条回复一起存，刷新后还能展开看
  if (extra?.think) item.think = String(extra.think).slice(0, 8000);
  // 回复里带的图：要么是 data URL，要么是画布上那张图的地址
  if (extra?.image) item.img = String(extra.image).slice(0, 4 * 1024 * 1024);
  list.push(item);
  if (list.length > 80) list.shift();
  store.save();
}

/** 思考块：默认折叠，只有一行灰色小字，点开才看内容 */
function makeThinkBlock(think) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-think';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'ctx-think-head';
  const chars = String(think).replace(/\s/g, '').length;
  head.textContent = `思考 ${chars} 字 · 展开`;

  const body = document.createElement('div');
  body.className = 'ctx-think-body';
  body.textContent = think;

  head.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle('open');
    head.textContent = `思考 ${chars} 字 · ${open ? '收起' : '展开'}`;
  });

  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

/** 只渲染某一线程的对话；extra 是「正在改…」这种临时行 */
function paintThread(box, key, { limit = 60, empty = '' } = {}) {
  if (!box) return;
  const items = threadMessages(key)
    .filter((m) => m.role === 'me' || m.role === 'ai' || m.role === 'err')
    .slice(-limit);

  /* 内容没变就别重建。
     重建会清空 DOM，每条消息的入场动画重播一遍，看起来就是整块在闪；
     而且会把「正在思考…」那一行冲掉。 */
  const sig = items
    .map((m) => `${m.role}:${(m.text || '').length}:${m.think ? m.think.length : 0}`)
    .join('~') + `#${limit}#${empty.length}`;
  if (box.dataset.sig === sig && box.childElementCount > 0) return;
  box.dataset.sig = sig;

  box.innerHTML = '';
  if (!items.length) {
    if (empty) {
      const el = document.createElement('div');
      el.className = box.id === 'dockLog' ? 'dock-empty' : 'ctx-empty';
      el.textContent = empty;
      box.appendChild(el);
    }
    if (box.id === 'ctxLog') box.hidden = true;
    return;
  }
  if (box.id === 'ctxLog') box.hidden = false;

  items.forEach((it) => {
    // 思考块放在回复上方，默认收起，不占地方
    if (it.think) box.appendChild(makeThinkBlock(it.think));
    const el = document.createElement('div');
    el.className = 'ctx-line ' + it.role;
    el.textContent = it.text;

    // 带图回复：图挂在气泡里，点一下看原图
    if (it.img) {
      const fig = document.createElement('a');
      fig.className = 'ctx-img';
      fig.href = it.img;
      fig.target = '_blank';
      fig.rel = 'noopener';
      const im = document.createElement('img');
      im.src = it.img;
      im.alt = 'AI 发的图片';
      im.loading = 'lazy';
      fig.appendChild(im);
      el.appendChild(fig);
      el.classList.add('has-img');
    }

    box.appendChild(el);
  });
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

/** 悬浮窗永远显示整体线程；右键菜单显示当前元素（或整体）的线程 */
/**
 * 只改「正在思考…」那一行的文字，不动整个列表。
 * 思考增量来得很密，每次都重绘会让所有气泡闪个不停。
 * 返回 false 表示那一行还不存在，调用方再走完整渲染。
 */
function updatePendingText(text) {
  /* 只改发起这次对话的那个面板。
     以前两个面板一起改，整体对话在思考时，右键元素的窗口也会跳出"思考中…"，
     看起来像两边的对话串了。 */
  const sel = lastScope === CANVAS_KEY ? '#dockLog' : '#ctxLog';
  const box = $(sel);
  if (!box) return false;

  let hit = 0;
  box.querySelectorAll('.ctx-line.is-pending').forEach((el) => {
    if (el.textContent !== text) el.textContent = text;
    hit++;
  });
  return hit > 0;
}

function renderCtxLog(pending) {
  const ctxKey = elementKey();
  const ctxBox = $('#ctxLog');
  paintThread(ctxBox, ctxKey, {
    limit: 6,
    empty: '',
  });
  if (pending && ctxBox && !dockKeyActive()) {
    ctxBox.hidden = false;
    /* 已经有这一行就只改文字。
       删掉重建会让入场动画从头再播一遍，一秒十几次，看起来就是一直在闪。 */
    const cur = ctxBox.querySelector('.ctx-line.is-pending');
    if (cur) {
      if (cur.textContent !== pending.text) cur.textContent = pending.text;
      const want = `ctx-line ${pending.role} is-pending`;
      if (cur.className !== want) cur.className = want;
    } else {
      const el = document.createElement('div');
      el.className = 'ctx-line ' + pending.role + ' is-pending';
      el.textContent = pending.text;
      ctxBox.appendChild(el);
    }
    requestAnimationFrame(() => { ctxBox.scrollTop = ctxBox.scrollHeight; });
  }

  const dockBox = $('#dockLog');
  paintThread(dockBox, CANVAS_KEY, {
    limit: 60,
    empty: '问整体就行：排版、配色、文案、动效节奏。想只改一个元素，右键点它。',
  });
  if (pending && dockBox && dockKeyActive()) {
    const cur = dockBox.querySelector('.ctx-line.is-pending');
    if (cur) {
      if (cur.textContent !== pending.text) cur.textContent = pending.text;
      const want = `ctx-line ${pending.role} is-pending`;
      if (cur.className !== want) cur.className = want;
    } else {
      const el = document.createElement('div');
      el.className = 'ctx-line ' + pending.role + ' is-pending';
      el.textContent = pending.text;
      dockBox.appendChild(el);
    }
    requestAnimationFrame(() => { dockBox.scrollTop = dockBox.scrollHeight; });
  }

  // 内容变了高度就变，重新夹一次，别让面板长出屏幕
  requestAnimationFrame(placeCtx);
}

/** 这次发送是否由悬浮窗发起，决定 pending 行画在哪边 */
let lastScope = CANVAS_KEY;
function dockKeyActive() { return lastScope === CANVAS_KEY; }

function syncCtxHeader() {
  const sel = ctxTargets();
  const name = $('#ctxName');
  const kind = $('#ctxKind');

  if (sel.length === 1) {
    const n = sel[0];
    name.textContent = n.name || TYPE_LABEL[n.type] || '元素';
    kind.textContent = TYPE_LABEL[n.type] || n.type;
    kind.hidden = false;
  } else if (sel.length > 1) {
    name.textContent = `${sel.length} 个元素`;
    kind.textContent = '多选';
    kind.hidden = false;
  } else {
    name.textContent = '整块画布';
    kind.textContent = '画布';
    kind.hidden = false;
  }
  updatePlaceholder();
}

/* 常用动作：选中单个元素时给出对症的快捷操作 */
function renderCtxActs() {
  const box = $('#ctxActs');
  box.innerHTML = '';
  const sel = ctxTargets();
  const add = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-act ' + cls;
    b.textContent = label;
    b.onclick = () => { fn(); };
    box.appendChild(b);
  };

  if (sel.length === 1) {
    const n = sel[0];
    add('发送到 AI', () => $('#ctxText').focus());

    if (n.anim) {
      const loopOn = n.anim.loop && n.anim.loop !== 'none';
      add(loopOn ? '停止循环动效' : '加漂浮动效', () => {
        patchSelected({ anim: normalizeAnim({ ...n.anim, loop: loopOn ? 'none' : 'float', dur: 4000 }) });
        toast(loopOn ? '已停止循环动效' : '已加漂浮动效', 'good');
        renderCtxActs();
      });
    }
    if (n.type === 'html') {
      add('切成 hover 触发', () => {
        $('#btnHtmlHover').click();
        renderCtxActs();
      });
    }

    // 嵌入类元素：右键就能在「能改」和「能用」之间切，不用去找那个小按钮
    if (canvas.canToggleEmbed(n)) {
      const live = canvas.interactiveId === n.id;
      add(live ? '切回编辑（可拖动/可改）' : '切到嵌入（可点内部）', () => {
        toggleEmbedMode(n.id);
        renderCtxActs();
      });
    }
    add('复制一份', () => { canvas.duplicate(); closeCtx(); });
    add('置顶', () => {
      store.commit((p) => {
        const node = p.nodes.find((x) => x.id === n.id);
        if (node) node.z = p.nodes.reduce((m, x) => Math.max(m, x.z || 0), 0) + 1;
      });
      canvas.render();
      toast('已置顶');
    });
    add('删除', () => { canvas.removeSelected(); closeCtx(); }, 'danger');
  } else if (sel.length > 1) {
    add('排成一行', () => arrangeRow(sel));
    add('竖向堆叠', () => arrangeColumn(sel));
    add('左对齐', () => alignNodes(sel, 'left'));
    add('水平居中', () => alignNodes(sel, 'center'));
    add('删除这些', () => { canvas.removeSelected(); closeCtx(); }, 'danger');
  } else {
    add('整块导出', () => doExport());
    add('适应画布', () => canvas.fit());
  }
}

function arrangeRow(nodes) {
  const sorted = [...nodes].sort((a, b) => a.x - b.x);
  const gap = 24;
  const startX = sorted[0].x;
  const baseY = Math.min(...sorted.map((n) => n.y));
  let cursor = startX;
  store.commit((p) => {
    sorted.forEach((n) => {
      const node = p.nodes.find((x) => x.id === n.id);
      if (!node) return;
      node.x = Math.round(cursor);
      node.y = Math.round(baseY);
      cursor += node.w + gap;
    });
  });
  canvas.render();
  toast('已排成一行');
}

function arrangeColumn(nodes) {
  const sorted = [...nodes].sort((a, b) => a.y - b.y);
  const gap = 24;
  const startY = sorted[0].y;
  const baseX = Math.min(...sorted.map((n) => n.x));
  let cursor = startY;
  store.commit((p) => {
    sorted.forEach((n) => {
      const node = p.nodes.find((x) => x.id === n.id);
      if (!node) return;
      node.x = Math.round(baseX);
      node.y = Math.round(cursor);
      cursor += node.h + gap;
    });
  });
  canvas.render();
  toast('已竖向堆叠');
}

function alignNodes(nodes, mode) {
  store.commit((p) => {
    if (mode === 'left') {
      const left = Math.min(...nodes.map((n) => n.x));
      nodes.forEach((n) => {
        const node = p.nodes.find((x) => x.id === n.id);
        if (node) node.x = Math.round(left);
      });
    } else {
      const center = (Math.min(...nodes.map((n) => n.x)) + Math.max(...nodes.map((n) => n.x + n.w))) / 2;
      nodes.forEach((n) => {
        const node = p.nodes.find((x) => x.id === n.id);
        if (node) node.x = Math.round(center - node.w / 2);
      });
    }
  });
  canvas.render();
  toast('已对齐');
}

/* 菜单生命周期 */

let ctxOpenedAt = 0;

/** 右键面板本次打开的落点，内容变化后据此重新定位 */
let ctxAnchor = { x: 0, y: 0 };

/**
 * 把面板夹进视口。
 * 面板内容会异步变长（对话、思考块），只靠打开时量一次高度，
 * 后面长高就会顶出屏幕 —— 表现就是「聊天框往上弹」。
 */
function placeCtx() {
  const menu = $('#ctx');
  if (!menu || menu.hidden) return;
  const pad = 10;
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x = ctxAnchor.x;
  let y = ctxAnchor.y;

  // 右边放不下就贴右
  if (x + rect.width + pad > vw) x = vw - rect.width - pad;
  // 下方放不下优先翻到上方；翻上去也放不下就直接贴顶，剩下的靠面板内部滚动
  if (y + rect.height + pad > vh) y = ctxAnchor.y - rect.height;
  if (y < pad) y = pad;
  if (y + rect.height + pad > vh) y = Math.max(pad, vh - rect.height - pad);

  menu.style.left = Math.max(pad, x) + 'px';
  menu.style.top = Math.max(pad, y) + 'px';
}

function openCtx(clientX, clientY) {
  const menu = $('#ctx');
  menu.hidden = false;
  menu.classList.remove('closing');

  syncCtxHeader();
  renderCtxActs();
  renderCtxLog();

  // 记住这次打开的落点，之后内容变长时据此重新夹位
  ctxAnchor = { x: clientX, y: clientY };
  placeCtx();

  ctxOpenedAt = Date.now();
  const input = $('#ctxText');
  input.value = '';
  autoGrow(input);
  // 让用户能立刻开始打字
  setTimeout(() => input.focus(), 30);
}

function closeCtx() {
  const menu = $('#ctx');
  if (menu.hidden) return;
  menu.classList.add('closing');
  setTimeout(() => {
    menu.hidden = true;
    menu.classList.remove('closing');
  }, 150);
}

/* 悬浮窗：整体对话入口，和右键菜单共用同一份历史 */

function setDockState(next) {
  const dock = $('#dock');
  if (!dock) return;
  dock.dataset.state = next;
  const btn = $('#dockToggle');
  if (btn) btn.textContent = next === 'open' ? '–' : '+';
  if (next === 'open') {
    renderCtxLog();
    // 展开后高度才确定，要等两帧再滚，否则算出来还是 0，看上去停在最早那条
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const b = $('#dockLog');
      if (b) b.scrollTop = b.scrollHeight;
    }));
    setTimeout(() => $('#dockText')?.focus(), 60);
  }
}

function openDock() {
  setDockState('open');
}

function toggleDock() {
  const dock = $('#dock');
  if (!dock) return;
  setDockState(dock.dataset.state === 'open' ? 'closed' : 'open');
}

/** 标题栏上的焦点提示：当前选中什么，就能一眼看出这条指令作用于谁 */
function syncDockFocus() {
  const chip = $('#dockFocus');
  if (!chip) return;
  const sel = canvas.selectedNodes();
  if (sel.length === 1) {
    chip.hidden = false;
    chip.textContent = sel[0].name || TYPE_LABEL[sel[0].type] || '元素';
  } else if (sel.length > 1) {
    chip.hidden = false;
    chip.textContent = `${sel.length} 个`;
  } else {
    chip.hidden = true;
  }
}

/**
 * scope: 'canvas' = 整体 AI（悬浮窗），'auto' = 跟着当前选中走（右键菜单）
 * 每个作用域有自己的线程，历史互不串台。
 */
async function send(text, scope = 'auto') {
  if (state.busy) return;
  const query = String(text || '').trim();
  if (!query) return;
  if (state.config && !state.config.hasKey) {
    if (scope !== 'canvas') closeCtx();
    return openSheet('cfg');
  }

  // 线程 key 在发送瞬间定下来，中途改选中也不会把回复写到别的线程
  const key = scope === 'canvas' ? CANVAS_KEY : elementKey();
  lastScope = key;

  // 清空触发这次发送的那个输入框（右键菜单或悬浮窗）
  ['#ctxText', '#dockText'].forEach((sel) => {
    const el = $(sel);
    if (el) { el.value = ''; autoGrow(el); }
  });

  pushMsg('me', query, key);
  renderCtxLog();
  setBusy(true);

  // 让用户看得见这次用了哪些技能，避免「它到底按什么规则改的」说不清
  try {
    const hits = matchSkills(query, readEnabledSkills());
    if (hits.length) toast('技能：' + hits.map((s) => s.name).join(' · '));
  } catch { /* 技能库异常不影响主流程 */ }

  const pending = { role: 'ai', text: '正在改…' };
  renderCtxLog(pending);

  // 有网址或明显需要新信息时，先去网上取真实内容。
  // 模型本身不联网，不给它材料它只能瞎猜 —— 这正是"给网址却做不出来"的原因。
  let webContext = { text: '', images: [] };
  try {
    const hasUrl = extractUrls(query).length > 0;
    const needsSearch = looksLikeSearchNeed(query);

    if (hasUrl || needsSearch) {
      pending.text = hasUrl ? '正在读取网页，顺便截图…' : '正在联网搜索…';
      renderCtxLog(pending);
      webContext = await gatherWebContext(query);
      if (!webContext.text && !webContext.images.length) {
        pending.text = '网页没读到内容，继续按现有信息处理…';
        renderCtxLog(pending);
      } else {
        // 存下来：下一句"1:1复刻"这种话要能接住，不用再让用户贴一次链接
        state.lastWeb[key] = { ...webContext, at: Date.now() };
        const bits = [];
        if (webContext.hasPrompt) bits.push('页面自带提示词');
        if (webContext.images.length) bits.push(`截图 ${webContext.images.length} 张`);
        pending.text = bits.length ? `已拿到${bits.join(' + ')}，正在理解…` : '已拿到网页内容，正在理解…';
        renderCtxLog(pending);
      }
    } else if (looksLikeReferBack(query) && state.lastWeb[key]) {
      /* 用户没给链接，但话里有"复刻 / 这个 / 刚才"这类指代。
         这时候他指的是上一轮那个网页，把材料接着用上，
         否则模型手上什么都没有，只能瞎猜 —— 那就是 p2 完全不像 p1 的原因。 */
      webContext = state.lastWeb[key];
      pending.text = '沿用上一次读到的那个网页…';
      renderCtxLog(pending);
    }
  } catch { /* 联网失败不阻塞作图 */ }

  /* ── 贴进来的说明 → 补真实源码 ────────────────────────────
     用户常常直接把页面上的「Copy prompt」粘进来。那段只是
     "装哪个包、传哪些参数"的说明，没有实现代码 ——
     照着它写只能凭参数名编一个近似渐变，这就是"完全不像"的来源。

     所以这里认出组件名，去公开仓库把真实现取回来，一起交给模型。 */
  try {
    const pastedName = detectComponentName(query);
    if (pastedName && looksIntegrationOnly(query) && !webContext.source) {
      pending.text = `认出这是 ${pastedName} 的说明，正在取它的真实源码…`;
      renderCtxLog(pending);

      const src = await fetchComponentSource(pastedName);
      if (src?.code) {
        webContext = { ...webContext, source: src };
        pending.text = `已取到 ${pastedName} 源码 ${(src.code.length / 1024).toFixed(1)}KB，照着移植`;
      } else {
        pending.text = `没找到 ${pastedName} 的源码，只能自己写 shader，形态对照截图`;
      }
      renderCtxLog(pending);
    }
  } catch { /* 取不到不影响主流程 */ }

  /* 先把这一轮的图压好。buildMessages 是同步的，压缩要等解码，
     所以必须在进循环之前算完；重试时直接复用，不重复压。 */
  try {
    const vis = await prepareVision(key);
    if (vis.length) {
      pending.text = `已准备好 ${vis.length} 张图，正在看…`;
      renderCtxLog(pending);
    }
  } catch { /* 图处理失败不阻塞文字指令 */ }

  /* ── 自愈循环 ────────────────────────────────────────────
     一句话交代意图之后，失败不该原样丢回给用户。
     这里最多试三次：每次把上一次的失败原因带回去，
     让模型这一次直接给可执行的东西。
     只要有产出就停；三次都不成才报错。 */
  const MAX_ATTEMPTS = 3;
  let lastFail = '';
  let lastSaid = '';

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        pending.text = `第 ${attempt} 次尝试 · 上次：${lastFail}`;
        renderCtxLog(pending);
        await new Promise((r) => setTimeout(r, 600 * (attempt - 1)));
      }

      try {
        const out = await runAttempt({ query, key, webContext, attempt, lastFail, pending });
        if (out.ok) {
          renderCtxLog();
          renderCtxActs();
          syncCtxHeader();
          return;
        }
        lastFail = out.reason || '没有产出改动';
        if (out.said) lastSaid = out.said;
      } catch (err) {
        lastFail = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 120);
        // 只有"等一等可能就好"的错才重试；配置错了重试也没意义
        const retriable = /network|fetch|502|503|504|timeout|超时|upstream|rate|preflight|连不上|稍后再试/i.test(lastFail);
        if (!retriable) {
          pushMsg('err', lastFail, key);
          renderCtxLog();
          return;
        }
      }
    }

    /* 它有话要说就别用红色错误把它盖掉。
       "想一下配色"这种本来就只要建议，不该显示成故障。 */
    if (lastSaid) {
      pushMsg('ai', lastSaid, key);
      toast('这次只给了建议，没有改画布');
    } else {
      pushMsg('err', `试了 ${MAX_ATTEMPTS} 次都没成：${lastFail}`, key);
    }
    renderCtxLog();
  } finally {
    // 图已经交给模型了，缩略图留着会让人以为下一句还会带上
    state.attached[key] = [];
    if (state.visionReady) delete state.visionReady[key];
    try { renderAttach(key); } catch { /* 面板可能已关 */ }
    setBusy(false);
    store.save();
  }
}

/**
 * 一次完整尝试：发消息 → 收流 → 解补丁 → 应用 → 落库。
 * 不抛业务错误，只把结果和失败原因交给外层决定要不要再来一次。
 */
async function runAttempt({ query, key, webContext, attempt, lastFail, pending }) {
  const retryHint = attempt > 1 && lastFail
    ? `上一次尝试失败：${lastFail}。这次不要再解释，直接输出完整的 {"ops":[...]}。`
    : '';

  const messages = buildMessages(query, key, webContext, retryHint);

  // 补丁只能应用一次，否则同一个 add 会加两遍
  let applied = false;
  let changed = 0;
  let thinkSoFar = '';
  let lastThinkPaint = 0;

  const full = await streamChat(messages, (partial) => {
    if (applied) return;
    const parsed = parseOps(partial);
    if (parsed?.ops?.length) {
      applied = true;
      changed = applyOps(parsed.ops);
      pushMsg('ai', parsed.say || `已更新 ${changed} 个元素`, key, { think: thinkSoFar });
      renderCtxLog();
    }
  }, (think) => {
    thinkSoFar = think;
    if (applied) return;
    pending.text = `思考中… ${think.replace(/\s/g, '').length} 字`;
    const now = Date.now();
    if (now - lastThinkPaint < 90) return;
    lastThinkPaint = now;
    if (!updatePendingText(pending.text)) renderCtxLog(pending);
  });

  const parsed = parseOps(full) || { ops: [], say: trimModelNoise(full) };
  const ops = Array.isArray(parsed.ops) ? parsed.ops : [];

  if (!applied && ops.length) {
    applied = true;
    changed = applyOps(ops);
  }

  const said = String(parsed.say || '').trim();
  const imgOut = pickReplyImage(parsed);
  const thread = threadMessages(key);
  const last = thread[thread.length - 1];
  const alreadySaid = Boolean(last && last.role === 'ai');

  if (changed > 0) {
    if (!alreadySaid) pushMsg('ai', said || `已更新 ${changed} 个元素`, key, { think: thinkSoFar, image: imgOut });
    return { ok: true, changed };
  }

  /* 只发图不动作，也算完成。
     用户说"把这张图发我"，本来就不该要求它改画布。 */
  if (imgOut) {
    if (!alreadySaid) pushMsg('ai', said || '给你这张图', key, { think: thinkSoFar, image: imgOut });
    return { ok: true, changed: 0 };
  }

  /* 需要动手却没动手 —— 这就是失败，要带着原因再来一次。
     纯提问则相反：给了实质回答就算完成。 */
  if (detectTaskKind(query) === 'action') {
    return {
      ok: false,
      said,
      reason: said ? `只回了话没改画布：${said.slice(0, 50)}` : '没有输出可用的 ops',
    };
  }

  if (said) {
    if (!alreadySaid) pushMsg('ai', said, key, { think: thinkSoFar, image: imgOut });
    return { ok: true, changed: 0 };
  }

  return { ok: false, reason: '模型没有返回内容' };
}

/** 粗判这句是要动手改画布，还是在问事情 */
function detectTaskKind(text) {
  const t = String(text || '').trim();
  if (/[？?]\s*$/.test(t)) return 'ask';

  /* 只有"明确要动手"的说法才算改画布。
     像"整体想一下配色""看看这个配色怎么样"，本来只要一句话建议，
     以前却按"必须改画布"处理，模型只回话就被判失败并重试三次 ——
     用户看到的就是「试了 3 次都没成」。 */
  const actPhrase = /(改成|换成|调成|设为|设置为|调整成|加一个|加个|删掉|去掉|移走|放大到|缩小到|排成|排一下|复刻|还原成|套用|做成|弄成|生成一个|来一个)/;
  if (actPhrase.test(t)) return 'action';

  const askWord = /(想一下|想想|看一下|看看|说说|讲一下|聊一下|意见|建议|推荐|思路|方案|方向|分析|评估|评价|怎么样|如何|怎么办|为什么|是什么|能不能|可不可以|行不行|有没有|哪个好|好不好|是否|合适吗|可以吗)/;
  if (askWord.test(t)) return 'ask';

  // 有动词但没明确要求，也先当询问：宁可少改，不要瞎改
  return 'ask';
}

function setBusy(on) {
  state.busy = on;
  // 两个入口共用一次请求，所以两边都要锁
  ['#ctxSend', '#dockSend'].forEach((sel) => {
    const b = $(sel);
    if (b) b.disabled = on;
  });
  ['#ctxText', '#dockText'].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = on;
  });
  $('#ctxDot')?.classList.toggle('busy', on);
  $('#dockDot')?.classList.toggle('busy', on);
  $('#dockDot')?.classList.toggle('on', !on && Boolean(state.config?.hasKey));
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 96) + 'px';
}

/* ── 配置 ─────────────────────────────────────────────── */

/* 模型配置跟着账号走：存在服务端，换浏览器或换设备登录后自动带出来。
   浏览器里只留一份内存缓存，不放 Key；请求时也不必再带 Key。 */
let accountProvider = null;

/** 本次会话里用户临时输入的 Key。已存到账号的配置不需要它。 */
function readProvider() {
  return state.draftProvider || null;
}

function writeProvider(p) {
  state.draftProvider = p && p.apiKey ? p : null;
}

/** 老版本把 Key 存在浏览器里。这里做一次性搬家：搬到账号，再从浏览器删掉。 */
async function migrateLocalProvider() {
  const LEGACY = 'qboard.provider.v1';
  let old = null;
  try {
    const raw = localStorage.getItem(LEGACY);
    if (raw) old = JSON.parse(raw);
  } catch { return null; }
  if (!old || !old.baseUrl || !old.apiKey) return null;
  try {
    const acct = await fetch('api/provider').then((r) => (r.ok ? r.json() : null));
    // 账号里已经有配置就不覆盖，只把浏览器里的旧 Key 清掉
    if (!acct?.configured) {
      await saveProviderToAccount({
        baseUrl: old.baseUrl,
        apiKey: old.apiKey,
        model: old.model || 'deepseek-chat',
        temperature: typeof old.temperature === 'number' ? old.temperature : 0.75,
      });
    }
    localStorage.removeItem(LEGACY);
    return acct?.configured ? 'kept-account' : 'migrated';
  } catch {
    return null;   // 迁移失败就先留着，下次再试
  }
}

async function fetchProvider() {
  try {
    const res = await fetch('api/provider');
    if (!res.ok) return null;
    const j = await res.json();
    // 没配 Key 时也要把 baseUrl / 模型名带回来：
    // 面板得先显示出「上次填的是什么」，用户只需补一个 Key。
    accountProvider = j || null;
    return accountProvider;
  } catch {
    return null;
  }
}

async function saveProviderToAccount(p) {
  const res = await fetch('api/provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || `保存失败（${res.status}）`);
  accountProvider = j && j.configured ? j : null;
  return accountProvider;
}

function maskKey(k) {
  if (!k) return '';
  return k.length <= 10 ? '••••••' : `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

async function loadConfig() {
  let presets = [];
  let appId = 'qboard';
  try {
    const res = await fetch('api/meta');
    const meta = await res.json();
    presets = meta.presets || [];
    appId = meta.appId || appId;
  } catch { /* 离线也允许继续编辑画布 */ }

  await migrateLocalProvider();
  const acct = await fetchProvider();
  state.config = {
    presets,
    appId,
    hasKey: Boolean(acct?.configured),
    needsKey: Boolean(acct && acct.configured === false),
    user: acct?.user || '',
    baseUrl: acct?.baseUrl || '',
    model: acct?.model || '',
    temperature: acct?.temperature ?? 0.75,
    keyMask: acct?.keyMask || '',
  };
  const chip = $('#modelChip');
  const c = state.config;
  if (c.hasKey) {
    chip.className = 'model-chip ok';
    chip.textContent = `${c.model} · 已接入`;
  } else if (c.baseUrl) {
    chip.className = 'model-chip warn';
    chip.textContent = '还差 API Key';
  } else {
    chip.className = 'model-chip warn';
    chip.textContent = '未配置 API';
  }
}

/** 把配置写进面板字段 */
function fillCfgForm(c) {
  const cfg = c || {};
  $('#cfgBase').value = cfg.baseUrl || '';
  $('#cfgModel').value = cfg.model || '';
  $('#cfgKey').value = '';
  $('#cfgKey').placeholder = cfg.keyMask
    ? `已保存 ${cfg.keyMask} · 留空则沿用`
    : 'sk-... 保存后跟着账号走，换设备自动带出';
  $('#cfgTemp').value = cfg.temperature ?? 0.75;
  $('#tempVal').textContent = (cfg.temperature ?? 0.75).toFixed(2);
}

/** 打开面板时拉一次最新配置，拉到了就覆盖表单 */
async function refreshCfgPanel() {
  const before = $('#cfgBase').value;
  await loadConfig();
  const c = state.config || {};
  // 用户已经开始手填了就别覆盖，免得把输入冲掉
  if ($('#cfgBase').value !== before && before) return;
  fillCfgForm(c);
}

function openSheet(which) {
  $$('.sheet').forEach((s) => s.classList.remove('show'));
  $$('.sheet-mask').forEach((m) => m.classList.remove('show'));

  if (which === 'cfg') {
    const c = state.config || {};
    // 先用缓存垫一下，避免面板闪空
    fillCfgForm(c);
    $('#cfgFoot').textContent = '';
    $('#cfgFoot').className = 'sheet-foot';

    const box = $('#presets');
    box.innerHTML = '';
    (c.presets || []).forEach((p) => {
      const b = document.createElement('button');
      b.textContent = p.label;
      if (p.baseUrl === c.baseUrl) b.classList.add('on');
      b.onclick = () => {
        $('#cfgBase').value = p.baseUrl;
        $('#cfgModel').value = p.model;
        $$('#presets button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
      box.appendChild(b);
    });

    renderSkillGrid();
    $('#cfgSheet').classList.add('show');
    $('#sheetMask').classList.add('show');

    // 关键：每次打开都问服务端要最新配置。
    // 只看启动时那份缓存，换设备或别处改过之后这里会显示成空的。
    refreshCfgPanel();
  } else {
    renderBgPresets();
    renderBgLive();
    const bg = store.project.background;
    $('#bgColor').value = bg.value?.startsWith('#') ? bg.value : '#ffffff';
    $('#bgGrad').value = bg.type === 'gradient' ? bg.value : '';
    $('#bgFoot').textContent = '';
    $('#bgSheet').classList.add('show');
    $('#sheetMask').classList.add('show');
  }
}

function closeSheets() {
  $$('.sheet').forEach((s) => s.classList.remove('show'));
  $$('.sheet-mask').forEach((m) => m.classList.remove('show'));
}

/** 用当前填的 Key 问服务商要模型列表，避免手猜模型名 */
async function fetchModels() {
  const btn = $('#btnFetchModels');
  const hint = $('#modelHint');
  const baseUrl = $('#cfgBase').value.trim();
  const apiKey = $('#cfgKey').value.trim();

  hint.className = 'sheet-hint';
  if (!baseUrl || !apiKey) {
    hint.className = 'sheet-hint bad';
    hint.textContent = '先填 Base URL 和 API Key';
    return;
  }

  btn.disabled = true;
  hint.textContent = '正在拉取…';

  try {
    const res = await fetch('api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    const data = await res.json();

    if (data.warning) {
      hint.className = 'sheet-hint bad';
      hint.textContent = data.warning + '。模型名请在服务商后台查一下，直接手填即可。';
    }

    const list = $('#modelList');
    list.innerHTML = '';
    const models = data.models || [];
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    });

    if (!models.length) {
      if (!data.warning) {
        hint.className = 'sheet-hint bad';
        hint.textContent = '这个 Key 没返回任何模型，检查一下是不是有权限。';
      }
      return;
    }

    hint.className = 'sheet-hint';
    hint.textContent = `拿到 ${models.length} 个模型，点输入框可下拉选`;

    // 列表只是参考：别名常常不在列表里却真的能用，所以这里不下结论
    const cur = $('#cfgModel').value.trim();
    if (cur && !models.includes(cur)) {
      hint.className = 'sheet-hint';
      hint.textContent = `列表里没有「${cur}」。这不代表不能用 —— 别名常常不在列表里。点「测试这个模型」真发一次请求确认。`;
    }
  } catch (err) {
    hint.className = 'sheet-hint bad';
    hint.textContent = `拉取失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/** 真发一次最小请求，确认这个模型在这个服务商上到底能不能用 */
async function testModel() {
  const btn = $('#btnTestModel');
  const hint = $('#modelHint');
  const baseUrl = $('#cfgBase').value.trim();
  const apiKey = $('#cfgKey').value.trim();
  const model = $('#cfgModel').value.trim();

  hint.className = 'sheet-hint';
  if (!baseUrl || !apiKey || !model) {
    hint.className = 'sheet-hint bad';
    hint.textContent = 'Base URL、API Key、模型名都要先填上';
    return;
  }

  btn.disabled = true;
  hint.textContent = `正在用「${model}」发一个测试请求…`;

  try {
    const res = await fetch('api/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, model }),
    });
    const r = await res.json();

    if (r.ok) {
      hint.className = 'sheet-hint';
      hint.style.color = 'var(--accent)';
      hint.textContent = `能用。模型回了「${r.reply || '（空）'}」，可以保存了。`;
    } else {
      hint.className = 'sheet-hint bad';
      hint.style.color = '';
      hint.textContent = [r.hint, r.message && `上游原文：${r.message}`].filter(Boolean).join('　');
    }
  } catch (err) {
    hint.className = 'sheet-hint bad';
    hint.textContent = `测试失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/** 从一堆模型名里猜一个「通用对话」用的，优先带 chat/turbo/pro 这类字眼 */
function pickLikelyModel(models) {
  const prefers = [/chat/i, /turbo/i, /plus/i, /pro/i, /instruct/i, /large/i];
  for (const re of prefers) {
    const hit = models.find((m) => re.test(m) && !/embed|vision|image|audio|tts|whisper|rerank/i.test(m));
    if (hit) return hit;
  }
  return models.find((m) => !/embed|image|audio|tts|whisper|rerank/i.test(m)) || models[0] || '';
}

async function saveConfig() {
  const foot = $('#cfgFoot');
  const baseUrl = $('#cfgBase').value.trim();
  const model = $('#cfgModel').value.trim();
  const apiKey = $('#cfgKey').value.trim();
  const temperature = Number($('#cfgTemp').value);
  const already = Boolean(state.config?.keyMask);

  foot.className = 'sheet-foot';
  if (!baseUrl || !model) {
    foot.className = 'sheet-foot bad';
    foot.textContent = 'Base URL 和模型名要填';
    return;
  }
  // 已经存过 Key 的账号，留空就是沿用原来那个
  if (!apiKey && !already) {
    foot.className = 'sheet-foot bad';
    foot.textContent = '第一次接入要填 API Key';
    return;
  }

  foot.textContent = '正在测试连接…';
  $('#cfgSave').disabled = true;

  try {
    // 先存到账号，再拿这份配置真发一次请求确认能用
    await saveProviderToAccount({ baseUrl, apiKey, model, temperature });
    const probe = { baseUrl, model, temperature };
    let ok = true;
    try { await testProvider(probe); } catch { ok = false; }
    state.draftProvider = null;
    $('#cfgKey').value = '';
    await loadConfig();
    if (ok) {
      foot.className = 'sheet-foot ok';
      foot.textContent = '连接正常，已存到这个账号，换设备登录会自动带出来';
      setTimeout(closeSheets, 900);
    } else {
      foot.className = 'sheet-foot bad';
      foot.textContent = '已存到账号，但测试请求没通：检查 Key、Base URL 或余额';
    }
  } catch (err) {
    foot.className = 'sheet-foot bad';
    foot.textContent = err.message;
  } finally {
    $('#cfgSave').disabled = false;
  }
}

/** 用一句话探一下上游是否可达；不读正文，避免白花 token */
async function testProvider(provider) {
  try {
    const res = await fetch('api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.message || `HTTP ${res.status}`);
      err.hint = j.hint || '';
      throw err;
    }
    await res.body?.cancel?.();
    return true;
  } catch (err) {
    throw err;
  }
}

/* ── 导出 ─────────────────────────────────────────────── */

/**
 * 一键导出：整个项目合成一个 HTML。
 * 多块画布时顶部带切换栏，导出的文件双击就能看全部，不用一块块导。
 */
function doExportProject() {
  const total = store.boards.reduce((n, b) => n + (b.nodes || []).length, 0);
  if (!total) return toast('画布还是空的', 'bad');

  const html = buildProjectHtml(store.doc, store.project.id);
  const name = 'qboard';
  const multi = store.boards.length > 1;
  const file = multi ? `${name}-全部画布.html` : `${name}.html`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(multi ? `已导出 ${store.boards.length} 块画布 → ${file}` : `已导出 ${file}`, 'good');
}

/** 只导当前这一块画布（右键菜单里用） */
function doExport() {
  if (!store.project.nodes.length) return toast('画布还是空的', 'bad');
  const html = buildExportHtml(store.project);
  const name = 'qboard';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已导出 ${name}.html`, 'good');
}

function previewExport() {
  const html = buildExportHtml(store.project);
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

/* ── 预览模式：动效全开，HTML 内部可交互 ──────────────── */

let previewOn = false;

function togglePreview(force) {
  const next = typeof force === 'boolean' ? force : !previewOn;
  previewOn = next;

  const btn = $('#btnPreview');
  const hint = $('#hint');
  const app = $('#app');

  canvas.setPreview(next);
  if (next) {
    canvas.select([]);
    document.activeElement?.blur?.();
    btn.classList.add('primary');
    btn.textContent = '■ 退出预览';
    if (hint) hint.textContent = '预览中：动效和 HTML 交互都在跑，点这里或按 Esc 退出';
    app?.classList.add('previewing');
  } else {
    btn.classList.remove('primary');
    btn.textContent = '▶ 预览';
    canvas.exitInteractive();
    if (hint) hint.textContent = '拖文件进来 · 双击编辑文字 · 空格拖动画面 · ⌘滚轮缩放';
    app?.classList.remove('previewing');
  }
  store.save();
  return next;
}

/* ── 事件绑定 ─────────────────────────────────────────── */

function bind() {
  installKeyframes();

  /* 工具栏 */
  $$('.rail .tool[data-tool]').forEach((b) => {
    b.onclick = () => {
      const tool = b.dataset.tool;
      $$('.rail .tool[data-tool]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.tool = tool;

      if (tool === 'text') { addText(); resetTool(); }
      else if (tool === 'shape') { addShape(); resetTool(); }
      else if (tool === 'image') { $('#filePicker').click(); resetTool(); }
      else if (tool === 'html') {
        const id = addNode('html', { ...defaultSpot(560, 350), w: 560, h: 350 });
        toast('HTML 片段已放入，可在右侧替换内容');
        resetTool();
        void id;
      }
    };
  });

  function resetTool() {
    state.tool = 'select';
    $$('.rail .tool[data-tool]').forEach((x) => x.classList.toggle('active', x.dataset.tool === 'select'));
  }

  $('#btnFit').onclick = () => canvas.fit();
  $('#zoomIn').onclick = () => canvas.setZoom(canvas.view.zoom * 1.2);
  $('#zoomOut').onclick = () => canvas.setZoom(canvas.view.zoom / 1.2);

  /* 文件选择 */
  $('#filePicker').onchange = async (e) => {
    await importFiles(e.target.files);
    e.target.value = '';
  };
  $('#mediaPicker').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const sel = canvas.selectedNodes()[0];
    if (!sel) return;
    if (f.type.startsWith('video/')) {
      const { src } = await probeVideoSize(f);
      patchSelected({ src, name: f.name });
    } else if (/\.html?$/.test(f.name)) {
      patchSelected({ html: await f.text(), name: f.name });
    } else {
      const { src } = await importBitmap(f);
      patchSelected({ src, mime: f.type, name: f.name });
    }
    syncInspector();
  };
  $('#btnReplace').onclick = () => $('#mediaPicker').click();

  /* 拖放 */
  let depth = 0;
  const stage = dom.stage;
  ['dragenter', 'dragover'].forEach((ev) => {
    stage.addEventListener(ev, (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      if (ev === 'dragenter') depth++;
      stage.classList.add('dragover');
    });
  });
  stage.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--depth <= 0) { depth = 0; stage.classList.remove('dragover'); }
  });
  stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    stage.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const p = canvas.toBoard(e.clientX, e.clientY);
    await importFiles(files, p);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* 粘贴 */
  window.addEventListener('paste', async (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      await importFiles(files);
      return;
    }
    const text = e.clipboardData?.getData('text')?.trim();
    if (text && text.length > 1) {
      e.preventDefault();
      const w = 420;
      const h = Math.max(48, Math.min(320, Math.ceil(text.length / 26) * 30 + 16));
      addNode('text', { ...defaultSpot(w, h), w, h, text, fs: 20, fw: 400, lh: 1.6 });
      toast('已从剪贴板放入文字', 'good');
    }
  });

  /* 键盘 */
  document.addEventListener('keydown', (e) => {
    canvas.keydown(e);
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); doExport(); }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); previewExport(); }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const sel = canvas.selectedNodes();
      if (!sel.length) {
        // 没选中 = 整体对话，直接开悬浮窗
        openDock();
        return;
      }
      // 选中了 = 元素级，贴着它弹右键菜单
      const host = $('#viewport').getBoundingClientRect();
      const b = sel.length === 1
        ? { x: sel[0].x, y: sel[0].y, w: sel[0].w, h: sel[0].h }
        : { x: Math.min(...sel.map((n) => n.x)), y: Math.min(...sel.map((n) => n.y)), w: 0, h: 0 };
      // 多画布是同页纵向堆叠的，活动画布在 world 里有偏移，换算时要带上
      const off = canvas.activeOffset();
      const px = host.left + canvas.view.panX + (off.x + b.x + b.w / 2) * canvas.view.zoom;
      const py = host.top + canvas.view.panY + (off.y + b.y + b.h) * canvas.view.zoom + 12;
      openCtx(px, py);
    }
    if (e.key === 'v' || e.key === 'V') resetTool();
    if (e.key === 't' || e.key === 'T') { addText(); resetTool(); }
    if (e.key === 'r' || e.key === 'R') { addShape(); resetTool(); }
    if (e.key === '1' && e.shiftKey) { canvas.fit(); }
  });
  document.addEventListener('keyup', (e) => canvas.keyup(e));

  /* 属性面板 */
  $('#inspName').addEventListener('change', (e) => patchSelected({ name: e.target.value }));
  $('#inspDel').onclick = () => { canvas.removeSelected(); syncInspector(); };

  const numBind = (id, key) => {
    const el = $(id);
    liveBind(el, (input) => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      patchSelected({ [key]: key === 'w' || key === 'h' ? Math.max(12, v) : v }, { commit: false });
    });
    el.addEventListener('blur', () => {
      store.settleSnapshot();
      canvas.render();
    });
  };
  numBind('#px', 'x'); numBind('#py', 'y'); numBind('#pw', 'w'); numBind('#ph', 'h');
  numBind('#prot', 'rot'); numBind('#pz', 'z');

  liveBind($('#pop'), (el) => {
    $('#popVal').textContent = Math.round(Number(el.value) * 100) + '%';
    patchSelected({ opacity: Number(el.value) }, { commit: false });
  });
  liveBind($('#prad'), (el) => {
    $('#pradVal').textContent = el.value;
    patchSelected({ radius: Number(el.value) }, { commit: false });
  });

  liveBind($('#ptext'), (el) => patchSelected({ text: el.value }, { commit: false }));
  liveBind($('#pfs'), (el) => patchSelected({ fs: Number(el.value) }, { commit: false }));
  $('#pfw').addEventListener('change', (e) => patchSelected({ fw: Number(e.target.value) }));
  liveBind($('#pcolor'), (el) => patchSelected({ color: el.value }, { commit: false }));
  $('#palign').addEventListener('change', (e) => patchSelected({ align: e.target.value }));
  liveBind($('#plh'), (el) => patchSelected({ lh: Number(el.value) }, { commit: false }));
  liveBind($('#pls'), (el) => patchSelected({ ls: Number(el.value) }, { commit: false }));

  $('#pshape').addEventListener('change', (e) => patchSelected({ shape: e.target.value }));
  liveBind($('#pfill'), (el) => patchSelected({ fill: el.value }, { commit: false }));
  liveBind($('#pgrad'), (el) => patchSelected({ grad: el.value }, { commit: false }));

  /* HTML 元素：直接编辑代码 */
  const applyHtmlCode = () => {
    const sel = canvas.selectedNodes()[0];
    if (!sel || sel.type !== 'html') return;
    patchSelected({
      html: $('#phtmlHtml').value,
      css: $('#phtmlCss').value,
      js: $('#phtmlJs').value,
    });
    toast('代码已应用', 'good');
  };
  $('#btnHtmlApply').onclick = applyHtmlCode;
  $('#btnHtmlHover').onclick = () => {
    const sel = canvas.selectedNodes()[0];
    if (!sel || sel.type !== 'html') return toast('先选一个 HTML 元素', 'bad');
    const css = (sel.css || '').replace(/@keyframes[\s\S]*?\}\s*\}/g, '');
    const cleaned = css
      .replace(/animation\s*:[^;}]*;?/gi, '')
      .replace(/animation-name\s*:[^;}]*;?/gi, '')
      .replace(/animation-duration\s*:[^;}]*;?/gi, '');
    const hover = `${cleaned}\n/* hover 版：去掉定时动画，改为鼠标移入触发 */\n*{transition:filter .28s ease,box-shadow .28s ease}\nbody:hover *{filter:brightness(1.25)}\nbody:hover{box-shadow:inset 0 0 0 2px rgba(184,246,90,.56)}`;
    patchSelected({ css: hover, js: '' });
    syncInspector();
    toast('已切成 hover 触发，可以再让 AI 细调', 'good');
  };
  ['#phtmlHtml', '#phtmlCss', '#phtmlJs'].forEach((s) => {
    $(s).addEventListener('focus', () => store.captureSnapshot());
    $(s).addEventListener('blur', () => store.settleSnapshot());
  });

  const animPatch = () => {
    const sel = canvas.selectedNodes()[0];
    if (!sel) return;
    patchSelected({
      anim: normalizeAnim({
        enter: $('#pmEnter').value,
        loop: $('#pmLoop').value,
        dur: Number($('#pmDur').value),
        delay: Number($('#pmDelay').value),
        ease: $('#pmEase').value,
      }),
    });
  };
  ['#pmEnter', '#pmLoop', '#pmEase'].forEach((s) => $(s).addEventListener('change', animPatch));
  ['#pmDur', '#pmDelay'].forEach((s) => {
    liveBind($(s), () => {});
    $(s).addEventListener('change', animPatch);
    $(s).addEventListener('blur', () => { store.settleSnapshot(); animPatch(); });
  });
  $('#btnReplay').onclick = () => {
    const sel = canvas.selectedNodes();
    if (!sel.length) return toast('先选一个元素', 'bad');
    sel.forEach((n) => canvas.replay(n.id));
    toast('重播动效');
  };

  /* 画板尺寸 */
  $('#artSize').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    store.commit((p) => { p.artboard = { w, h }; });
    canvas.render();
    canvas.fit();
  });

  bindEmbedToggle();
  bindAttachInputs();

  /* 顶栏 */
  // 顶栏「导出」= 一键导出整个项目（所有画布一个文件）
  $('#btnExport').onclick = doExportProject;
  $('#btnPreview').onclick = togglePreview;
  $('#btnConfig').onclick = () => openSheet('cfg');
  $('#modelChip').onclick = () => openSheet('cfg');
  $('#btnBg').onclick = () => openSheet('bg');
  $('#btnUndo').onclick = () => { if (store.undo()) { canvas.render(); syncInspector(); } };
  $('#btnRedo').onclick = () => { if (store.redo()) { canvas.render(); syncInspector(); } };

  // 顶栏「＋」：在当前画布下面直接加一块，同一页里往下就能看到
  $('#boardQuickNew').onclick = (e) => {
    e.stopPropagation();
    addBoardBelow(store.project.id);
  };

  // 工作台切换器：点开是列表，底部是「新建独立工作台」
  $('#wsBtn').onclick = (e) => {
    e.stopPropagation();
    const menu = $('#wsMenu');
    if (!menu) return;
    if (menu.hidden) openWorkspaceMenu(); else closeWorkspaceMenu();
  };
  $('#wsNew').onclick = (e) => {
    e.stopPropagation();
    addWorkspace();
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#wsPick')) closeWorkspaceMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWorkspaceMenu();
  });

  // 每块画布底下那个「在这块下面加一块」
  canvas.onAddBoardAfter = (boardId) => addBoardBelow(boardId);

  // 点中别块画布的内容后，那块变成当前画布：面板跟着换，视野不动
  canvas.onBoardSwitched = () => {
    renderLayers();
    syncInspector();
    syncBoardUI();
    renderCtxLog();
    syncDockFocus();
    updatePlaceholder();
  };

  /* 退出登录 */
  $('#btnLogout').onclick = async () => {
    try { await fetch('api/logout', { method: 'POST' }); } catch { /* 忽略 */ }
    location.reload();
  };

  /* 抽屉 */
  $('#sheetMask').onclick = closeSheets;
  $('#cfgCancel').onclick = closeSheets;
  $('#cfgSave').onclick = saveConfig;
  $('#btnFetchModels').onclick = fetchModels;
  $('#btnSkillsAll').onclick = () => {
    const all = SKILLS.map((sk) => sk.id);
    const cur = readEnabledSkills();
    writeEnabledSkills(cur.length === all.length ? [] : all);
    renderSkillGrid();
  };
  $('#btnTestModel').onclick = testModel;
  $('#cfgTemp').oninput = (e) => { $('#tempVal').textContent = Number(e.target.value).toFixed(2); };

  $('#bgColor').addEventListener('input', (e) => {
    store.commit((p) => { p.background = { ...p.background, type: 'color', value: e.target.value }; }, { silent: true });
    canvas.render();
  });
  $('#bgGrad').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    store.commit((p) => {
      p.background = v ? { ...p.background, type: 'gradient', value: v } : { ...p.background, type: 'color' };
    });
    canvas.render();
    $('#bgFoot').textContent = v ? '渐变已应用' : '已切回纯色';
  });
  $('#bgUpload').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    // 图片、视频、SVG、HTML 片段都能当背景
    inp.accept = 'image/*,video/*,.svg,.html,.htm';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const foot = $('#bgFoot');
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      try {
        if (f.type.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) {
          const src = await readAsDataUrl(f);
          store.commit((p) => {
            p.background = { type: 'video', value: '', dataUrl: src, fit: 'cover', mime: f.type || 'video/mp4' };
          });
          canvas.render();
          renderBgLive();
          foot.className = 'sheet-foot ok';
          foot.textContent = '视频背景已设置：会循环静音播放';
        } else if (ext === 'svg' || f.type === 'image/svg+xml') {
          const text = await f.text();
          store.commit((p) => {
            p.background = { type: 'svg', value: '', svg: text, fit: 'cover', mime: 'image/svg+xml' };
          });
          canvas.render();
          renderBgLive();
          foot.className = 'sheet-foot ok';
          foot.textContent = 'SVG 背景已设置：里面的动画会照常跑';
        } else if (ext === 'html' || ext === 'htm') {
          const text = await f.text();
          const parts = splitHtmlDoc(text);
          store.commit((p) => {
            p.background = {
              type: 'html',
              value: '#0d0d12',
              html: parts.html,
              css: parts.css,
              js: parts.js,
              fit: 'cover',
            };
          });
          canvas.render();
          renderBgLive();
          foot.className = 'sheet-foot ok';
          foot.textContent = 'HTML 背景已设置：脚本和动效都会运行';
        } else {
          const { src, fit } = await importBitmap(f, 2000);
          store.commit((p) => {
            p.background = { type: 'image', value: '', dataUrl: src, fit: fit || 'cover', mime: f.type };
          });
          canvas.render();
          renderBgLive();
          foot.className = 'sheet-foot ok';
          foot.textContent = '图片背景已设置';
        }
      } catch (err) {
        foot.className = 'sheet-foot bad';
        foot.textContent = '这个文件读不了：' + err.message;
      }
    };
    inp.click();
  };
  $('#bgClear').onclick = () => {
    store.commit((p) => { p.background = { type: 'color', value: '#ffffff', dataUrl: '', fit: 'cover' }; });
    canvas.render();
    $('#bgFoot').textContent = '背景已清除';
    $('#bgFoot').className = 'sheet-foot';
  };

  /* 右键指令菜单 */
  $('#ctxClose').onclick = closeCtx;

  const ctxText = $('#ctxText');
  ctxText.addEventListener('input', () => autoGrow(ctxText));
  ctxText.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeCtx(); return; }
    // 回车直接发；要换行按 Shift+Enter。和悬浮窗保持一致，
    // 免得用户在两处遇到不同的键位习惯。
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send(ctxText.value);
    }
  });
  $('#ctxForm').addEventListener('submit', (e) => {
    e.preventDefault();
    send(ctxText.value);
  });
  // 菜单内部点击不该被「点外面就关」的逻辑吃掉
  $('#ctx').addEventListener('pointerdown', (e) => e.stopPropagation());

  /* 悬浮 AI 窗口 */
  $('#dockBar').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    toggleDock();
  });
  $('#dockToggle').onclick = (e) => { e.stopPropagation(); toggleDock(); };
  $('#dockClear').onclick = (e) => {
    e.stopPropagation();
    // 只清整体这条线程，元素各自的对话不受影响
    store.project.threads[CANVAS_KEY] = [];
    store.save();
    renderCtxLog();
    toast('整体对话已清空');
  };

  const dockText = $('#dockText');
  dockText.addEventListener('input', () => autoGrow(dockText));
  dockText.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); dockText.blur(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      // 悬浮窗里回车直接发，换行用 Shift+Enter
      e.preventDefault();
      send(dockText.value, 'canvas');
    }
  });
  $('#dockForm').addEventListener('submit', (e) => {
    e.preventDefault();
    send(dockText.value, 'canvas');
  });

  /* 右键：选中被点的元素并就地弹菜单 */
  dom.viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (canvas.preview) return;

    const nodeEl = e.target.closest('.node');
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      // 右键一个没选中的元素，就直接切到它；已在多选里则保留多选
      if (!canvas.selection.has(id)) canvas.select(id);
    } else if (!e.shiftKey) {
      // 空白处右键 = 针对整块画布
      canvas.select([]);
    }
    openCtx(e.clientX, e.clientY);
  });

  /* 点菜单外面、滚轮、开始拖拽都关掉菜单 */
  document.addEventListener('pointerdown', (e) => {
    if ($('#ctx').hidden) return;
    if (e.target.closest('#ctx')) return;
    closeCtx();
  }, true);

  dom.viewport.addEventListener('wheel', () => {
    if (!$('#ctx').hidden) closeCtx();
  }, { passive: true });

  /* 窗口 */
  window.addEventListener('resize', () => canvas.applyView());
}

/* ── 启动 ─────────────────────────────────────────────── */

(async function init() {
  // 偏好要在渲染之前拿到：技能开关和上次的缩放位置都靠它
  await loadPrefs();
  await store.load();

  // 视图动了就记进账号偏好（savePrefs 内部有 500ms 防抖）
  canvas.onViewChange = (v) => savePrefs({ view: { zoom: v.zoom, panX: v.panX, panY: v.panY } });

  store.on((project, reason) => {
    $('#btnUndo').disabled = !store.canUndo;
    $('#btnRedo').disabled = !store.canRedo;
    if (reason === 'workspace') {
      refreshAfterWorkspaceChange();
      return;
    }
    if (reason === 'board') {
      refreshAfterBoardChange();
      return;
    }
    if (reason === 'undo' || reason === 'redo') {
      syncBoardUI();
      if (!$('#ctx').hidden) { renderCtxLog(); syncCtxHeader(); renderCtxActs(); }
    }
  });

  syncBoardUI();
  syncWorkspaceUI();

  bind();
  canvas.render();
  // 换设备登录时把上次停留的缩放位置也还原，而不是一进来就跳回适应窗口
  const savedView = PREFS.data.view;
  if (savedView && Number.isFinite(savedView.zoom)) {
    Object.assign(canvas.view, savedView);
    canvas.applyView();
  } else {
    canvas.fit();
  }
  renderLayers();
  renderCtxLog();
  syncDockFocus();
  setDockState('closed');
  updatePlaceholder();
  $('#btnUndo').disabled = true;
  $('#btnRedo').disabled = true;

  await loadConfig();
  if (!state.config?.hasKey) {
    setTimeout(() => {
      toast('先接入 API Key，agent 才能改画布', 'bad');
      openSheet('cfg');
    }, 800);
  }

  // 调试入口
  window.__qboard = { store, canvas, send, importFiles, applyOps, buildMessages, buildExportHtml, buildProjectHtml, doExport, doExportProject, toggleEmbedMode };
})();
