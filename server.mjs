#!/usr/bin/env node
/**
 * QBoard — 白板式 AI 网页构建器（公网版）
 * 零依赖，仅用 Node 内置模块（Node >= 18）。
 *
 * 设计要点：
 * 1. 静态资源全部走相对路径，网关把 /<appid>/ 前缀剥掉后仍能正确解析。
 * 2. 访客自己的模型 Key 由浏览器持有、随请求带上，服务端不落地。
 * 3. HTML 片段不发 srcdoc（会继承页面 CSP 导致内部脚本被拦），
 *    改为存进内存并给一个同源地址，iframe 用它加载。
 * 4. 提供 /.well-known/catsco-app.json 供网关校验归属。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const CONFIG_PATH = process.env.QB_CONFIG
  ? path.resolve(process.env.QB_CONFIG)
  : path.join(HERE, 'config.json');

const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '127.0.0.1';
const APP_ID = process.env.QB_APP_ID || 'qboard';
const PUBLIC_ORIGIN = (process.env.QB_PUBLIC_ORIGIN || '').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

const PRESETS = [
  { id: 'relay', label: 'CatsCo relay', baseUrl: 'https://relay.catsco.cc/v1', model: 'glm-5.3-flash' },
  { id: 'relay-claude', label: 'relay · Claude', baseUrl: 'https://relay.catsco.cc/v1', model: 'claude-sonnet-5-5' },
  { id: 'relay-deepseek', label: 'relay · DeepSeek 闪', baseUrl: 'https://relay.catsco.cc/v1', model: 'deepseek-flash' },
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'ollama', label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];

/* ── 服务端兜底配置（只给自托管用；公网访客一律自带） ───────── */

async function readConfigFile() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/* ── 账号级模型配置 ──────────────────────────────────────── */
/* 配置跟着账号走，不跟着浏览器走：换设备、换浏览器，登录后就能带出来。
   Key 落盘在 users.json（0600），接口只回掩码，明文永不下发。 */

const USERS_PATH = path.join(HERE, 'users.json');

async function readUsers() {
  try {
    const raw = await fsp.readFile(USERS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

async function writeUsers(obj) {
  const tmp = `${USERS_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, USERS_PATH);
}

/** 取账号配置；没有就返回 null。这是唯一读明文 Key 的入口。 */
async function getAccountConfig(user) {
  if (!user) return null;
  const all = await readUsers();
  const c = all[user];
  if (!c || typeof c !== 'object') return null;
  const baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(c.apiKey || '').trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    model: String(c.model || 'deepseek-chat').trim(),
    temperature: Number.isFinite(+c.temperature) ? +c.temperature : 0.75,
    updatedAt: Number(c.updatedAt) || 0,
  };
}

/** 合并写入；apiKey 传空字符串表示「保留原来的」 */
async function setAccountConfig(user, patch) {
  const all = await readUsers();
  const prev = all[user] && typeof all[user] === 'object' ? all[user] : {};
  const next = { ...prev };

  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  if (Number.isFinite(+patch.temperature)) next.temperature = +patch.temperature;
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (patch.clearKey === true) delete next.apiKey;

  next.updatedAt = Date.now();
  all[user] = next;
  await writeUsers(all);
  return next;
}

/* ── 账号级画布文档 ──────────────────────────────────────── */
/* 画布数据跟账号走：换浏览器、换设备，登录后都是同一份。
   本地 IndexedDB 只当离线缓存，服务端才是唯一真相。 */

const DOC_DIR = path.join(HERE, 'docs');

function docPath(user) {
  const safe = String(user || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(DOC_DIR, `${safe}.json`);
}

async function readDoc(user) {
  if (!user) return null;
  try {
    const raw = await fsp.readFile(docPath(user), 'utf8');
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

/** 每次覆盖前把旧版本挪进 .history，最多留 20 份。
    被误覆盖时能捞回来，而不是只剩最后一份。 */
async function backupDoc(user, target) {
  try {
    const prev = await fsp.readFile(target, 'utf8');
    const dir = path.join(DOC_DIR, '.history');
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${path.basename(target, '.json')}.${stamp}.json`;
    await fsp.writeFile(path.join(dir, name), prev, { mode: 0o600 });

    const files = (await fsp.readdir(dir))
      .filter((f) => f.startsWith(`${path.basename(target, '.json')}.`) && f.endsWith('.json'))
      .sort();
    // 超出 20 份就从最旧的删
    for (const f of files.slice(0, Math.max(0, files.length - 20))) {
      await fsp.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch { /* 没有旧版本就跳过 */ }
}

async function writeDoc(user, doc) {
  await fsp.mkdir(DOC_DIR, { recursive: true });
  const target = docPath(user);
  await backupDoc(user, target);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
  await fsp.rename(tmp, target);
}

/* ── 账号级偏好 ──────────────────────────────────────────── */
/* 技能开关、视图位置、上次停留的画布这些"小而碎"的东西，
   以前躺在浏览器里，换台设备就没了。现在统一挂在账号下。 */

const PREFS_DIR = path.join(HERE, 'prefs');

function prefsPath(user) {
  const safe = String(user || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(PREFS_DIR, `${safe}.json`);
}

async function readPrefs(user) {
  if (!user) return {};
  try {
    const raw = await fsp.readFile(prefsPath(user), 'utf8');
    const d = JSON.parse(raw);
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

async function handleGetPrefs(req, res, user) {
  return json(res, 200, { exists: true, user, prefs: await readPrefs(user) });
}

async function handleSetPrefs(req, res, user) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 4 * 1024 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }
  const prefs = body?.prefs;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return json(res, 400, { error: 'BAD_PREFS', message: 'prefs 必须是对象' });
  }
  try {
    await fsp.mkdir(PREFS_DIR, { recursive: true });
    const target = prefsPath(user);
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(prefs), { mode: 0o600 });
    await fsp.rename(tmp, target);
  } catch (err) {
    return json(res, 500, { error: 'STORE_FAILED', message: err.message });
  }
  return json(res, 200, { ok: true, user });
}

async function handleGetDoc(req, res, user) {
  const doc = await readDoc(user);
  if (!doc) return json(res, 200, { exists: false, user });
  return json(res, 200, { exists: true, user, doc });
}

async function handleSetDoc(req, res, user) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 48 * 1024 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }
  const doc = payload?.doc;
  /* 文档有两代结构：v6 起是多工作台 { workspaces: [...] }，
     更早是多画布 { boards: [...] }。两种都要能存，不能只认旧的。 */
  const hasWorkspaces = Array.isArray(doc?.workspaces) && doc.workspaces.length;
  if (!doc || typeof doc !== 'object' || (!hasWorkspaces && !Array.isArray(doc?.boards))) {
    return json(res, 400, { error: 'BAD_DOC', message: 'doc 需要 workspaces 或 boards 数组' });
  }
  const boardCount = hasWorkspaces
    ? doc.workspaces.reduce((n, w) => n + (Array.isArray(w?.boards) ? w.boards.length : 0), 0)
    : doc.boards.length;
  if (boardCount > 400) {
    return json(res, 400, { error: 'TOO_MANY_BOARDS', message: '画布数量超出上限（400）' });
  }
  try {
    await writeDoc(user, { ...doc, savedAt: Date.now() });
  } catch (err) {
    return json(res, 500, { error: 'STORE_FAILED', message: err.message });
  }
  const boards = (hasWorkspaces
    ? doc.workspaces.flatMap((w) => (Array.isArray(w?.boards) ? w.boards : []))
    : doc.boards
  ).map((b) => ({
    id: b.id,
    name: b.name || '',
    nodes: Array.isArray(b.nodes) ? b.nodes.length : 0,
  }));
  return json(res, 200, { ok: true, savedAt: Date.now(), boards });
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length <= 10 ? '••••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/** 只下发安全信息：掩码、baseUrl、模型名、温度，绝不含明文 Key。
    没存 Key 时也把 baseUrl / 模型名带出去，用户只需要再贴一次 Key。 */
async function handleGetProvider(req, res, user) {
  const c = await getAccountConfig(user);
  if (!c) {
    const all = await readUsers();
    const raw = all[user] && typeof all[user] === 'object' ? all[user] : {};
    return json(res, 200, {
      configured: false,
      user,
      baseUrl: String(raw.baseUrl || ''),
      model: String(raw.model || ''),
      temperature: Number.isFinite(+raw.temperature) ? +raw.temperature : 0.75,
      keyMask: '',
      needsKey: true,
    });
  }
  return json(res, 200, {
    configured: true,
    user,
    baseUrl: c.baseUrl,
    model: c.model,
    temperature: c.temperature,
    keyMask: maskKey(c.apiKey),
    updatedAt: c.updatedAt,
  });
}

async function handleSetProvider(req, res, user) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }
  try {
    await setAccountConfig(user, payload);
  } catch (err) {
    return json(res, 500, { error: 'STORE_FAILED', message: err.message });
  }
  return handleGetProvider(req, res, user);
}

