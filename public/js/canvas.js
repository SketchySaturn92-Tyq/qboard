/**
 * canvas.js — 画布引擎
 * 平移缩放、拖拽、8 向缩放、旋转、吸附对齐、框选、行内文字编辑。
 * 坐标约定：节点的 x/y/w/h 都是画板（artboard）内的像素，旋转以中心为轴。
 */

import { animationValue } from './anim.js';
import { fragUrl } from './frag.js';

const SNAP_PX = 6;
const MIN_SIZE = 12;

/** 一块画布在页面里的 DOM：标题 + 画板 + 画板内的各层 */
const BLOCK_INNER = `
  <div class="artboard-bg"></div>
  <div class="layer"></div>
  <div class="guides"></div>
  <div class="sel-overlay" hidden>
    <div class="sel-box"></div>
    <span class="sel-label"></span>
    <div class="handle" data-h="nw"></div>
    <div class="handle" data-h="n"></div>
    <div class="handle" data-h="ne"></div>
    <div class="handle" data-h="e"></div>
    <div class="handle" data-h="se"></div>
    <div class="handle" data-h="s"></div>
    <div class="handle" data-h="sw"></div>
    <div class="handle" data-h="w"></div>
    <div class="rot-handle" title="旋转">⟳</div>
    <button class="embed-toggle" type="button" hidden></button>
  </div>
  <div class="marquee" hidden></div>
  <div class="board-empty"><span>空画布 · 从左边加素材，或直接在下面让 AI 生成</span></div>
`;

export class Canvas {
  constructor({ store, dom }) {
    this.store = store;
    this.dom = dom;
    this.view = { zoom: 1, panX: 0, panY: 0 };

    this.els = new Map();          // "boardId|nodeId" -> element
    this.blocks = new Map();       // boardId -> { block, artboard, bg, layer, guides, overlay, marquee }
    this.selection = new Set();    // id（仅当前画布）
    this.editing = null;           // id 正在行内编辑
    this.preview = false;
    this.interactiveId = null;     // 正在把鼠标事件交给内部的 HTML 元素

    this.drag = null;
    this.spaceDown = false;
    this.suspended = false;

    /* 多画布之后，同一套「画板 / 背景 / 图层 / 辅助线 / 选中框 / 框选框」
       在每块画布下各有一份。这里把 dom 上那几个旧键改成活动画布的取值器，
       老代码里写 this.dom.selOverlay 之类的地方不用逐行改，自动指向当前画布。 */
    const live = (pick) => ({ configurable: true, get: () => this.cur[pick] || null });
    Object.defineProperties(dom, {
      artboard: live('artboard'),
      artboardBg: live('bg'),
      layer: live('layer'),
      guides: live('guides'),
      selOverlay: live('overlay'),
      marquee: live('marquee'),
    });

    this._bind();
  }

  /** 节点元素在各自画布里的 key＝画布 id + 节点 id，避免两块画布同 id 打架 */
  elOf(nodeId, boardId) {
    return this.els.get(this.keyOf(boardId || this.project.id, nodeId)) || null;
  }

  get project() { return this.store.project; }
  get nodes() { return this.project.nodes; }
  get boards() { return this.store.boards || []; }

  keyOf(boardId, nodeId) { return `${boardId}|${nodeId}`; }

  nodeById(id) {
    const here = this.nodes.find((n) => n.id === id);
    if (here) return here;
    for (const b of this.boards) {
      const hit = (b.nodes || []).find((n) => n.id === id);
      if (hit) return hit;
    }
    return null;
  }

  boardById(id) { return this.boards.find((b) => b.id === id) || null; }

  /** 取某块画布的 DOM 记录；没有就说明还没建 */
  blockOf(boardId) { return this.blocks.get(boardId) || null; }

  /** 当前正在编辑的那块画布对应的 DOM */
  get cur() {
    return this.blockOf(this.project.id) || { artboard: null, bg: null, layer: null, guides: null, overlay: null, marquee: null };
  }

  /** 建一块画布的 DOM（没有就建，有就复用），并按顺序插到 world 里 */
  ensureBlock(board, index) {
    let bd = this.blocks.get(board.id);
    if (!bd) {
      const block = document.createElement('div');
      block.className = 'board-block';
      block.dataset.board = board.id;

      const artboard = document.createElement('div');
      artboard.className = 'artboard';
      artboard.dataset.board = board.id;
      artboard.innerHTML = BLOCK_INNER;

      // 每块画布底下都带一个「在这下面加一块」，加出来的就贴着它
      const foot = document.createElement('div');
      foot.className = 'board-block-foot';
      const add = document.createElement('button');
      add.className = 'board-block-add';
      add.type = 'button';
      add.textContent = '＋ 在这块画布下面加一块';
      add.title = '在同一页里，紧贴这块画布下方再加一块';
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onAddBoardAfter?.(board.id);
      });
      foot.appendChild(add);

      block.appendChild(artboard);
      block.appendChild(foot);

