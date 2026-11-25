/**
 * store.js — 项目状态 / 持久化 / 撤销重做
 * 数据用 IndexedDB 存，避免 dataURL 撑爆 localStorage。
 */

const DB_NAME = 'qboard';
const STORE = 'kv';
const KEY = 'project';
const LS_FALLBACK = 'qboard.project.v2';

/* 本地缓存必须按账号分开。
   否则同一台机器上换个人登录，会先读到上一个人的画布，
   在服务端还没回来的那一瞬把它们画出来，看着就像"串号"。 */
function cacheKeyOf(user) {
  return `${KEY}@${user || 'anon'}`;
}

function lsKeyOf(user) {
  return `${LS_FALLBACK}@${user || 'anon'}`;
}

/** 一份文档里总共有多少元素，用来判断哪边有真内容。
    有工作台之后画布分散在各工作台里，要全部数一遍；
    只数 doc.boards 会把其它工作台的内容当成"没有"，白白丢掉本地那份。 */
function countNodes(doc) {
  if (!doc || typeof doc !== 'object') return 0;
  const sum = (list) => (Array.isArray(list) ? list : [])
    .reduce((n, b) => n + (Array.isArray(b?.nodes) ? b.nodes.length : 0), 0);
  if (Array.isArray(doc.workspaces) && doc.workspaces.length) {
    return doc.workspaces.reduce((n, w) => n + sum(w?.boards), 0);
  }
  return sum(doc.boards);
}

/**
 * 合并两份聊天记录：取并集、去重、按时间排序。
 *
 * 为什么需要它：两台机器各自聊过之后，整份文档只能有一份存到账号里。
 * 以前是"服务端整份覆盖本地"，另一台机器上的对话就没了。
 * 聊天记录不该有这种损失，所以单独做合并。
 */