/** 请求里带的 provider 优先；没有才用服务端环境变量/文件 */
async function resolveProvider(provided, user) {
  if (provided && typeof provided === 'object') {
    const baseUrl = String(provided.baseUrl || '').trim();
    const apiKey = String(provided.apiKey || '').trim();
    if (baseUrl && apiKey) {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey,
        model: String(provided.model || 'deepseek-chat').trim(),
        temperature: Number.isFinite(+provided.temperature) ? +provided.temperature : 0.75,
        source: 'client',
      };
    }
  }
  // 没带 Key：先看这个登录账号自己存的那份（跟着账号走，不跟浏览器走）
  const acct = await getAccountConfig(user);
  if (acct) return { ...acct, source: 'account' };

  const file = await readConfigFile();
  const apiKey = process.env.QB_API_KEY || file.apiKey || '';
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.QB_BASE_URL || file.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey,
    model: process.env.QB_MODEL || file.model || 'deepseek-chat',
    temperature: typeof file.temperature === 'number' ? file.temperature : 0.75,
    source: 'server',
  };
}

/* ── 账号密码登录门 ─────────────────────────────────────── */
/* 未登录的人只能看到登录页；静态资源、片段、/api/chat 全部拦在门外。
   会话是 HMAC-SHA256 签名的自包含 token，服务端不存任何会话表。 */

/* 账号表：QB_USERS 形如 "ty:3211,jeni:3211"；不设就用内置的两个。
   每个账号的画布、聊天、偏好各自一份文件，互相看不见。 */
const USERS = (() => {
  const map = new Map();
  const raw = String(process.env.QB_USERS || '').trim();
  if (raw) {
    for (const pair of raw.split(',')) {
      const i = pair.indexOf(':');
      if (i <= 0) continue;
      const u = pair.slice(0, i).trim().toLowerCase();
      const p = pair.slice(i + 1).trim();
      if (u && p) map.set(u, p);
    }
  }
  if (!map.size) {
    map.set(String(process.env.QB_USER || 'ty').toLowerCase(), process.env.QB_PASS || '3211');
    map.set('jeni', process.env.QB_PASS_JENI || '3211');
  }
  return map;
})();
const AUTH_USER = USERS.keys().next().value;
const SESSION_COOKIE = 'qb_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;        // 30 天
const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);
const KEY_PATH = path.join(HERE, 'session.key');

/* 签名密钥：环境变量优先，其次同目录 session.key，再没有就生成一份。
   第一次用到时读进内存，之后不再碰磁盘。 */
let secretPromise = null;

function loadSigningSecret() {
  if (process.env.QB_SECRET) return Promise.resolve(process.env.QB_SECRET);
  if (secretPromise) return secretPromise;
  secretPromise = (async () => {
    try {
      const existing = (await fsp.readFile(KEY_PATH, 'utf8')).trim();
      if (existing) return existing;
    } catch { /* 文件还不存在，往下生成 */ }
    const generated = crypto.randomBytes(32).toString('hex');
    await fsp.writeFile(KEY_PATH, generated + '\n', { mode: 0o600 });
    try { await fsp.chmod(KEY_PATH, 0o600); } catch { /* 已存在文件以现权限为准 */ }
    return generated;
  })().catch((err) => {
    secretPromise = null;                                 // 失败不缓存，下次重试
    throw err;
  });
  return secretPromise;
}

/* 进程启动时就预热，避免第一次登录额外等盘 */
loadSigningSecret().catch((err) => {
  console.error('[auth] 会话密钥初始化失败：', err.message);
});

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64').toString('utf8');
}