      bd = {
        block, artboard, foot,
        bg: artboard.querySelector('.artboard-bg'),
        layer: artboard.querySelector('.layer'),
        guides: artboard.querySelector('.guides'),
        overlay: artboard.querySelector('.sel-overlay'),
        marquee: artboard.querySelector('.marquee'),
      };
      this.blocks.set(board.id, bd);
    }

    // 顺序跟 store.boards 一致
    const want = this.dom.world.children[index] || null;
    if (want !== bd.block) this.dom.world.insertBefore(bd.block, want);

    bd.block.classList.toggle('is-active', board.id === this.project.id);
    return bd;
  }

  /** 指针落在哪块画布上：优先看元素归属，其次看所在的画板 */
  boardOf(el) {
    if (!el || !el.closest) return null;
    const nodeEl = el.closest('.node');
    if (nodeEl && nodeEl.dataset.board) return nodeEl.dataset.board;
    const artEl = el.closest('.artboard');
    return artEl && artEl.dataset.board ? artEl.dataset.board : null;
  }

  /** 点中别的画布上的内容时，把那块切成当前画布。
      只换活动状态，不滚视野、不清高亮位置，之后照常走选中逻辑。 */
  activateBoard(boardId) {
    if (!boardId || boardId === this.project.id) return false;
    if (!this.store.boards.some((b) => b.id === boardId)) return false;
    this.store.doc.activeBoardId = boardId;
    this.store.save();
    this.els.forEach((el) => el.classList.remove('is-selected'));
    this.selection.clear();
    this.interactiveId = null;
    for (const [id, bd] of this.blocks) bd.block.classList.toggle('is-active', id === boardId);
    this.onBoardSwitched?.(boardId);
    return true;
  }

  /* ── 视图变换 ──────────────────────────────────────── */

  applyView() {
    const { zoom, panX, panY } = this.view;
    this.dom.world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const z = this.dom.zoomVal;
    if (z) z.textContent = Math.round(zoom * 100) + '%';
    // 视图变了就通知外层存进账号偏好，换设备登录能回到同一处
    if (typeof this.onViewChange === 'function') this.onViewChange(this.view);
  }

  /** 活动画布在 world 里的偏移（画板本地像素）。多画布纵向堆叠后，
      节点坐标仍然是「画板内坐标」，屏幕换算要先减掉这段偏移。 */
  activeOffset() {
    const bd = this.blockOf(this.project.id);
    if (!bd || !bd.artboard) return { x: 0, y: 0 };
    const r = bd.artboard.getBoundingClientRect();
    const w = this.dom.world.getBoundingClientRect();
    const z = this.view.zoom || 1;
    return { x: (r.left - w.left) / z, y: (r.top - w.top) / z };
  }

  /** 屏幕坐标 → 活动画布的画板坐标 */
  toBoard(clientX, clientY) {
    const r = this.dom.viewport.getBoundingClientRect();
    const off = this.activeOffset();
    return {
      x: (clientX - r.left - this.view.panX) / this.view.zoom - off.x,
      y: (clientY - r.top - this.view.panY) / this.view.zoom - off.y,
    };
  }

  zoomAt(factor, clientX, clientY) {
    const r = this.dom.viewport.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const before = {
      x: (px - this.view.panX) / this.view.zoom,
      y: (py - this.view.panY) / this.view.zoom,
    };
    const next = clamp(this.view.zoom * factor, 0.05, 8);
    this.view.zoom = next;
    this.view.panX = px - before.x * next;
    this.view.panY = py - before.y * next;
    this.applyView();
  }

  setZoom(z) {
    const r = this.dom.viewport.getBoundingClientRect();
    this.zoomAt(z / this.view.zoom, r.left + r.width / 2, r.top + r.height / 2);
  }

  /** 让当前画布铺满视野；多画布堆叠后要减掉它在 world 里的偏移 */
  fit() {
    const { w, h } = this.project.artboard;
    const r = this.dom.viewport.getBoundingClientRect();
    const pad = 56;
    const zoom = clamp(Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h), 0.05, 2);
    const off = this.activeOffset();     // 以画板本地像素表示，与 zoom 无关
    this.view.zoom = zoom;
    this.view.panX = (r.width - w * zoom) / 2 - off.x * zoom;
    this.view.panY = (r.height - h * zoom) / 2 - off.y * zoom;
    this.applyView();
  }

  /** 把某块画布滚到视野中间（点标签、新建之后用） */
  scrollToBoard(boardId) {
    const bd = this.blockOf(boardId);
    if (!bd) return;
    const r = this.dom.viewport.getBoundingClientRect();
    const z = this.view.zoom || 1;
    const ar = bd.artboard.getBoundingClientRect();
    const wr = this.dom.world.getBoundingClientRect();
    const off = { x: (ar.left - wr.left) / z, y: (ar.top - wr.top) / z };
    const bw = bd.artboard.offsetWidth || 1440;
    const bh = bd.artboard.offsetHeight || 900;
    this.view.panX = (r.width - bw * z) / 2 - off.x * z;
    this.view.panY = (r.height - bh * z) / 2 - off.y * z;
    this.applyView();
  }

  /* ── 渲染 ──────────────────────────────────────────── */

  /** 画全部画布：每块画布在 world 里纵向排开，各自一层节点 */
  render() {
    const boards = this.boards;
    const alive = new Set();

    boards.forEach((board, i) => {
      const bd = this.ensureBlock(board, i);
      const nodes = board.nodes || [];

      for (const n of nodes) {
        const key = this.keyOf(board.id, n.id);
        alive.add(key);
        let el = this.els.get(key);
        if (!el) {
          el = document.createElement('div');
          el.className = 'node';
          el.dataset.id = n.id;
          el.dataset.board = board.id;
          this.els.set(key, el);
          bd.layer.appendChild(el);
        }
        this.paint(n, el);
      }

      // 顺序对齐 z
      const sorted = [...nodes].sort((a, b) => (a.z || 0) - (b.z || 0));
      sorted.forEach((n, idx) => {
        const el = this.els.get(this.keyOf(board.id, n.id));
        if (el) el.style.zIndex = String(n.z || idx + 1);
      });

      const ab = board.artboard || { w: 1440, h: 900 };
      bd.artboard.style.width = ab.w + 'px';
      bd.artboard.style.height = ab.h + 'px';
      bd.block.classList.toggle('is-empty', nodes.length === 0);
      this.paintBackground(bd, board);
    });

    // 画布被删掉了，它底下的节点也一起撤
    for (const [key, el] of this.els) {
      if (!alive.has(key)) {
        el.remove();
        this.els.delete(key);
      }
    }
    for (const [id, bd] of this.blocks) {
      if (!this.boards.some((b) => b.id === id)) {
        bd.block.remove();
        this.blocks.delete(id);
      }
    }

    for (const bd of this.blocks.values()) {
      bd.block.classList.toggle('is-active', bd.block.dataset.board === this.project.id);
    }

    this.updateOverlay();
  }

  paintBackground(bd, board) {
    const bg = (board || this.project).background || {};
    const box = bd.bg;
    if (!box) return;
    box.style.background = '';
    box.style.backgroundImage = '';

    // 背景可以是：纯色 / 渐变 / 图片 / 视频 / SVG（带 SMIL 动画）/ HTML 实时片段
    // 非纯 CSS 的那几种都挂成真实元素，切换类型时要先清掉上一个
    if (bg.type === 'html' && (bg.html || bg.css || bg.js)) {
      box.style.background = '#0d0d12';
      this.clearBgMedia(box, 'iframe');
      this.hydrateBackground(bd, bg);
      return;
    }

    if (bg.type === 'video' && bg.dataUrl) {
      box.style.background = '#0b0b0e';
      this.clearBgMedia(box, 'iframe');
      this.hydrateVideo(bd, bg);
      return;
    }

    if (bg.type === 'svg' && bg.svg) {
      box.style.background = '#0b0b0e';
      this.clearBgMedia(box, 'video');
      this.hydrateSvg(bd, bg);
      return;
    }

    // 纯 CSS 类型：把动态媒体摘掉
    this.clearBgMedia(box);
    box.dataset.bgSig = '';

    if (bg.type === 'image' && bg.dataUrl) {
      box.style.background = `#0b0b0e center/cover no-repeat url("${bg.dataUrl}")`;
      box.style.backgroundSize = bg.fit || 'cover';
    } else if (bg.type === 'gradient' && bg.value) {
      box.style.background = gradientCss(bg.value) || bg.value;
    } else {
      box.style.background = bg.value || '#ffffff';
    }
  }

  /** 清掉背景里的媒体元素；只清指定标签时保留另一个 */
  clearBgMedia(box, only) {
    box.querySelectorAll('iframe.bg-live, video.bg-media').forEach((el) => {
      if (only && el.tagName.toLowerCase() !== only) return;
      el.remove();
    });
  }

  /** 视频背景：静音循环自动播放，不吃鼠标事件 */
  hydrateVideo(bd, bg) {
    const box = bd.bg;
    if (!box) return;
    let v = box.querySelector('video.bg-media');
    if (!v) {
      v = document.createElement('video');
      v.className = 'bg-media';
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.playsInline = true;
      v.setAttribute('muted', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('disablepictureinpicture', '');
      v.style.objectFit = bg.fit || 'cover';
      box.appendChild(v);
    }
    if (v.getAttribute('src') !== bg.dataUrl) v.setAttribute('src', bg.dataUrl);
    v.style.objectFit = bg.fit || 'cover';
    const p = v.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拦就停着，不报错 */ });
  }

  /** SVG 背景走 iframe，这样内部 SMIL 动画能真的跑 */
  async hydrateSvg(bd, bg) {
    const box = bd.bg;
    if (!box) return;
    const css = 'html,body{margin:0;height:100%;overflow:hidden;background:transparent}svg{width:100%;height:100%;display:block}';
    const sig = `svg|${bg.svg.length}`;
    if (box.dataset.bgSig === sig && box.querySelector('iframe.bg-live')) return;
    box.dataset.bgSig = sig;
    const url = await fragUrl(bg.svg, css, '');
    if (box.dataset.bgSig !== sig) return;
    let f = box.querySelector('iframe.bg-live');
    if (!f) {
      f = document.createElement('iframe');
      f.className = 'bg-live';
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      f.setAttribute('tabindex', '-1');
      f.setAttribute('aria-hidden', 'true');
      box.appendChild(f);
    }
    f.setAttribute('src', url);
  }

  /** 把动态背景挂进画板底层；内容没变就不重载，避免一直闪 */
  async hydrateBackground(bd, bg) {
    const box = bd.bg;
    if (!box) return;
    const sig = `${(bg.html || '').length}|${(bg.css || '').length}|${(bg.js || '').length}`;
    if (box.dataset.bgSig === sig && box.querySelector('iframe.bg-live')) return;
    box.dataset.bgSig = sig;
    const url = await fragUrl(bg.html || '', bg.css || '', bg.js || '');
    if (box.dataset.bgSig !== sig) return;
    let f = box.querySelector('iframe.bg-live');
    if (!f) {
      f = document.createElement('iframe');
      f.className = 'bg-live';
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      f.setAttribute('tabindex', '-1');
      f.setAttribute('aria-hidden', 'true');
      box.appendChild(f);
    }
    f.setAttribute('src', url);
  }

  paint(n, el) {
    el.dataset.type = n.type;
    el.className = 'node' + (n.hidden ? ' is-hidden' : '') +
      (this.selection.has(n.id) ? ' is-selected' : '') +
      (n.locked ? ' is-locked' : '');

    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = n.w + 'px';
    el.style.height = n.h + 'px';
    el.style.transform = n.rot ? `rotate(${n.rot}deg)` : '';
    el.style.opacity = n.opacity ?? 1;
    el.style.borderRadius = (n.radius || 0) + 'px';
    el.style.zIndex = String(n.z || 1);

    // 动效：编稿时保持静止，预览或重播时才挂
    el.style.animation = '';
    el.classList.remove('anim-on');
    if (this.preview && !this.editing) this.applyAnim(n, el);
    else if (el.dataset.replay === '1') this.applyAnim(n, el);

    const sig = [
      n.type, n.shape || '', (n.src || '').length,
      (n.html || '').length, (n.css || '').length, (n.js || '').length,
      n.text || '', n.ext || '',
    ].join('|');
    const inner = el.querySelector('.node-inner');
    if (!inner || el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      const box = inner || document.createElement('div');
      box.className = 'node-inner';
      box.innerHTML = this.innerHtml(n);
      if (!inner) el.appendChild(box);
      if (n.type === 'file') this.fillTextFile(n, box);
      if (n.type === 'html') this.hydrateHtmlFrame(n, box);
    }

    this.paintInnerStyles(n, el);
  }

  paintInnerStyles(n, el) {
    const inner = el.querySelector('.node-inner');
    if (!inner) return;
    inner.style.borderRadius = 'inherit';

    if (n.type === 'text') {
      inner.style.fontSize = n.fs + 'px';
      inner.style.fontWeight = n.fw;
      inner.style.color = n.color;
      inner.style.textAlign = n.align;
      inner.style.lineHeight = n.lh;
      inner.style.letterSpacing = (n.ls || 0) + 'px';
      inner.style.alignContent = n.valign === 'middle' ? 'center' : n.valign === 'bottom' ? 'end' : 'start';
      const t = inner.querySelector('.t');
      if (t && t.textContent !== n.text && this.editing !== n.id) t.textContent = n.text;
    }
    if (n.type === 'shape') {
      inner.style.background = n.grad ? gradientCss(n.grad) || n.fill : n.fill;
      inner.style.borderRadius = n.shape === 'ellipse' ? '9999px' : 'inherit';
    }
    if (n.type === 'image' || n.type === 'video') {
      const media = inner.firstElementChild;
      if (media) {
        media.style.objectFit = n.fit || 'cover';
        media.style.borderRadius = 'inherit';
      }
    }
    if (n.type === 'html' || n.type === 'embed' || n.type === 'file') {
      // 只有预览模式或显式切到「嵌入」才把鼠标交给内部，编稿时保持可拖动。
      // embed 以前漏了这一段，iframe 默认吃鼠标，导致右键点不到、也拖不动 ——
      // 表现就是"莫名其妙融入进去改不了"。
      const live = this.preview || this.interactiveId === n.id;
      inner.style.pointerEvents = live ? 'auto' : 'none';
    }
  }

  innerHtml(n) {
    switch (n.type) {
      case 'text':
        return `<div class="t">${escapeHtml(n.text || '')}</div>`;
      case 'shape':
        return '<div class="fill"></div>';
      case 'image':
        return n.src
          ? `<img src="${n.src}" alt="" draggable="false" />`
          : '<div class="media-missing">图片丢失</div>';
      case 'video': {
        if (!n.src) return '<div class="media-missing">视频丢失</div>';
        /* 编辑态只留一帧做参考，不自动播放：
           十几个视频同时播会卡，而且鼠标要给拖动，不该被播放器吃掉。 */
        const auto = this.preview && n.autoplay ? 'autoplay' : '';
        return `<video src="${n.src}" ${n.loop ? 'loop' : ''} ${n.muted ? 'muted' : ''} ${auto} playsinline
          preload="${this.preview ? 'metadata' : 'metadata'}" data-preview="${this.preview ? '1' : '0'}"></video>`;
      }
      case 'audio':
        return n.src
          ? `<div class="audio-card"><span class="audio-icon">♪</span><div class="audio-meta"><b>${escapeHtml(n.name || '音频')}</b><audio src="${n.src}" controls preload="none" ${n.loop ? 'loop' : ''} data-preview="${this.preview ? '1' : '0'}"></audio></div></div>`
          : '<div class="media-missing">音频丢失</div>';
      case 'html':
        // src 由 hydrateHtmlFrame 异步补上；不用 srcdoc 是为了不被父页 CSP 限制
        return `<iframe class="html-frame" sandbox="${this.frameSandbox()}" data-frag="${escapeAttr(n.id)}"></iframe>`;
      case 'embed':
        return n.url ? `<iframe class="html-frame" src="${escapeAttr(n.url)}" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`
          : '<div class="media-missing">未设置地址</div>';
      case 'file':
        return this.fileHtml(n);
      default:
        return '';
    }
  }

  /* 片段沙箱按状态分权：
     编辑态只给它"跑起来"的权限，不许弹窗、不许锁指针、不许提交表单 ——
     否则一个 alert 或 pointer-lock 就能把整块画布的拖动搞废。
     预览态才放开交互权限，那时鼠标本来就归内容。 */
  frameSandbox() {
    if (this.preview) {
      return 'allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock';
    }
    return 'allow-scripts allow-same-origin';
  }

  /** 把 HTML 片段换成同源地址；内容没变就不重设，免得反复重载 */
  async hydrateHtmlFrame(n, box) {
    const frame = box.querySelector('.html-frame');
    if (!frame) return;
    const sig = `${n.html || ''}\u0000${n.css || ''}\u0000${n.js || ''}`;
    if (frame.dataset.fragSig === sig && frame.getAttribute('src')) return;
    const url = await fragUrl(n.html, n.css, n.js);
    if (!frame.isConnected) return;
    const cur = this.nodeById(n.id);
    if (!cur) return;
    frame.dataset.fragSig = sig;
    frame.setAttribute('src', url);
  }

  /** 文本类文件惰性读取：画布上只渲染前 4000 字，原文完整留在 fullText 里给导出用 */
  async fillTextFile(n, box) {
    const slot = box.querySelector('.file-text');
    if (!slot || !n.src) return;
    if (n.fullText) {
      slot.textContent = n.fullText.slice(0, 4000);
      return;
    }
    if (n.preview) { slot.textContent = n.preview; return; }
    try {
      const res = await fetch(n.src);
      const text = await res.text();
      n.fullText = text;
      n.preview = text.slice(0, 4000);
      slot.textContent = n.preview;
    } catch {
      slot.textContent = '（无法读取内容）';
    }
  }

  fileHtml(n) {
    if (!n.src) return '<div class="media-missing">文件丢失</div>';
    const ext = (n.ext || '').toLowerCase();
    if (ext === 'pdf') {
      /* 编辑态不挂阅读器：那是个独立进程级插件，很吃内存，
         而且会吃掉鼠标事件，导致这块拖不动。
         预览态才换成真阅读器，可以翻页、滚动。 */
      if (!this.preview) {
        const mb = n.size ? (n.size / 1048576).toFixed(1) + ' MB' : '';
        return `<div class="file-card pdf-card">
          <span class="file-ext">PDF</span>
          <span class="file-name">${escapeHtml(n.name || '文档.pdf')}</span>
          <span class="file-size">${escapeHtml(mb)} 切到预览查看</span>
        </div>`;
      }
      // PDF 走浏览器自带阅读器，不能加 sandbox（加了会被禁掉插件）
      return `<iframe class="html-frame" src="${n.src}#toolbar=0&navpanes=0&view=FitH"></iframe>`;
    }
    if (['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yml', 'yaml', 'xml', 'js', 'ts', 'css', 'py', 'sh'].includes(ext)) {
      return `<div class="file-text" data-id="${n.id}">读取中…</div>`;
    }
    if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) {
      return `<div class="font-card"><span class="font-sample" style="@font-face 未加载">Aa</span><b>${escapeHtml(n.name || '字体')}</b></div>`;
    }
    const size = n.size ? (n.size / 1024 > 1024 ? (n.size / 1048576).toFixed(1) + ' MB' : Math.round(n.size / 1024) + ' KB') : '';
    return `<div class="file-card">
      <span class="file-ext">${escapeHtml((ext || 'file').toUpperCase().slice(0, 5))}</span>
      <span class="file-name">${escapeHtml(n.name || '文件')}</span>
      <span class="file-size">${escapeHtml(size)}</span>
    </div>`;
  }

  applyAnim(n, el) {
    const v = animationValue(n.anim);
    el.classList.add('anim-on');
    el.style.animation = v || '';
  }

  replay(id) {
    const el = this.elOf(id, this.project.id);
    const n = this.nodeById(id);
    if (!el || !n) return;
    el.dataset.replay = '1';
    el.classList.remove('anim-on');
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = animationValue(n.anim) || '';
    el.classList.add('anim-on');
    setTimeout(() => { delete el.dataset.replay; }, 60);
  }

  setPreview(on) {
    this.preview = on;
    this.render();

    if (on) {
      this.nodes.forEach((n) => {
        const el = this.elOf(n.id, this.project.id);
        if (el) this.applyAnim(n, el);
      });
    } else {
      this.els.forEach((el) => { el.style.animation = ''; });
    }

    // 片段沙箱跟着状态换权限
    this.els.forEach((el) => {
      el.querySelectorAll('iframe.html-frame').forEach((f) => {
        const next = this.frameSandbox();
        if (f.getAttribute('sandbox') !== next) f.setAttribute('sandbox', next);
      });
    });

    /* 媒体在两种状态下的行为不一样：
       预览才播放（静音，避免一进去就吵），编辑一律暂停，
       否则十几个视频同时播，画布会卡到拖不动。 */
    this.els.forEach((el) => {
      el.querySelectorAll('video,audio').forEach((m) => {
        try {
          if (on) {
            m.muted = true;
            const p = m.play?.();
            if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拦就停着 */ });
          } else {
            m.pause();
            m.currentTime = 0;
          }
        } catch { /* 忽略单个数媒的异常 */ }
      });
    });
  }

  /* ── 选中与浮层 ────────────────────────────────────── */

  select(ids, { additive = false } = {}) {
    if (!additive) this.selection.clear();
    (Array.isArray(ids) ? ids : [ids]).forEach((id) => id && this.selection.add(id));
    const bid = this.project.id;
    this.els.forEach((el, key) => {
      if (!key.startsWith(bid + '|')) return;
      el.classList.toggle('is-selected', this.selection.has(key.slice(bid.length + 1)));
    });
    this.updateOverlay();
    this.onSelectionChange?.(this.selectedNodes());
  }

  selectedNodes() {
    return [...this.selection].map((id) => this.nodeById(id)).filter(Boolean);
  }

  updateOverlay() {
    const ov = this.dom.selOverlay;
    const sel = this.selectedNodes();

    // 嵌入态：内部页面正接管鼠标，选中框的线、手柄、尺寸标签都会挡住它，
    // 但模式按钮必须留着，否则用户没有出口。
    if (this.interactiveId && !this.preview) {
      const live = this.nodeById(this.interactiveId);
      if (!live) { ov.hidden = true; return; }
      ov.hidden = false;
      ov.classList.add('live-embed');
      this.placeEmbedToggle(live);
      return;
    }
    ov.classList.remove('live-embed');

    if (!sel.length || this.preview || this.editing) {
      ov.hidden = true;
      return;
    }
    ov.hidden = false;

    if (sel.length === 1) {
      const n = sel[0];
      const box = ov.querySelector('.sel-box');
      const label = ov.querySelector('.sel-label');
      const rot = ov.querySelector('.rot-handle');
      box.style.left = n.x + 'px';
      box.style.top = n.y + 'px';
      box.style.width = n.w + 'px';
      box.style.height = n.h + 'px';
      box.style.transform = n.rot ? `rotate(${n.rot}deg)` : '';
      box.style.transformOrigin = 'center';

      ov.querySelectorAll('.handle').forEach((h) => {
        // 位置全部走变量：hover 只改 --hs，不会碰到位移，
        // 所以鼠标划过手柄时它不会跳到元素中心再弹回。
        h.style.left = (n.x + n.w / 2) + 'px';
        h.style.top = (n.y + n.h / 2) + 'px';
        const off = localOffsets[h.dataset.h];
        h.style.setProperty('--hx', (off.x * n.w / 2) + 'px');
        h.style.setProperty('--hy', (off.y * n.h / 2) + 'px');
        h.style.setProperty('--hr', n.rot ? `${n.rot}deg` : '0deg');
        h.hidden = false;
      });

      rot.style.left = (n.x + n.w / 2) + 'px';
      rot.style.top = (n.y - 26) + 'px';

      label.textContent = `${Math.round(n.w)} × ${Math.round(n.h)}${n.rot ? ` · ${Math.round(n.rot)}°` : ''}`;
      label.style.left = n.x + 'px';
      label.style.top = (n.y + n.h + 8) + 'px';

      this.placeEmbedToggle(n);
    } else {
      this.hideEmbedToggle();
      const b = boundsOf(sel);
      const box = ov.querySelector('.sel-box');
      box.style.left = b.x + 'px';
      box.style.top = b.y + 'px';
      box.style.width = b.w + 'px';
      box.style.height = b.h + 'px';
      box.style.transform = '';
      ov.querySelectorAll('.handle').forEach((h) => { h.hidden = true; });
      ov.querySelector('.rot-handle').style.top = (b.y - 26) + 'px';
      ov.querySelector('.rot-handle').style.left = (b.x + b.w / 2) + 'px';
      const label = ov.querySelector('.sel-label');
      label.textContent = `${sel.length} 个元素`;
      label.style.left = b.x + 'px';
      label.style.top = (b.y + b.h + 8) + 'px';
      this.hideEmbedToggle();
    }
  }

  /* ── 嵌入 / 编辑 模式开关 ─────────────────────────────── */

  /** 只有 HTML 片段和外部嵌入需要这个开关；别的类型没有"内部"可言 */
  canToggleEmbed(n) {
    return Boolean(n) && (n.type === 'html' || n.type === 'embed');
  }

  /**
   * 把开关放到元素左上角外侧。
   * 注意它必须始终可点：一旦把指针事件交给 iframe，
   * 页面上就没有别的地方能把模式切回编辑了。
   */
  placeEmbedToggle(n) {
    const btn = this.cur.overlay?.querySelector('.embed-toggle');
    if (!btn) return;

    if (!this.canToggleEmbed(n)) {
      btn.hidden = true;
      return;
    }

    const live = this.interactiveId === n.id;
    btn.hidden = false;
    btn.textContent = live ? '◉ 嵌入中' : '✎ 编辑中';
    btn.title = live ? '点一下切回编辑：可以拖动、缩放、右键改' : '点一下切到嵌入：把鼠标交给里面的页面';
    btn.classList.toggle('on', live);

    // 贴左上角外侧，元素太小就落回内部左上
    btn.style.left = n.x + 'px';
    const above = n.y - 26;
    btn.style.top = (above > 4 ? above : n.y + 6) + 'px';
  }

  hideEmbedToggle() {
    const btn = this.cur.overlay?.querySelector('.embed-toggle');
    if (btn) btn.hidden = true;
  }

  /* ── 事件 ──────────────────────────────────────────── */

  _bind() {
    const { viewport, world } = this.dom;

    /* 中键默认会触发浏览器的自动滚动圆盘，一旦触发就收不到 pointermove，
       画布也就拖不动了。这里把中键的默认行为按掉，只留我们自己的平移。 */
    viewport.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    viewport.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });

    viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));

    viewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomAt(Math.pow(0.9985, e.deltaY * (e.ctrlKey ? 1 : 1)), e.clientX, e.clientY);
      } else if (e.shiftKey) {
        e.preventDefault();
        this.view.panX -= e.deltaY;
        this.applyView();
      } else {
        e.preventDefault();
        this.view.panX -= e.deltaX;
        this.view.panY -= e.deltaY;
        this.applyView();
      }
    }, { passive: false });

    viewport.addEventListener('dblclick', (e) => {
      const nodeEl = e.target.closest('.node');
      if (!nodeEl) return;
      const n = this.nodeById(nodeEl.dataset.id);
      if (!n) return;
      if (n.type === 'text') { this.startInlineEdit(n.id); return; }
      if (n.type === 'html' || n.type === 'embed') this.enterInteractive(n.id);
    });
  }

  /** 双击 HTML 元素：把指针事件交给内部，方便在编辑状态下直接试交互 */
  enterInteractive(id) {
    this.interactiveId = id;
    const bid = this.project.id;
    this.els.forEach((el, key) => {
      const on = key === `${bid}|${id}` || this.preview;
      const inner = el.querySelector('.node-inner');
      if (!inner) return;
      const n = this.nodeById(key.slice(key.indexOf('|') + 1));
      inner.style.pointerEvents = on && (n?.type === 'html' || n?.type === 'embed') ? 'auto' : 'none';
    });
    // 不能把整个覆盖层藏掉：切换按钮就挂在这上面。
    // 一旦藏了，用户切进嵌入态就再也点不回来 —— 那就是"改不了"。
    this.updateOverlay();
    this.onInteractive?.({ active: true, id, name: this.nodeById(id)?.name });
  }

  exitInteractive() {
    if (!this.interactiveId) return;
    this.interactiveId = null;
    this.els.forEach((el) => {
      const inner = el.querySelector('.node-inner');
      if (inner) inner.style.pointerEvents = this.preview ? 'auto' : 'none';
    });
    this.updateOverlay();
    this.onInteractive?.({ active: false });
  }

  onPointerDown(e) {
    if (this.suspended) return;
    // 右键交给 contextmenu 处理，否则右键拖动会误触发移动
    if (e.button === 2) return;
    const target = e.target;
    const nodeEl = target.closest('.node');
    const handle = target.closest('.handle');
    const rotHandle = target.closest('.rot-handle');

    /* 预览模式：鼠标只用来和内容交互，不做任何编辑。
       点元素、抓手柄、框选一律不响应；空白处和中键仍可挪视野，
       否则画面放大后看不全。 */
    if (this.preview) {
      const onlyPan = e.button === 1 || this.spaceDown || !nodeEl;
      if (!onlyPan) return;
      if (e.button === 1) e.preventDefault();
      this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, panX: this.view.panX, panY: this.view.panY };
      this.dom.viewport.classList.add('grabbing');
      return;
    }

    /* 点在别的画布上：先把那块切成当前画布再继续。
       不这么做的话，选中状态记在当前画布名下，被点的那块既不亮框也不出手柄，
       看着就像完全选不中。 */
    const hitBoard = this.boardOf(target);
    if (hitBoard && hitBoard !== this.project.id) this.activateBoard(hitBoard);

    // 中键 / 空格 / 空白处拖 = 平移
    const wantPan = e.button === 1 || this.spaceDown || (!nodeEl && !handle && !rotHandle);
    if (wantPan) {
      if (e.button === 0 && nodeEl) return;

      /* 中键和空格是"我只想挪视野"：
         不能顺手清空选中，也不能在空白处改成拉选框 ——
         以前中键按在空白处会被 startMarquee 覆盖成框选，所以拖不动画布。 */
      const purePan = e.button === 1 || this.spaceDown;

      if (e.button === 1) {
        // 阻止浏览器把中键当自动滚动，否则拿不到连续的 move 事件
        e.preventDefault();
      }

      this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, panX: this.view.panX, panY: this.view.panY };
      this.dom.viewport.classList.add('grabbing');
      if (!purePan && !nodeEl) this.startMarquee(e);
      return;
    }

    if (rotHandle) {
      const sel = this.selectedNodes();
      if (sel.length !== 1) return;
      const n = sel[0];
      this.drag = {
        kind: 'rotate', id: n.id, start: this.toBoard(e.clientX, e.clientY),
        cx: n.x + n.w / 2, cy: n.y + n.h / 2, rot0: n.rot || 0,
        a0: Math.atan2(this.toBoard(e.clientX, e.clientY).y - (n.y + n.h / 2), this.toBoard(e.clientX, e.clientY).x - (n.x + n.w / 2)),
      };
      this.beginEdit();
      return;
    }

    if (handle) {
      const sel = this.selectedNodes();
      if (sel.length !== 1) return;
      const n = sel[0];
      this.drag = {
        kind: 'resize', id: n.id, h: handle.dataset.h,
        start: this.toBoard(e.clientX, e.clientY),
        orig: { x: n.x, y: n.y, w: n.w, h: n.h, rot: n.rot || 0 },
      };
      this.beginEdit();
      return;
    }

    if (nodeEl) {
      const id = nodeEl.dataset.id;
      if (e.shiftKey) this.select(id, { additive: true });
      else if (!this.selection.has(id)) this.select(id);
      const sel = this.selectedNodes();
      if (sel.some((n) => n.locked)) return;
      this.drag = {
        kind: 'move', start: this.toBoard(e.clientX, e.clientY),
        ids: [...this.selection], origs: new Map(sel.map((n) => [n.id, { x: n.x, y: n.y }])),
      };
      this.beginEdit();
      return;
    }
  }

  startMarquee(e) {
    const p = this.toBoard(e.clientX, e.clientY);
    this.drag = {
      ...this.drag,
      kind: 'marquee', start: p, current: p,
    };
    if (!e.shiftKey) this.select([]);
    this.dom.marquee.hidden = false;
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const d = this.drag;

    if (d.kind === 'pan') {
      this.view.panX = d.panX + (e.clientX - d.startX);
      this.view.panY = d.panY + (e.clientY - d.startY);
      this.applyView();
      return;
    }

    if (d.kind === 'marquee') {
      const p = this.toBoard(e.clientX, e.clientY);
      d.current = p;
      const x = Math.min(d.start.x, p.x);
      const y = Math.min(d.start.y, p.y);
      const w = Math.abs(p.x - d.start.x);
      const h = Math.abs(p.y - d.start.y);
      const m = this.dom.marquee;
      m.style.left = x + 'px';
      m.style.top = y + 'px';
      m.style.width = w + 'px';
      m.style.height = h + 'px';

      const hit = this.nodes.filter((n) => !n.hidden &&
        n.x < x + w && n.x + n.w > x && n.y < y + h && n.y + n.h > y).map((n) => n.id);
      this.select(hit, { additive: e.shiftKey });
      return;
    }

    if (d.kind === 'move') {
      const p = this.toBoard(e.clientX, e.clientY);
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
      }
      const snap = this.computeSnap(dx, dy, d.ids);
      dx += snap.dx;
      dy += snap.dy;
      this.showGuides(snap.guides);

      for (const id of d.ids) {
        const n = this.nodeById(id);
        const o = d.origs.get(id);
        if (!n || !o) continue;
        n.x = Math.round(o.x + dx);
        n.y = Math.round(o.y + dy);
        this.positionEl(n);
      }
      this.updateOverlay();
      this.onLiveTransform?.(this.selectedNodes());
      return;
    }

    if (d.kind === 'resize') {
      const n = this.nodeById(d.id);
      if (!n) return;
      const p = this.toBoard(e.clientX, e.clientY);
      const o = d.orig;
      const rad = (o.rot * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;

      // 鼠标点转到元素本地坐标（原点＝元素中心，坐标轴随旋转）
      const vx = p.x - cx, vy = p.y - cy;
      const lx = vx * cos + vy * sin;
      const ly = -vx * sin + vy * cos;

      const h = d.h;
      const growLeft = h.includes('w');
      const growRight = h.includes('e');
      const growTop = h.includes('n');
      const growBottom = h.includes('s');

      // 对边固定：拖右边就锁左边，拖上边就锁下边
      const fixedX = growRight ? -o.w / 2 : growLeft ? o.w / 2 : 0;
      const fixedY = growBottom ? -o.h / 2 : growTop ? o.h / 2 : 0;

      // 关键：这里不取绝对值。取了绝对值，鼠标一旦越过固定边，
      // 尺寸会「反弹」回来、中心点还会瞬间跳到另一侧 —— 那就是跳动的来源。
      // 改成：越过固定边就只是收到最小尺寸，方向不变，所以永远不会翻面。
      let nw = o.w;
      let nh = o.h;
      if (growRight) nw = Math.max(MIN_SIZE, lx - fixedX);
      else if (growLeft) nw = Math.max(MIN_SIZE, fixedX - lx);
      if (growBottom) nh = Math.max(MIN_SIZE, ly - fixedY);
      else if (growTop) nh = Math.max(MIN_SIZE, fixedY - ly);

      // Shift 等比：以长边为准，两边同比例收放，仍然不翻面
      if (e.shiftKey && (growLeft || growRight) && (growTop || growBottom)) {
        const ratio = o.w / o.h;
        if (nw / nh > ratio) nw = Math.max(MIN_SIZE, nh * ratio);
        else nh = Math.max(MIN_SIZE, nw / ratio);
      }

      // 新中心在本地坐标里的偏移：固定边不动，另一边跟着尺寸走
      const cxLocal = growRight ? fixedX + nw / 2 : growLeft ? fixedX - nw / 2 : 0;
      const cyLocal = growBottom ? fixedY + nh / 2 : growTop ? fixedY - nh / 2 : 0;

      const wx = cxLocal * cos - cyLocal * sin;
      const wy = cxLocal * sin + cyLocal * cos;

      // 不做整像素取整：取整会在拖拽过程中每帧抖动 1px，直接跟手更稳
      n.w = nw;
      n.h = nh;
      n.x = cx + wx - nw / 2;
      n.y = cy + wy - nh / 2;
      this.positionEl(n);
      this.updateOverlay();
      this.onLiveTransform?.(this.selectedNodes());
      return;
    }

    if (d.kind === 'rotate') {
      const n = this.nodeById(d.id);
      if (!n) return;
      const p = this.toBoard(e.clientX, e.clientY);
      const a = Math.atan2(p.y - d.cy, p.x - d.cx);
      let deg = d.rot0 + ((a - d.a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      n.rot = Math.round(deg * 10) / 10;
      this.positionEl(n);
      this.updateOverlay();
      this.onLiveTransform?.(this.selectedNodes());
    }
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    this.dom.viewport.classList.remove('grabbing');
    this.dom.marquee.hidden = true;
    this.showGuides([]);
    if (!d) return;

    if (d.kind === 'marquee') return;

    if (['move', 'resize', 'rotate'].includes(d.kind)) {
      this.endEdit();
      this.onTransformEnd?.(this.selectedNodes());
    }
  }

  positionEl(n) {
    const el = this.elOf(n.id, this.project.id);
    if (!el) return;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = n.w + 'px';
    el.style.height = n.h + 'px';
    el.style.transform = n.rot ? `rotate(${n.rot}deg)` : '';
  }

  beginEdit() {
    this._snapshot = JSON.stringify(this.project.nodes);
    // 拖动/缩放/旋转期间禁掉过渡，避免手柄滞后回弹
    this.dom.viewport.classList.add('resizing');
  }

  endEdit() {
    this.dom.viewport.classList.remove('resizing');
    if (this._snapshot) {
      const now = JSON.stringify(this.project.nodes);
      if (now !== this._snapshot) {
        this.store.past.push(JSON.stringify({ ...this.project, nodes: JSON.parse(this._snapshot) }));
        if (this.store.past.length > 60) this.store.past.shift();
        this.store.future.length = 0;
        this.store.save();
      }
      this._snapshot = null;
    }
    this.store.emit('transform');
  }

  /* ── 吸附 ──────────────────────────────────────────── */

  computeSnap(dx, dy, movingIds) {
    const { w: AW, h: AH } = this.project.artboard;
    const sel = this.selectedNodes().filter((n) => movingIds.includes(n.id));
    if (!sel.length) return { dx: 0, dy: 0, guides: [] };

    const b = boundsOf(sel);
    const moving = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };

    const targets = this.nodes.filter((n) => !movingIds.includes(n.id) && !n.hidden);
    const vLines = [0, AW / 2, AW, ...targets.flatMap((n) => [n.x, n.x + n.w / 2, n.x + n.w])];
    const hLines = [0, AH / 2, AH, ...targets.flatMap((n) => [n.y, n.y + n.h / 2, n.y + n.h])];

    const myV = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
    const myH = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];

    let best = { dx: 0, dy: 0, guides: [], bestX: SNAP_PX + 1, bestY: SNAP_PX + 1 };

    for (const g of vLines) {
      for (const m of myV) {
        const dlt = g - m;
        if (Math.abs(dlt) < best.bestX) {
          best.bestX = Math.abs(dlt);
          best.dx = dlt;
          best.guideX = g;
        }
      }
    }
    for (const g of hLines) {
      for (const m of myH) {
        const dlt = g - m;
        if (Math.abs(dlt) < best.bestY) {
          best.bestY = Math.abs(dlt);
          best.dy = dlt;
          best.guideY = g;
        }
      }
    }

    const guides = [];
    if (best.bestX <= SNAP_PX) guides.push({ axis: 'v', pos: best.guideX });
    else best.dx = 0;
    if (best.bestY <= SNAP_PX) guides.push({ axis: 'h', pos: best.guideY });
    else best.dy = 0;

    return { dx: best.dx, dy: best.dy, guides };
  }

  showGuides(guides) {
    const box = this.dom.guides;
    box.innerHTML = '';
    const { w, h } = this.project.artboard;
    guides.forEach((g) => {
      const el = document.createElement('div');
      el.className = 'guide ' + g.axis;
      if (g.axis === 'v') {
        el.style.left = g.pos + 'px';
        el.style.top = '0';
        el.style.height = h + 'px';
      } else {
        el.style.top = g.pos + 'px';
        el.style.left = '0';
        el.style.width = w + 'px';
      }
      box.appendChild(el);
    });
  }

  /* ── 行内文字编辑 ──────────────────────────────────── */

  startInlineEdit(id) {
    const n = this.nodeById(id);
    const el = this.elOf(id, this.project.id);
    if (!n || !el) return;
    this.select(id);
    this.editing = id;
    this.dom.selOverlay.hidden = true;

    el.classList.add('editing');
    const t = el.querySelector('.t');
    if (!t) return;
    t.contentEditable = 'true';
    t.spellcheck = false;
    t.textContent = n.text;
    t.focus();

    const range = document.createRange();
    range.selectNodeContents(t);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      t.contentEditable = 'false';
      el.classList.remove('editing');
      this.editing = null;
      const text = t.innerText.replace(/\n{3,}/g, '\n\n').trim() || '（空）';
      if (text !== n.text) {
        this.store.commit((p) => {
          const node = p.nodes.find((x) => x.id === id);
          if (node) node.text = text;
        });
      }
      this.render();
    };

    t.addEventListener('blur', finish, { once: true });
    t.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); t.blur(); }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); t.blur(); }
    });
  }

  /* ── 键盘 ──────────────────────────────────────────── */

  keydown(e) {
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.code === 'Space' && !typing) {
      this.spaceDown = true;
      this.dom.viewport.classList.add('space');
      if (!typing) e.preventDefault();
    }
    if (typing) return;
    if (this.preview && e.key !== 'Escape') return;

    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? this.store.redo() : this.store.undo();
      this.render();
      this.onSelectionChange?.(this.selectedNodes());
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.duplicate();
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.selection.size) {
      e.preventDefault();
      this.removeSelected();
    }
    if (e.key === 'Escape') {
      if (this.preview) this.onExitPreview?.();
      else this.select([]);
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!this.selection.size) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      this.store.commit((p) => {
        p.nodes.filter((n) => this.selection.has(n.id)).forEach((n) => { n.x += dx; n.y += dy; });
      });
      this.render();
    }
  }

  keyup(e) {
    if (e.code === 'Space') {
      this.spaceDown = false;
      this.dom.viewport.classList.remove('space');
    }
  }

  duplicate() {
    const sel = this.selectedNodes();
    if (!sel.length) return;
    const ids = [];
    this.store.commit((p) => {
      sel.forEach((n) => {
        const copy = JSON.parse(JSON.stringify(n));
        copy.id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        copy.x += 24;
        copy.y += 24;
        copy.z = p.nodes.reduce((m, x) => Math.max(m, x.z || 0), 0) + 1;
        p.nodes.push(copy);
        ids.push(copy.id);
      });
    });
    this.render();
    this.select(ids);
  }

  removeSelected() {
    if (!this.selection.size) return;
    const ids = [...this.selection];
    this.store.commit((p) => {
      p.nodes = p.nodes.filter((n) => !ids.includes(n.id));
    });
    this.select([]);
    this.render();
  }
}

/* ── 工具 ────────────────────────────────────────────── */

const localOffsets = {
  nw: { x: -1, y: -1 }, n: { x: 0, y: -1 }, ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 }, se: { x: 1, y: 1 }, s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 }, w: { x: -1, y: 0 },
};

export function boundsOf(nodes) {
  const xs = nodes.flatMap((n) => [n.x, n.x + n.w]);
  const ys = nodes.flatMap((n) => [n.y, n.y + n.h]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
export function escapeAttr(s) { return escapeHtml(s); }

export function wrapFragment(html, css, js) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
*{box-sizing:border-box}
${css || ''}
</style></head><body>${html || ''}${js ? `<script>try{${js}}catch(e){console.error(e)}<\/script>` : ''}</body></html>`;
}

export function gradientCss(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (/gradient\(/i.test(s)) return s;
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) return '';
  const angle = /^[\d.]+deg$/.test(parts[0]) ? parts.shift() : '135deg';
  return `linear-gradient(${angle}, ${parts.join(', ')})`;
}