export function mergeThreadLists(a, b) {
  const out = [];
  const seen = new Set();

  const add = (m) => {
    if (!m || typeof m !== 'object' || !m.role) return;
    const text = String(m.text ?? '');
    // 新数据带 at，用它做身份；老数据没有 at，就退回内容判重
    const key = m.at ? `${m.role}|${m.at}|${text.length}` : `${m.role}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...m, __seq: out.length });
  };

  (Array.isArray(a) ? a : []).forEach(add);
  (Array.isArray(b) ? b : []).forEach(add);

  out.sort((x, y) => {
    const ax = Number(x.at) || 0;
    const ay = Number(y.at) || 0;
    if (ax !== ay) return ax - ay;
    return x.__seq - y.__seq;
  });

  return out.map(({ __seq, ...rest }) => rest);
}

/**
 * 把 other 的聊天记录并进 base（base 一般是账号里那份）。
 * 只并对话，不动元素——元素位置冲突按主体那份算，避免两台机器互相推来推去。
 */
export function mergeDocsChat(base, other) {
  if (!base || !other) return base;
  const byId = new Map((other.boards || []).map((b) => [b.id, b]));

  (base.boards || []).forEach((b) => {
    const o = byId.get(b.id);
    if (!o) return;
    const keys = new Set([
      ...Object.keys(b.threads || {}),
      ...Object.keys(o.threads || {}),
    ]);
    const merged = {};
    keys.forEach((k) => {
      const list = mergeThreadLists(b.threads?.[k], o.threads?.[k]);
      if (list.length) merged[k] = list.slice(-80);
    });
    b.threads = merged;
  });

  // 只在另一份里出现的画布：里面要有东西才补进来，别把空壳也搬过来
  const have = new Set((base.boards || []).map((b) => b.id));
  (other.boards || []).forEach((b) => {
    if (have.has(b.id)) return;
    const hasContent = (b.nodes || []).length > 0;
    if (hasContent) base.boards.push(b);
  });

  return base;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const DEFAULT_ARTBOARD = { w: 1440, h: 900 };

const DEFAULT_BG = () => ({ type: 'color', value: '#ffffff', dataUrl: '', fit: 'cover', mime: '' });

/** 一块画布：自己的元素、自己的对话线程 */
export function newBoard(name = '未命名画布', patch = {}) {
  return {
    id: uid(),
    name,
    artboard: { ...DEFAULT_ARTBOARD },
    background: DEFAULT_BG(),
    nodes: [],
    // 每个元素一条独立对话线程，key = 'canvas' 表示这块画布的整体 AI
    threads: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  };
}

/**
 * 一个工作台：自己的一叠画布 + 自己当前停在哪一块。
 * 工作台之间完全独立 —— 各自有画布、各自有对话、各自导出，
 * 不是"同一个项目里的多个标签页"。
 */
export function newWorkspace(name = '工作台', boardName = '画布') {
  const b = newBoard(boardName);
  return {
    id: uid(),
    name,
    boards: [b],
    activeBoardId: b.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 整个文档：多个工作台 + 当前正在看哪个工作台 */
export function defaultDoc() {
  const ws = newWorkspace('我的工作台', '我的个人网页');
  return { version: 6, workspaces: [ws], activeWorkspaceId: ws.id };
}

/** 兼容旧调用 */
export function defaultProject() {
  return defaultDoc();
}

let dbPromise = null;

/** 打开数据库；任何异常或超时都返回 null，让上层退回 localStorage */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // 被其它标签页阻塞、或浏览器禁用存储时，open 可能永远不回调
    const timer = setTimeout(() => done(null), 2500);
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      clearTimeout(timer);
      return done(null);
    }
    req.onupgradeneeded = () => {
      try {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      } catch { /* ignore */ }
    };
    req.onsuccess = () => { clearTimeout(timer); done(req.result); };
    req.onerror = () => { clearTimeout(timer); done(null); };
    req.onblocked = () => { clearTimeout(timer); done(null); };
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2500);
    try {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => { clearTimeout(timer); resolve(r.result ?? null); };
      r.onerror = () => { clearTimeout(timer); resolve(null); };
    } catch { clearTimeout(timer); resolve(null); }
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => { clearTimeout(timer); resolve(true); };
      tx.onerror = () => { clearTimeout(timer); resolve(false); };
      tx.onabort = () => { clearTimeout(timer); resolve(false); };
    } catch { clearTimeout(timer); resolve(false); }
  });
}

export class Store {
  constructor() {
    this.doc = defaultDoc();
    this.listeners = new Set();
    this.past = [];
    this.future = [];
    this._saveTimer = null;
    this._saving = false;
  }

  /* ── 工作台 ──────────────────────────────────── */

  /** 当前工作台。数据不对时兜底建一个，保证永远有得看。 */
  get workspace() {
    const d = this.doc;
    if (!Array.isArray(d.workspaces) || !d.workspaces.length) {
      d.workspaces = [newWorkspace()];
      d.activeWorkspaceId = d.workspaces[0].id;
    }
    let w = d.workspaces.find((x) => x.id === d.activeWorkspaceId);
    if (!w) {
      w = d.workspaces[0];
      d.activeWorkspaceId = w.id;
    }
    if (!Array.isArray(w.boards) || !w.boards.length) w.boards = [newBoard()];
    return w;
  }

  get workspaces() {
    return this.doc.workspaces || [];
  }

  /* ── 画布集合 ────────────────────────────────── */

  get boards() {
    return this.workspace.boards;
  }

  get board() {
    const w = this.workspace;
    let b = w.boards.find((x) => x.id === w.activeBoardId);
    if (!b) {
      b = w.boards[0];
      if (b) w.activeBoardId = b.id;
    }
    return b;
  }

  /** 兼容旧代码：画布级的读写一律指向当前画布 */
  get project() {
    return this.board;
  }

  /** 新建一块画布。afterId 传了就插在那块后面，不传就追加到末尾。
      画布不再编号也不再显示名字：一个工作台里就是一叠画布，位置即身份。 */
  addBoard(name, patch = {}, afterId = null) {
    const board = newBoard(name || '画布', patch);
    this.past.push(JSON.stringify(this.doc));
    if (this.past.length > 60) this.past.shift();
    this.future.length = 0;

    const at = afterId ? this.workspace.boards.findIndex((b) => b.id === afterId) : -1;
    if (at >= 0) this.workspace.boards.splice(at + 1, 0, board);
    else this.workspace.boards.push(board);

    this.workspace.activeBoardId = board.id;
    this.emit('board');
    this.save();
    return board;
  }

  duplicateBoard(id) {
    const src = this.workspace.boards.find((b) => b.id === id);
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    copy.name = `${src.name} 副本`;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    this.past.push(JSON.stringify(this.doc));
    this.future.length = 0;
    this.workspace.boards.push(copy);
    this.workspace.activeBoardId = copy.id;
    this.emit('board');
    this.save();
    return copy;
  }

  setBoard(id) {
    if (!this.workspace.boards.some((b) => b.id === id)) return false;
    if (this.workspace.activeBoardId === id) return true;
    this.workspace.activeBoardId = id;
    this.emit('board');
    this.save();
    return true;
  }

  renameBoard(id, name) {
    const b = this.workspace.boards.find((x) => x.id === id);
    if (!b) return;
    b.name = String(name || '').trim() || '未命名画布';
    b.updatedAt = Date.now();
    this.emit('board');
    this.save();
  }

  /** 把某块画布挪到指定位置（列表里的顺序，用户自己调）。
      from 在 to 之前时目标下标要减一，避免自己占位导致偏一格。 */
  moveBoard(id, toIndex) {
    const boards = this.workspace.boards;
    const from = boards.findIndex((b) => b.id === id);
    if (from < 0) return false;
    let to = Math.max(0, Math.min(boards.length - 1, toIndex));
    if (from === to) return false;
    this.past.push(JSON.stringify(this.doc));
    if (this.past.length > 60) this.past.shift();
    this.future.length = 0;
    const [item] = boards.splice(from, 1);
    boards.splice(to, 0, item);
    this.emit('board');
    this.save();
    return true;
  }

  removeBoard(id) {
    if (this.workspace.boards.length <= 1) return false;
    const idx = this.workspace.boards.findIndex((b) => b.id === id);
    if (idx < 0) return false;
    this.past.push(JSON.stringify(this.doc));
    if (this.past.length > 60) this.past.shift();
    this.future.length = 0;
    this.workspace.boards.splice(idx, 1);
    if (this.workspace.activeBoardId === id) {
      this.workspace.activeBoardId = this.workspace.boards[Math.min(idx, this.workspace.boards.length - 1)].id;
    }
    this.emit('board');
    this.save();
    return true;
  }

  /* ── 工作台增删切换 ──────────────────────────── */

  /** 新建一个完全独立的工作台：自己一叠画布，从一块空白画布开始。
      patch 可以带名字，不传就叫「工作台 N」。 */
  addWorkspace(patch = {}) {
    const n = this.doc.workspaces.length + 1;
    const ws = newWorkspace(patch.name || `工作台 ${n}`, patch.boardName || '画布');
    if (patch.name) ws.name = patch.name;
    this.doc.workspaces.push(ws);
    this.doc.activeWorkspaceId = ws.id;
    this.past.length = 0;      // 换工作台不是同一条时间线，撤销栈清掉
    this.future.length = 0;
    this.emit('workspace');
    this.save();
    return ws;
  }

  setWorkspace(id) {
    if (!this.doc.workspaces.some((w) => w.id === id)) return false;
    if (this.doc.activeWorkspaceId === id) return true;
    this.doc.activeWorkspaceId = id;
    this.past.length = 0;
    this.future.length = 0;
    this.emit('workspace');
    this.save();
    return true;
  }

  renameWorkspace(id, name) {
    const w = this.doc.workspaces.find((x) => x.id === id);
    if (!w) return false;
    w.name = String(name || '').trim() || '工作台';
    w.updatedAt = Date.now();
    this.emit('workspace');
    this.save();
    return true;
  }

  /** 删掉一个工作台。最后一个不许删，否则就没有可看的地方了。 */
  removeWorkspace(id) {
    if (this.doc.workspaces.length <= 1) return false;
    const idx = this.doc.workspaces.findIndex((w) => w.id === id);
    if (idx < 0) return false;
    this.doc.workspaces.splice(idx, 1);
    if (this.doc.activeWorkspaceId === id) {
      this.doc.activeWorkspaceId = this.doc.workspaces[Math.min(idx, this.doc.workspaces.length - 1)].id;
    }
    this.past.length = 0;
    this.future.length = 0;
    this.emit('workspace');
    this.save();
    return true;
  }

  workspaceById(id) {
    if (!id) return null;
    return this.doc.workspaces.find((w) => w.id === id) || null;
  }

  /* ── 订阅 / 变更 ─────────────────────────────── */

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason = 'change') {
    this.listeners.forEach((fn) => fn(this.board, reason));
  }

  /** 按 id 取某块画布；没有就返回 null */
  boardById(id) {
    if (!id) return null;
    return this.workspace.boards.find((b) => b.id === id) || null;
  }

  /** 结构变更（增删改），记入撤销栈。
      boardId 传了就改那块画布，不传就改当前画布 ——
      多画布之后，AI 可能要对「画布 2」动手，而用户正停在别处。 */
  commit(mutator, { silent = false, boardId = null } = {}) {
    this.past.push(JSON.stringify(this.doc));
    if (this.past.length > 60) this.past.shift();
    this.future.length = 0;
    const target = boardId ? (this.boardById(boardId) || this.board) : this.board;
    mutator?.(target);
    this.pruneThreads();
    if (!silent) this.emit('commit');
    this.save();
  }

  /** 元素没了，它的对话线程也一起清掉，避免越攒越多 */
  pruneThreads() {
    this.workspace.boards.forEach((b) => {
      const threads = b.threads;
      if (!threads) return;
      const alive = new Set((b.nodes || []).map((n) => n.id));
      Object.keys(threads).forEach((k) => {
        // __legacy 是历史存档，不对应任何元素，不能当孤儿清理
        if (k === 'canvas' || k.startsWith('__')) return;
        if (!alive.has(k)) delete threads[k];
      });
    });
  }

  /** 只更新视图状态，不进历史 */
  touch(reason = 'touch') {
    this.emit(reason);
    this.save();
  }

  /** 表单类连续编辑：聚焦时记快照，失焦时若真变了才入历史 */
  captureSnapshot() {
    this._pending = JSON.stringify(this.doc);
  }

  settleSnapshot() {
    if (!this._pending) return;
    const before = this._pending;
    this._pending = null;
    if (JSON.stringify(this.doc) === before) return;
    this.past.push(before);
    if (this.past.length > 60) this.past.shift();
    this.future.length = 0;
    this.save();
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.past.pop());
    this.emit('undo');
    this.save();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.future.pop());
    this.emit('redo');
    this.save();
    return true;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), 400);
  }

  /** 立即写盘，不等防抖。导出、切画布这类关键时机用。 */
  flushNow() {
    clearTimeout(this._saveTimer);
    return this._flush();
  }

  /**
   * 落盘顺序：先服务端（跟账号走），再本地缓存（离线兜底）。
   * 服务端失败不阻塞编辑，本地照存，下次保存会补上。
   */
  async _flush() {
    if (this._saving) {
      this._dirty = true;
      return;
    }
    this._saving = true;
    this._dirty = false;
    const data = JSON.stringify(this.doc);
    try {
      const ckey = this._ckey || cacheKeyOf(this.user);
      const [localOk, remoteOk] = await Promise.all([
        idbSet(ckey, data).catch(() => false),
        this._pushRemote(data),
      ]);
      if (!localOk) {
        try { localStorage.setItem(this._lskey || lsKeyOf(this.user), data); } catch { /* 满了就算了 */ }
      }
      this._remoteOk = remoteOk;
      if (!remoteOk) this._remoteFails = (this._remoteFails || 0) + 1;
      else this._remoteFails = 0;
    } catch {
      try { localStorage.setItem(this._lskey || lsKeyOf(this.user), data); } catch { /* 满了就算了 */ }
    } finally {
      this._saving = false;
      if (this._dirty) this.save();
    }
  }

  async _pushRemote(data) {
    try {
      const res = await fetch('api/doc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: JSON.parse(data) }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 读盘顺序：服务端优先（账号里那份才是真相），
   * 服务端没有才退回本地缓存。
   */
  async load() {
    let serverDoc = null;
    let localDoc = null;

    // 1) 服务端（账号里那份）。响应用户名就是这台浏览器当前登录的账号。
    try {
      const res = await fetch('api/doc');
      if (res.ok) {
        const j = await res.json();
        if (j?.user) this.user = j.user;
        if (j?.exists && j.doc) serverDoc = this._migrate(j.doc);
      }
    } catch { /* 断网就只看本地 */ }

    // 2) 本地缓存（只读当前账号那一份）
    this._ckey = cacheKeyOf(this.user);
    this._lskey = lsKeyOf(this.user);
    let raw = null;
    try { raw = await idbGet(this._ckey); } catch { /* ignore */ }
    if (!raw) {
      try { raw = localStorage.getItem(this._lskey); } catch { /* ignore */ }
    }
    if (raw) {
      try { localDoc = this._migrate(JSON.parse(raw)); } catch { /* 损坏就跳过 */ }
    }

    // 3) 谁赢：正常情况下服务端赢（那是账号里的真相）。
    //    唯一例外是服务端空白、本地有内容 —— 那种情况要让本地赢，
    //    否则一次空文档推送就会把用户浏览器里做好的东西抹掉。
    let doc = serverDoc;
    if (serverDoc && localDoc) {
      const serverNodes = countNodes(serverDoc);
      const localNodes = countNodes(localDoc);
      if (serverNodes === 0 && localNodes > 0) {
        doc = localDoc;
        this._rescuedFromLocal = true;
        try { await idbSet('project.rescued', JSON.stringify(serverDoc)); } catch { /* 留档失败不影响主流程 */ }
      } else if (serverNodes > 0) {
        // 服务端有内容就保留服务端，同时把本地那份留档，出事能查
        try { await idbSet('project.backup', JSON.stringify(localDoc)); } catch { /* ignore */ }
      }
    } else if (!serverDoc && localDoc) {
      doc = localDoc;
      this._fromLocalOnly = true;
    }

    /* 两份都有内容时，除了选一份当主体，还要把另一份的聊天记录并进来。
       否则换机器就会看到"对话没了"——元素还在，聊天记录被整份覆盖掉了。 */
    if (serverDoc && localDoc) {
      doc = mergeDocsChat(doc, doc === serverDoc ? localDoc : serverDoc);
    }

    if (!doc) return this.doc;

    this.doc = doc;
    this.pruneThreads();
    // 不管从哪读来的，最终都推回账号，保证换设备能拿到
    this.save();
    return this.doc;
  }

  /** 把任何历史版本的数据整理成 { workspaces, activeWorkspaceId }。
      旧数据只有一层画布，就整体裹成一个工作台，内容一律不丢。 */
  _migrate(parsed) {
    const norm = (b) => ({
      ...b,
      id: b.id || uid(),
      name: b.name || '未命名画布',
      artboard: b.artboard && b.artboard.w ? b.artboard : { ...DEFAULT_ARTBOARD },
      background: b.background && b.background.type ? b.background : DEFAULT_BG(),
      nodes: Array.isArray(b.nodes) ? b.nodes : [],
      threads: b.threads && typeof b.threads === 'object' ? { ...b.threads } : {},
    });

    const normWs = (w, i) => {
      const boards = (Array.isArray(w.boards) ? w.boards : []).map(norm);
      const list = boards.length ? boards : [newBoard()];
      const active = list.some((b) => b.id === w.activeBoardId) ? w.activeBoardId : list[0].id;
      return {
        id: w.id || uid(),
        name: w.name || `工作台 ${i + 1}`,
        boards: list,
        activeBoardId: active,
        createdAt: w.createdAt || Date.now(),
        updatedAt: w.updatedAt || Date.now(),
      };
    };

    // 已经是工作台文档
    if (Array.isArray(parsed.workspaces) && parsed.workspaces.length) {
      const workspaces = parsed.workspaces.map(normWs);
      const active = workspaces.some((w) => w.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : workspaces[0].id;
      return { version: 6, workspaces, activeWorkspaceId: active };
    }

    // 上一层：多画布文档（v5）—— 整体裹成一个工作台
    if (Array.isArray(parsed.boards) && parsed.boards.length) {
      const boards = parsed.boards.map(norm);
      const active = boards.some((b) => b.id === parsed.activeBoardId)
        ? parsed.activeBoardId
        : boards[0].id;
      const ws = {
        id: uid(),
        name: parsed.name || '我的工作台',
        boards,
        activeBoardId: active,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return { version: 6, workspaces: [ws], activeWorkspaceId: ws.id };
    }

    // 老版本：单块画布直接放在顶层
    const threads = { ...(parsed.threads || {}) };
    const fromVersion = Number(parsed.version) || 2;

    // v2 只有一条大列表，分不清哪句是对哪个元素说的。
    // 塞进「整体」会让整体对话里混进元素的历史 —— 那正是串台。
    // 所以整体挪到 __legacy：留在存储里，不参与任何显示。
    if (Array.isArray(parsed.messages) && parsed.messages.length) {
      threads.__legacy = (threads.__legacy || []).concat(parsed.messages);
    }

    // v3 曾经把上面那条大列表灌进了 canvas，升级时一并挪走
    if (fromVersion < 4 && Array.isArray(threads.canvas) && threads.canvas.length) {
      threads.__legacy = (threads.__legacy || []).concat(threads.canvas);
      threads.canvas = [];
    }

    const board = norm({
      name: parsed.name,
      artboard: parsed.artboard,
      background: parsed.background,
      nodes: parsed.nodes,
      threads,
    });
    const ws = {
      id: uid(),
      name: '我的工作台',
      boards: [board],
      activeBoardId: board.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return { version: 6, workspaces: [ws], activeWorkspaceId: ws.id };
  }
}

/* ── 节点工厂 ─────────────────────────────────────────── */

export function nextZ(project) {
  const max = project.nodes.reduce((m, n) => Math.max(m, n.z || 0), 0);
  return max + 1;
}

const TYPE_DEFAULTS = {
  text: { text: '双击编辑文字', fs: 32, fw: 600, color: '#111111', align: 'left', lh: 1.3, ls: -0.5, valign: 'top' },
  shape: { shape: 'rect', fill: '#111111', grad: '' },
  image: { src: '', fit: 'cover', mime: '' },
  video: { src: '', fit: 'cover', loop: true, muted: true, autoplay: true, mime: '' },
  html: {
    html: '<div class="x">HTML 片段</div>',
    css: '.x{width:100%;height:100%;display:grid;place-items:center;background:#111;color:#b8f65a;font:600 20px/1.4 system-ui}',
    js: '',
    interactive: true,
  },
  file: { src: '', mime: '', ext: '', size: 0, fit: 'contain' },
  embed: { url: '' },
  audio: { src: '', mime: '', loop: false },
};

const TYPE_NAMES = { text: '文字', shape: '形状', image: '图片', video: '视频', html: 'HTML', file: '文件', embed: '嵌入', audio: '音频' };

export function makeNode(type, props = {}, project) {
  const base = {
    id: uid(),
    type,
    name: props.name || TYPE_NAMES[type] || '元素',
    x: 0, y: 0, w: 240, h: 120,
    rot: 0,
    z: project ? nextZ(project) : 1,
    opacity: 1,
    radius: 0,
    locked: false,
    hidden: false,
    anim: { enter: 'fadeUp', loop: 'none', dur: 760, delay: 0, ease: 'spring' },
  };
  return { ...base, ...(TYPE_DEFAULTS[type] || {}), ...props };
}

export const TYPE_LABEL = TYPE_NAMES;