async function signSession(user) {
  const secret = await loadSigningSecret();
  const payload = b64url(JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** 校验 token；返回用户名或 null。篡改、过期、格式不对一律 null。 */
async function verifySession(token) {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected;
  try {
    const secret = await loadSigningSecret();
    expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let data;
  try {
    data = JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }
  if (!data || typeof data.u !== 'string') return null;
  if (!Number.isFinite(data.exp) || data.exp < Date.now()) return null;
  const u = String(data.u || '').toLowerCase();
  if (!USERS.has(u)) return null;
  return u;
}

/** 定长比较字符串，避免长度差异和时间差异泄露信息 */
function safeEqual(input, expected) {
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function sessionCookie(value, maxAge) {
  // 这个应用会被嵌进平台侧栏的 iframe 里打开，那种情况属于跨站请求。
  // SameSite=Lax 的 cookie 在跨站子帧里不会被带上，登录完刷新仍然是未登录。
  // 所以公网（https）时用 SameSite=None + Secure；本地 http 调试退回 Lax，
  // 否则浏览器会因为「None 必须 Secure」直接丢弃 cookie。
  const https = PUBLIC_ORIGIN.startsWith('https://')
    || String(process.env.QB_PUBLIC_ORIGIN || '').startsWith('https://');
  const attrs = https ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; ${attrs}; Max-Age=${maxAge}`;
}

async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return verifySession(token);
}

/* 登录页：自包含，因为静态资源本身也被拦住，不能引用外部 css/js */
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QBoard · 登录</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #0a0a0c; color: #e8e8ea;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 24px;
  }
  .card { width: 100%; max-width: 340px; }
  h1 {
    margin: 0 0 6px; font-size: 22px; letter-spacing: 0.12em;
    font-weight: 650; color: #f4f4f5;
  }
  .accent { color: #b8f65a; }
  p.sub { margin: 0 0 28px; font-size: 13px; color: #7c7c85; }
  label { display: block; font-size: 12px; color: #9a9aa3; margin-bottom: 6px; letter-spacing: 0.04em; }
  input {
    width: 100%; padding: 11px 12px; margin-bottom: 16px;
    background: #141418; color: #f2f2f4;
    border: 1px solid #26262c; border-radius: 8px;
    font-size: 14px; outline: none;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input:focus { border-color: #b8f65a; box-shadow: 0 0 0 3px rgba(184,246,90,.13); }
  button {
    width: 100%; padding: 11px 12px; margin-top: 6px;
    background: #b8f65a; color: #0a0a0c; font-weight: 700;
    border: 0; border-radius: 8px; font-size: 14px; cursor: pointer;
    letter-spacing: 0.05em; transition: filter .15s ease, opacity .15s ease;
  }
  button:hover { filter: brightness(1.06); }
  button:disabled { opacity: .6; cursor: default; }
  .err {
    min-height: 18px; margin-top: 12px; font-size: 12.5px;
    color: #ff6b6b; opacity: 0; transition: opacity .15s ease;
  }
  .err.show { opacity: 1; }
  .foot { margin-top: 26px; font-size: 11px; color: #4d4d55; letter-spacing: 0.06em; }
</style>
</head>
<body>
  <div class="card">
    <h1>Q<span class="accent">Board</span></h1>
    <p class="sub">请输入账号密码</p>
    <form id="f" autocomplete="on">
      <label for="user">账号</label>
      <input id="user" name="user" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus>
      <label for="pass">密码</label>
      <input id="pass" name="pass" type="password">
      <button id="btn" type="submit">登录</button>
      <div class="err" id="err" role="alert"></div>
    </form>
    <div class="foot">QBOARD</div>
  </div>
<script>
  var form = document.getElementById('f');
  var userEl = document.getElementById('user');
  var passEl = document.getElementById('pass');
  var btn = document.getElementById('btn');
  var errEl = document.getElementById('err');

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.classList.toggle('show', !!msg);
  }

  function submit() {
    var user = userEl.value.trim();
    var pass = passEl.value;
    if (!user || !pass) { showError('账号和密码都要填'); return; }
    btn.disabled = true;
    showError('');
    fetch('api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: user, pass: pass })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok && data && data.ok) { location.reload(); return; }
        btn.disabled = false;
        showError((data && data.message) || '账号或密码不对');
        passEl.value = '';
        passEl.focus();
      });
    }).catch(function () {
      btn.disabled = false;
      showError('网络异常，稍后重试');
    });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  passEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
</script>
</body>
</html>`;

function serveLoginPage(res) {
  const body = Buffer.from(LOGIN_HTML, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

function unauthorized(res, pathname) {
  if (pathname.startsWith('/api/')) {
    return json(res, 401, { error: 'UNAUTHORIZED', message: '请先登录' });
  }
  const body = Buffer.from('401 请先登录\n', 'utf8');
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

async function handleLogin(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  } catch {
    return json(res, 401, { error: 'BAD_CREDENTIALS', message: '账号或密码不对' });
  }
  const user = typeof payload?.user === 'string' ? payload.user.trim() : '';
  const pass = typeof payload?.pass === 'string' ? payload.pass : '';

  /* 账号和密码都不分大小写：用户懒得记 Ty 还是 ty。
     用户名不存在时也要比一次，别让"账号不存在"比"密码错"回得更快。 */
  const name = user.toLowerCase();
  const expected = USERS.get(name);
  const passOk = safeEqual(pass.toLowerCase(), (expected ?? '\u0000no-such-user').toLowerCase());
  if (expected === undefined || !passOk) {
    return json(res, 401, { error: 'BAD_CREDENTIALS', message: '账号或密码不对' });
  }

  const token = await signSession(name);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(token, SESSION_MAX_AGE_S),
  });
  res.end(JSON.stringify({ ok: true, user: name }));
}

function handleLogout(res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie('', 0),
  });
  res.end(JSON.stringify({ ok: true }));
}

async function handleSession(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 200, { authed: false });
  return json(res, 200, { authed: true, user });
}

/* ── 通用工具 ───────────────────────────────────────────── */

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ── HTML 片段存储 ──────────────────────────────────────── */
/* srcdoc 会继承页面 CSP（script-src 'self'），内部脚本会被拦。
   存成同源地址后 iframe 不再继承，片段里的 JS 和交互才跑得起来。 */

const fragments = new Map();   // id -> { body, at }
const FRAG_LIMIT = 240;
const FRAG_MAX_BYTES = 6 * 1024 * 1024;
let fragBytes = 0;

function evictFragments() {
  while (fragments.size > FRAG_LIMIT || fragBytes > FRAG_MAX_BYTES) {
    const oldest = fragments.keys().next().value;
    if (oldest === undefined) break;
    const f = fragments.get(oldest);
    fragBytes -= f.body.length;
    fragments.delete(oldest);
  }
}

function storeFragment(html, css, js) {
  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
*{box-sizing:border-box}
${css || ''}
</style></head><body>${html || ''}${js ? `<script>try{${js}}catch(e){console.error(e)}<\/script>` : ''}</body></html>`;

  // 同样的内容复用同一个 id，避免反复渲染时堆积
  const id = crypto.createHash('sha1').update(body).digest('hex').slice(0, 24);
  if (fragments.has(id)) {
    fragments.get(id).at = Date.now();
    return id;
  }
  fragments.set(id, { body, at: Date.now() });
  fragBytes += body.length;
  evictFragments();
  return id;
}

function serveFragment(res, id) {
  const f = fragments.get(id);
  if (!f) return json(res, 404, { error: 'FRAGMENT_GONE' });
  f.at = Date.now();
  const buf = Buffer.from(f.body, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // 片段由用户自己放入，隔离到独立 origin 会破坏交互，这里只给最小限制
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

/* ── 静态资源 ───────────────────────────────────────────── */

async function serveStatic(res, pathname) {
  const rel = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'FORBIDDEN' });
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return json(res, 404, { error: 'NOT_FOUND' });
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 页面和脚本一律不缓存：改完刷新就是新版，不用让用户手动清缓存
      'Cache-Control': 'no-cache, must-revalidate',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'NOT_FOUND' });
  }
}

/* ── 模型列表 ───────────────────────────────────────────── */
/* 用访客自己的 Key 问该服务商「你能用哪些模型」。
   503 model routing unavailable 这类错误基本都是模型名和服务商对不上， */
/* 让界面直接把可选列表摆出来，比让用户猜名字可靠得多。 */

/** 取模型 id 列表；拿不到就返回 null（表示「无法判断」，不是「没有」） */
async function fetchModelIds(baseUrl, apiKey, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!upstream.ok) return null;
    const data = await upstream.json().catch(() => null);
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const ids = list
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || ''))
      .filter(Boolean);
    return ids.length ? ids : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleModels(req, res, user) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 256 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }

  let baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
  let apiKey = String(payload.apiKey || '').trim();
  if (!apiKey) {
    // 界面已经保存过的话，Key 在账号里，不必每次重填
    const acct = await getAccountConfig(user);
    if (acct) { baseUrl = baseUrl || acct.baseUrl; apiKey = acct.apiKey; }
  }
  if (!baseUrl || !apiKey) {
    return json(res, 400, { error: 'NO_KEY', message: '先填 Base URL 和 API Key，再拉模型列表' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.message || text;
      } catch { /* 保留原文 */ }
      return json(res, 200, {
        models: [],
        warning: `这个服务商不支持列出模型（HTTP ${upstream.status}）。${String(detail).slice(0, 160)}`,
      });
    }

    const data = await upstream.json().catch(() => null);
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = list
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || ''))
      .filter(Boolean)
      .sort();

    return json(res, 200, { models });
  } catch (err) {
    if (controller.signal.aborted) {
      return json(res, 200, { models: [], warning: '拉取模型列表超时，可能是网络不通或服务商不支持' });
    }
    return json(res, 200, { models: [], warning: `拉取失败：${err.message}` });
  } finally {
    clearTimeout(timer);
  }
}

/* ── 单模型探活 ─────────────────────────────────────────── */
/* 模型列表是静态的，别名（比如 relay 上的 Catsco）不一定出现在里面，
   却可能真的能用。所以「能不能用」只有一个可靠判据：真发一次最小请求。 */

async function handleTestModel(req, res, user) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 256 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }

  let baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
  let apiKey = String(payload.apiKey || '').trim();
  const model = String(payload.model || '').trim();
  if (!apiKey) {
    const acct = await getAccountConfig(user);
    if (acct) { baseUrl = baseUrl || acct.baseUrl; apiKey = acct.apiKey; }
  }
  if (!baseUrl || !apiKey || !model) {
    return json(res, 400, { error: 'INCOMPLETE', message: 'Base URL、API Key、模型名都要填' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '说一个字：好' }],
        max_tokens: 8,
        stream: false,
      }),
    });

    const text = await upstream.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 原文兜底 */ }

    if (!upstream.ok) {
      const detail = parsed?.error?.message || parsed?.message || text;
      const msg = String(detail || '').slice(0, 300);

      // 只认 responses 的模型，改道再试一次，避免误判成「不能用」
      if (RESPONSES_ONLY_RE.test(msg)) {
        const alt = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: [{ role: 'user', content: '说一个字：好' }],
            stream: false,
          }),
        });
        const altText = await alt.text().catch(() => '');
        let altParsed = null;
        try { altParsed = JSON.parse(altText); } catch { /* 原文 */ }
        if (alt.ok) {
          const out = altParsed?.output_text
            || (Array.isArray(altParsed?.output)
              ? altParsed.output.flatMap((o) => (o?.content || []).map((c) => c?.text || '')).join('')
              : '');
          return json(res, 200, {
            ok: true,
            status: alt.status,
            model: altParsed?.model || model,
            protocol: 'responses',
            reply: typeof out === 'string' ? out.slice(0, 60) : '',
            note: '这个模型走 responses 协议，已经自动适配，可以正常对话。',
          });
        }
        const altMsg = String(altParsed?.error?.message || altText || '').slice(0, 240);
        return json(res, 200, {
          ok: false,
          status: alt.status,
          message: altMsg,
          verdict: 'protocol',
          hint: `这个模型不走对话接口，改走 responses 也失败了。换 glm-5.3-flash 或 claude-sonnet-5-5 试试。`,
        });
      }

      // 有些网关（relay 就是）对「模型名不存在」和「Key 无效」返回同一句话，
      // 单看正文分不出来。这时用模型列表交叉核对：列表里有这个模型，
      // 说明名字没问题，问题在 Key 或权限；列表里没有，才可能是名字不对。
      let hint = diagnose(upstream.status, msg, { model });
      let verdict = 'unknown';
      const ids = await fetchModelIds(baseUrl, apiKey);
      if (ids) {
        const listed = ids.some((id) => id.toLowerCase() === model.toLowerCase());
        if (listed) {
          verdict = 'key';
          hint = `「${model}」在这个服务商的列表里，名字没问题，所以问题在 Key 或权限：Key 可能不对、没余额，或这个 Key 无权用该模型。`;
        } else {
          verdict = 'model';
          hint = `「${model}」不在这个服务商的模型列表里，而且真发请求也失败了。大概率是模型名不对 —— 从下面的列表里挑一个试试。`;
        }
      } else if (upstream.status === 503) {
        hint = '服务商返回 503，但拿不到它的模型列表来对照，没法确定是模型名还是 Key 的问题。先确认 Key 有效，再从列表里挑一个已知的模型试。';
      }

      return json(res, 200, {
        ok: false,
        status: upstream.status,
        message: msg,
        verdict,
        hint,
      });
    }

    const reply = parsed?.choices?.[0]?.message?.content;
    return json(res, 200, {
      ok: true,
      status: upstream.status,
      model: parsed?.model || model,
      reply: typeof reply === 'string' ? reply.slice(0, 60) : '',
    });
  } catch (err) {
    if (controller.signal.aborted) {
      return json(res, 200, { ok: false, message: '请求超时（30 秒）', hint: '检查 Base URL 是否可达，或换一个模型试试' });
    }
    return json(res, 200, { ok: false, message: err.message, hint: '连不上这个地址，检查 Base URL 和网络' });
  } finally {
    clearTimeout(timer);
  }
}

/* ── 流式对话代理 ───────────────────────────────────────── */

/** 把上游的错误翻译成「该改什么」，比原样抛一串英文有用 */
function diagnose(status, message, provider) {
  const m = message.toLowerCase();
  const model = provider?.model || '当前模型';

  /* relay 的额度预检偶发不可用，跟用户的配置无关，说清楚比让他瞎改配置好 */
  if (m.includes('credit_preflight') || m.includes('preflight_unavailable')) {
    return '这是 relay 侧的额度预检服务临时不可用，不是你的 Key 或模型名有问题，通常几十秒内自己恢复。已经自动重试过；还不行就等一会儿再发。';
  }

  if (status === 503 && (m.includes('routing') || m.includes('no available'))) {
    return `这个服务商不认模型名「${model}」。点「拉取可用模型」从列表里选，或去服务商后台确认真实名字。`;
  }
  if (status === 404) {
    return '接口地址不对。Base URL 通常要以 /v1 结尾，例如 https://api.deepseek.com/v1';
  }
  if (status === 401 || status === 403 || m.includes('invalid api key') || m.includes('unauthorized')) {
    return 'Key 无效或没权限。确认 Key 没复制错、没过期，并且这个 Key 有权用该模型。';
  }
  if (status === 400 && (m.includes('model') || m.includes('does not exist'))) {
    return `模型名「${model}」不被接受。点「拉取可用模型」看看这个 Key 实际能用什么。`;
  }
  if (status === 429) {
    return '请求太频繁或额度用完了。等一会儿再试，或换一个 Key。';
  }
  if (status === 402 || m.includes('insufficient') || m.includes('balance')) {
    return '账户余额不足，去服务商后台充值。';
  }
  if (status >= 500) {
    return '服务商自己出错了，通常等几分钟会恢复。持续出现就换一个服务商。';
  }
  return '';
}

/* ── Responses 协议兼容 ───────────────────────────────────── */
/* relay 上有些模型（deepseek-flash、gpt-6-sol）只支持 /v1/responses，
   走 chat/completions 会 400 chat_completions_disabled。
   这里自动改道，并把 responses 的流式事件翻成前端认的 chat 分片格式。 */

const RESPONSES_ONLY_RE = /chat_completions_disabled|responses[-_ ]?only|not supported for chat/i;

function toResponsesInput(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const role = m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user';

    /* 多模态：content 是数组（带网页截图）时要拆成文本和图片两种 part。
       直接 String() 会把图片变成一个无意义的 "[object Object]"，图就丢了。 */
    if (Array.isArray(m.content)) {
      const parts = m.content.map((part) => {
        if (part?.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          return url ? { type: 'input_image', image_url: url } : null;
        }
        if (typeof part?.text === 'string') return { type: 'input_text', text: part.text };
        return null;
      }).filter(Boolean);
      return { role, content: parts };
    }

    const text = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    return { role, content: text };
  });
}

function callResponses(provider, messages, signal) {
  return fetch(`${provider.baseUrl}/responses`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      input: toResponsesInput(messages),
      temperature: provider.temperature,
      stream: true,
    }),
  });
}

/** 把 responses 的 SSE 流翻译成 chat/completions 的分片，前端无需改动 */
async function pipeResponsesAsChat(upstream, res, controller) {
  // 头可能已经被心跳提前写过了，这里只兜底
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  /* 走 responses 时上游要先想很久才吐第一个字。
     这段时间网关收不到任何数据，会在 60 秒时直接 504 ——
     前端就只看到一句英文 network error。
     所以这里也要像走 chat 那样定期发注释行保活。 */
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* 连接已断 */ }
  }, 4000);
  beat.unref?.();

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const emit = (text) => {
    if (!text) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  };

  try {
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
        // 思考摘要：只有 responses 协议会吐这一段
        if (j.type === 'response.reasoning_summary_text.delta' && typeof j.delta === 'string') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: j.delta } }] })}\n\n`);
        } else if (j.type === 'response.reasoning_text.delta' && typeof j.delta === 'string') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: j.delta } }] })}\n\n`);
        } else if (j.type === 'response.output_text.delta' && typeof j.delta === 'string') {
          emit(j.delta);
        } else if (j.type === 'response.output_text.done' && typeof j.text === 'string' && !j.__seen) {
          // 有的实现只给最终整段，前面没发过 delta 时用它兜底
        } else if (j.type === 'error' || j.error) {
          res.write(`data: ${JSON.stringify({ error: { message: j.error?.message || j.message || '模型报错' } })}\n\n`);
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
    }
  } finally {
    clearInterval(beat);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/* ── 联网能力：抓网页 / 搜索 ──────────────────────────────── */
/* 走 relay 的 deepseek tools 通道，用账号自己的 Key 鉴权。
   有些站是单页应用，relay 只回标题没正文，这时用无头 Chrome 真渲染一遍再抽文字。 */

import { execFile } from 'node:child_process';

const RELAY_TOOLS = 'https://relay.catsco.cc/v1/tools';

function runChromeDump(url, timeoutMs = 22000) {
  return new Promise((resolve) => {
    execFile('google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--virtual-time-budget=6000', '--dump-dom', url,
    ], { timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve('');
      resolve(String(stdout || ''));
    });
  });
}

/**
 * 用真浏览器渲染整页：等脚本跑完、滚到底把懒加载拉出来，再取可见文字。
 * 单页应用和需要滚动才出内容的站点只有这条路能读到东西。
 */
function renderPage(url, { scroll = true, waitMs = 4200, shot = false } = {}) {
  return new Promise((resolve) => {
    const args = [path.join(HERE, 'render-page.mjs'), url, '--wait', String(waitMs)];
    if (scroll) args.push('--scroll');
    if (shot) args.push('--shot');
    execFile(process.execPath, args, { timeout: 68000, maxBuffer: 24 * 1024 * 1024 }, (err, stdout, stderr) => {
      // 失败要留下痕迹，否则只能看到"没抓到"，不知道卡在哪
      if (err) console.error('[render] 失败', err.killed ? 'killed' : err.code || '', String(err.message).slice(0, 200));
      if (stderr) console.error('[render] stderr', String(stderr).slice(0, 600));
      if (!stdout) return resolve(null);
      try { resolve(JSON.parse(String(stdout).trim())); } catch (e) {
        console.error('[render] 输出不是 JSON，长度', String(stdout).length, String(e.message).slice(0, 80));
        resolve(null);
      }
    });
  });
}

/** 从 HTML 里抽出可读正文：去脚本样式、保留标题和可见文字 */
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // 去掉不可见区块
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  // 链接和图片在提取文字前留个标记，方便模型知道有可点的东西
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return ' ';
    if (/^(javascript:|#)/i.test(href)) return ` ${t} `;
    return ` ${t} <${href}> `;
  });

  // 块级元素断行
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|header|footer|main|nav)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');

  // 反转义常见实体
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  // 收空格
  s = s.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function pageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** 调 relay tools；失败不抛，返回 null 让上层走渲染兜底 */
async function relayTool(lane, body, apiKey, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${RELAY_TOOLS}/${lane}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ── 组件源码补给 ───────────────────────────────────────────
   用户常常是手动把「Copy prompt」粘进来。那段文字只是"装哪个包、
   传哪些参数"的说明，里面没有实现，照着它写只能凭参数名编一个近似渐变，
   做出来必然不像。

   这里按组件名去开源仓库把真正的实现（含 shader）取回来，
   再交给模型照着移植。只取公开仓库里的源文件，不碰用户任何数据。 */

const RB_REPO = 'https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/content';
const RB_CATS = ['Backgrounds', 'Animations', 'Components', 'TextAnimations'];

const sourceCache = new Map();   // name -> { code, css, file, category } | null

async function fetchComponentSource(name) {
  if (!/^[A-Za-z][A-Za-z0-9]{1,40}$/.test(name)) return null;
  if (sourceCache.has(name)) return sourceCache.get(name);

  for (const cat of RB_CATS) {
    for (const ext of ['jsx', 'tsx', 'js']) {
      const base = `${RB_REPO}/${cat}/${name}/${name}`;
      const url = `${base}.${ext}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) continue;
        const code = await res.text();
        if (code.length < 200) continue;

        let css = '';
        try {
          const c = await fetch(`${base}.css`, { signal: AbortSignal.timeout(8000) });
          if (c.ok) css = (await c.text()).slice(0, 8000);
        } catch { /* 没有样式文件很正常 */ }

        const out = {
          name,
          category: cat,
          file: `${name}.${ext}`,
          code: code.slice(0, 60000),
          css,
        };
        sourceCache.set(name, out);
        return out;
      } catch { /* 换个路径继续试 */ }
    }
  }

  sourceCache.set(name, null);
  return null;
}

async function handleSourceLookup(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }

  const name = String(payload.name || '').trim();
  if (!name) return json(res, 400, { error: 'NO_NAME', message: '缺少组件名' });

  const found = await fetchComponentSource(name);
  if (!found) return json(res, 200, { ok: false, name, message: '仓库里没找到这个组件的源码' });

  return json(res, 200, {
    ok: true,
    name: found.name,
    category: found.category,
    file: found.file,
    code: found.code,
    css: found.css,
  });
}

/** 用公共 DoH 解析域名：系统 DNS 被污染时，问得到真实 IP */
async function resolveViaDoh(host, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://doh.pub/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      signal: controller.signal,
      headers: { accept: 'application/dns-json' },
    });
    if (!res.ok) return [];
    const j = await res.json().catch(() => null);
    const answers = Array.isArray(j?.Answer) ? j.Answer : [];
    return answers.filter((a) => a.type === 1).map((a) => a.data).slice(0, 4);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* 服务端出网被定向挡住时（DNS 把域名指到无关 IP，或 TLS 握手被重置），
   直连和本地无头 Chrome 都会失败 —— 表现就是前端看到的"拒绝连接"。
   这时改走墙外的只读代理取一次：它在境外读页面、洗成正文再传回来，
   不受本地 DNS 和 SNI 影响，也不要求目标站支持跨域。 */
const READER_ENDPOINT = 'https://api.microlink.io/';

/** 快速探一下这台机器能不能直连目标站。
    探不通就别去开无头 Chrome 空等一分钟，直接换代理。 */
async function quickReachable(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QBoard/1.0)' },
    });
    return res.ok || (res.status >= 200 && res.status < 400);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaReader(url, timeoutMs = 28000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const q = new URLSearchParams({
      url,
      'data.content.selector': 'body',
      'data.content.type': 'text',
    });
    const res = await fetch(`${READER_ENDPOINT}?${q}`, { signal: controller.signal });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (j?.status !== 'success') return null;
    const d = j.data || {};
    const raw = typeof d.content === 'string' ? d.content : '';
    if (!raw) return null;
    const text = htmlToText(raw);
    if (!text) return null;
    return { title: String(d.title || ''), text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleFetchPage(req, res, user) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 256 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }

  const raw = String(payload.url || '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    return json(res, 400, { error: 'BAD_URL', message: '只接受 http 或 https 开头的网址' });
  }

  const acct = await getAccountConfig(user);
  let title = '';
  let text = '';
  let via = '';
  let screenshot = '';
  let blocked = false;

  /* 先花几秒探一下这台机器到目标站通不通。
     有些域名在这里被解析到无关 IP、TLS 握手直接被重置，
     硬跑无头 Chrome 只会白等一分钟，最后拿回一句"拒绝连接"。
     探不通就跳过浏览器渲染，直接走墙外的只读代理。 */
  blocked = !(await quickReachable(raw));

  /* 文字和画面一起取，两条路并行跑，别把等待叠成两次。
     relay 给的是干净文本，浏览器渲染给的是真实画面 ——
     照着网页做效果时，颜色、密度、布局只有画面能说清。 */
  const [relayRes, page] = blocked
    ? [acct?.apiKey ? await relayTool('fetch', { url: raw }, acct.apiKey, 25000) : null, null]
    : await Promise.all([
      acct?.apiKey ? relayTool('fetch', { url: raw }, acct.apiKey, 30000) : Promise.resolve(null),
      /* 效果类页面要等 canvas 画出来才截得到东西。
         实测等 2.6 秒截出来是全黑，等 6 秒才有真实画面。 */
      renderPage(raw, { scroll: false, waitMs: 5600, shot: true }),
    ]);

  if (relayRes && typeof relayRes.content === 'string' && relayRes.content.length > 200) {
    title = String(relayRes.title || '');
    text = relayRes.content;
    via = 'relay';
  }

  if (page?.screenshot) {
    // 太大的图会拖慢请求，直接丢掉，宁可只给文字
    screenshot = page.screenshot.length > 900000 ? '' : page.screenshot;
  }

  // 浏览器渲染的文字通常更全（导航 + 正文），取更长的那份
  if (page?.ok && typeof page.text === 'string' && page.text.length > text.length) {
    text = page.text;
    title = title || page.title || '';
    via = via ? `${via}+browser` : 'browser';
  }

  /* 直连和本地无头 Chrome 都没拿到东西时，多半是服务端出网被挡住了：
     域名被解析到无关 IP，或者 TLS 握手被重置。这时候再走墙外的只读代理补一次，
     否则前端只会看到一句"拒绝连接"，而站点本身其实好好的。 */
  if (text.trim().length < 200) {
    const viaReader = await fetchViaReader(raw);
    if (viaReader && viaReader.text.length > text.length) {
      text = viaReader.text;
      title = title || viaReader.title;
      via = via ? `${via}+reader` : 'reader';
    }
  }

  if (!text.trim() && !screenshot) {
    return json(res, 200, {
      ok: false,
      url: raw,
      message: '这个地址没抓到可读正文。可能是登录后才可见、需要交互，或者服务端到该站的网络被阻断。',
    });
  }

  return json(res, 200, {
    ok: true,
    url: raw,
    title: title || raw,
    content: text.slice(0, 24000),
    truncated: text.length > 24000,
    via,
    // base64 JPEG，前端自己拼 data URL
    screenshot,
    hasImage: Boolean(screenshot),
    // 页面自带的「复制提示词 / 复制代码」内容，比截图更权威
    prompt: String(page?.prompt || '').slice(0, 30000),
    // 这次拿到的是"源码"还是"集成说明"，前端据此标注
    promptKind: String(page?.promptKind || ''),
    codeBlocks: Array.isArray(page?.codeBlocks) ? page.codeBlocks.slice(0, 4) : [],
    hasPrompt: Boolean(page?.prompt),
  });
}

async function handleSearchWeb(req, res, user) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }

  const query = String(payload.query || '').trim();
  if (!query) return json(res, 400, { error: 'NO_QUERY', message: '缺少 keywords' });

  const acct = await getAccountConfig(user);
  if (!acct?.apiKey) {
    return json(res, 400, { error: 'NO_KEY', message: '这个账号还没配置模型，联网搜索也没法计费' });
  }

  const count = Math.min(Math.max(Number(payload.count) || 6, 1), 12);
  const r = await relayTool('search', { query: query.slice(0, 128), count }, acct.apiKey, 40000);
  if (!r || !Array.isArray(r.results)) {
    return json(res, 200, { ok: false, results: [], message: '搜索没返回结果，可能是网络或额度问题' });
  }

  const results = r.results.slice(0, count).map((x) => ({
    title: String(x.title || ''),
    url: String(x.url || ''),
    site: String(x.site_name || ''),
    summary: String(x.summary || x.snippet || '').slice(0, 1200),
    date: x.date || null,
  }));

  return json(res, 200, { ok: true, query, results });
}

async function handleChat(req, res, user) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return json(res, 400, { error: 'BAD_BODY', message: err.message });
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages?.length) return json(res, 400, { error: 'BAD_MESSAGES', message: '缺少 messages' });

  const provider = await resolveProvider(payload.provider, user);
  if (!provider) {
    return json(res, 400, {
      error: 'NO_KEY',
      message: '这个账号还没有配置模型。点右上角「模型」填一次，之后换设备登录也会自动带出来。',
    });
  }

  const controller = new AbortController();

  /* 模型要拿着几千字网页原文思考几十秒，这期间如果服务端一个字节都不发，
     网关会在 60 秒时直接返回 504。所以先把 SSE 头写出去，再定时发注释行
     保持连接活跃——前端只认 data: 行，注释会被忽略，不影响解析。 */
  let heartbeat = null;
  let sseOpen = false;

  const openSse = () => {
    if (sseOpen || res.headersSent) return;
    sseOpen = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try { res.flushHeaders?.(); } catch { /* 老 Node 没有这个方法 */ }
    res.write(': open\n\n');
    heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 连接已断 */ }
    }, 4000);
    heartbeat.unref?.();
  };

  const closeSse = () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };

  /** 已经开了 SSE 就不能再回 JSON，错误也走事件流，前端照样能弹出原因 */
  const sseError = (message, hint) => {
    closeSse();
    const text = hint ? `${message}\n\n${hint}` : message;
    try {
      res.write(`data: ${JSON.stringify({ error: { message: text } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { /* 已经写不出去了 */ }
  };

  req.on('close', () => { controller.abort(); closeSse(); });

  openSse();

  /* 思考摘要只有 responses 协议会返回，普通对话接口只给一个 token 计数。
     对已知支持 responses 的模型先走那条路；不通再退回 chat，不影响可用性。 */
  const preferResponses = /deepseek-flash|gpt-6(?:\.1)?-sol/i.test(provider.model);
  if (preferResponses) {
    let alt = null;
    try { alt = await callResponses(provider, messages, controller.signal); } catch { alt = null; }
    if (alt && alt.ok && alt.body) {
      closeSse();
      return pipeResponsesAsChat(alt, res, controller);
    }
  }

  /* relay 的额度预检偶尔会 503 credit_preflight_unavailable，
     这类是瞬时的，隔一两秒重试基本就过去了。
     只在"还没开始吐内容"时重试，不会重复输出。 */
  const TRANSIENT_RE = /credit_preflight_unavailable|overloaded|temporarily|try again|unavailable/i;

  let upstream = null;
  let upstreamText = '';
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          temperature: provider.temperature,
          stream: true,
        }),
      });
    } catch (err) {
      lastErr = err;
      upstream = null;
      if (controller.signal.aborted) break;
    }

    if (upstream && upstream.ok && upstream.body) break;

    if (upstream) upstreamText = await upstream.text().catch(() => '');
    if (!upstream && controller.signal.aborted) break;

    const status = upstream ? upstream.status : 0;
    const transient = !upstream
      || status === 502 || status === 503 || status === 504 || status === 429
      || TRANSIENT_RE.test(upstreamText);

    if (!transient || attempt === 2) break;

    // 心跳还在跑，重试时前端不会看着像卡死
    try { res.write(': retry\n\n'); } catch { /* 连接已断 */ }
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }

  if (!upstream) {
    if (controller.signal.aborted) { closeSse(); return res.end(); }
    return sseError(
      `连不上 ${provider.baseUrl}：${lastErr?.message || '网络错误'}`,
      '检查 Base URL 和网络。'
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = upstreamText || (await upstream.text().catch(() => ''));
    let message = text;
    try {
      const j = JSON.parse(text);
      message = j?.error?.message || j?.message || text;
    } catch { /* 保留原文 */ }

    // 这个模型只认 responses 协议时，自动改道再试一次，不劳用户改配置
    if (RESPONSES_ONLY_RE.test(String(message))) {
      let alt;
      try {
        alt = await callResponses(provider, messages, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) { closeSse(); return res.end(); }
        return sseError(`连不上 ${provider.baseUrl}/responses：${err.message}`);
      }
      if (alt.ok && alt.body) {
        closeSse();
        return pipeResponsesAsChat(alt, res, controller);
      }
      const altText = await alt.text().catch(() => '');
      let altMsg = altText;
      try { altMsg = JSON.parse(altText)?.error?.message || altText; } catch { /* 原文 */ }
      return sseError(
        `这个模型不支持对话接口，改走 responses 也失败了：${String(altMsg).slice(0, 240)}`,
        '换一个支持 chat/completions 的模型试试，relay 上 glm-5.3-flash、claude-sonnet-5-5、MiniMax-M3 都可以。'
      );
    }

    return sseError(
      `模型返回 ${upstream.status}：${String(message).slice(0, 300)}`,
      diagnose(upstream.status, String(message), provider)
    );
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(dec.decode(value, { stream: true }));
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
    }
  } finally {
    res.end();
  }
}

/* ── 路由 ───────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);

  try {
    /* 网关用它确认这个端口确实是这个应用 */
    if (p === '/.well-known/catsco-app.json') {
      return json(res, 200, { contract: 'catsco.artifact-identity.v1', app_id: APP_ID });
    }

    /* ── 登录门 ─────────────────────────────────────────── */
    /* 这几个是唯一不需要会话的入口，网关也靠 /.well-known 校验归属 */
    if (p === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (p === '/api/logout' && req.method === 'POST') return handleLogout(res);
    if (p === '/api/session' && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleSession(req, res);
    }

    const user = await currentUser(req);
    if (!user) {
      if (p === '/' || p === '/index.html') return serveLoginPage(res);
      return unauthorized(res, p);
    }

    if (p === '/api/health') return json(res, 200, { ok: true, name: 'qboard', appId: APP_ID });

    if (p === '/api/meta' && req.method === 'GET') {
      return json(res, 200, { presets: PRESETS, appId: APP_ID, origin: PUBLIC_ORIGIN });
    }

    if (p === '/api/provider') {
      if (req.method === 'GET') return handleGetProvider(req, res, user);
      if (req.method === 'POST') return handleSetProvider(req, res, user);
      if (req.method === 'DELETE') {
        await setAccountConfig(user, { clearKey: true });
        return json(res, 200, { configured: false, user });
      }
    }

    if (p === '/api/fetch' && req.method === 'POST') return handleFetchPage(req, res, user);

    // 按组件名去开源仓库取真实实现，给"只拿到集成说明"的场景补源码
    if (p === '/api/source' && req.method === 'POST') return handleSourceLookup(req, res);

    if (p === '/api/search' && req.method === 'POST') return handleSearchWeb(req, res, user);

    if (p === '/api/doc') {
      if (req.method === 'GET') return handleGetDoc(req, res, user);
      if (req.method === 'PUT' || req.method === 'POST') return handleSetDoc(req, res, user);
    }

    if (p === '/api/prefs') {
      if (req.method === 'GET' || req.method === 'HEAD') return handleGetPrefs(req, res, user);
      if (req.method === 'PUT' || req.method === 'POST') return handleSetPrefs(req, res, user);
    }

    if (p === '/api/models' && req.method === 'POST') return handleModels(req, res, user);

    if (p === '/api/test-model' && req.method === 'POST') return handleTestModel(req, res, user);

    if (p === '/api/frag' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); }
      catch (err) { return json(res, 400, { error: 'BAD_BODY', message: err.message }); }
      const id = storeFragment(body.html, body.css, body.js);
      return json(res, 200, { id, url: `frag/${id}` });
    }

    if (p.startsWith('/frag/')) return serveFragment(res, p.slice(6));

    if (p === '/api/chat' && req.method === 'POST') return handleChat(req, res, user);

    if (p.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });

    return serveStatic(res, p);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: 'SERVER_ERROR', message: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`QBoard → http://${HOST}:${PORT}  (app_id=${APP_ID})`);
  console.log(`config: ${CONFIG_PATH}`);
});
