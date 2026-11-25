# QBoard

一块真的能摆东西的画布。任何素材丢进来都保持原样：GIF 会动、SVG 动画会跑、视频会播、HTML 里的脚本和 hover 效果都活着。你可以像 Figma 一样拖、缩放、旋转、调层级；选中任意一个元素，跟 AI 说一句，它只改那一个。最后导出一个自包含的 HTML。

零依赖，只用 Node 内置模块。

---

## 公网地址

已发布到 Artifact：

- https://artifact.catsco.cc/qboard/
- https://artifact.catsco.cn/qboard/   （同一份）

公网版和本地版有两点区别，都是从「这地址是公开的」这个前提出发的：

1. **模型 Key 存在你自己的浏览器里**，随请求带给服务端，服务端只用一次、不写盘。所以你填的 Key 别人看不到，别人用这个站也不会花你的额度。
2. **HTML 片段改走同源地址**（`frag/<id>`），不发 `srcdoc`。因为网关给页面加了 CSP `script-src 'self'`，`srcdoc` 会继承这条策略，片段里的 `<script>` 会被直接拦掉 —— 那样「改成 hover 触发」这类交互改写就只剩样式生效、逻辑全丢。换成同源地址后片段在自己的文档里跑，CSP 不再继承。

两个 systemd 服务撑着它：`catsco-artifact-qboard`（隧道）和 `catsco-artifact-qboard-app`（本体，端口 7788）。

## 三步开始

```bash
cd qboard
./start.sh          # 或 node server.mjs
```

打开 http://localhost:7788 。第一次会弹配置面板：选服务商预设、粘 API Key、保存并测试。

也可以直接改 `config.json`：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-你的key",
  "model": "deepseek-chat",
  "temperature": 0.75
}
```

---

## 能放什么

| 类型 | 表现 |
| --- | --- |
| PNG / JPG / WebP | 正常的静态图，大图自动压到 1600px |
| GIF / 动画 WebP | 原字节保留，在画布上一直动 |
| SVG | 直接渲染，里面带 `<animate>` 也会跑 |
| 视频 mp4 / webm / mov | 自动循环播放 |
| 音频 mp3 / wav / m4a | 就地出现播放器 |
| HTML 文件 | 拆成结构 / 样式 / 脚本三段，在 iframe 里真实运行 |
| PDF | 内嵌浏览器阅读器，可翻页 |
| txt / md / json / csv / 代码 | 画布上显示前 4000 字，导出用完整原文 |
| 其它任意文件 | 卡片形式保留原件，导出后点一下仍能下载 |

---

## 怎么用

**摆** — 拖文件进画布、⌘V 粘图、点「＋文本 / ＋形状 / ＋HTML」。多文件同时落下会自动级联错开，不会叠成一坨。

**改** — 拖拽移动，八个方向缩放，顶部圆点旋转，靠近其它元素和画板中线会吸附对齐。右侧面板精调坐标、圆角、透明度、文字样式、动效参数。

**动效** — 每个元素可独立配入场（淡入 / 上浮 / 弹出 / 滑入 / 模糊聚焦 / 长大）和循环（漂浮 / 呼吸 / 旋转 / 摇摆 / 闪烁），时长、延迟、缓动都能改。编辑时保持静止免得晃眼，点「预览」或元素面板里的「重播」才跑。

**问 AI** — 右下角对话窗。选中什么就改什么：

- 选中一个 logo 说「2 秒后开始慢慢漂浮，一个周期 4 秒」→ 只改这个 logo 的动效
- 选中一个每 5 秒闪一次的 HTML 卡片说「改成鼠标移上去才亮」→ 它直接改写这个元素内部的 CSS/JS，把定时动画换成 `:hover`
- 什么都没选就问「帮我排得更有呼吸感」→ 调整整体布局

AI 输出的是 JSON 补丁（`{ops:[...], say:"..."}`），不是重新生成整页，所以你手摆的位置不会被冲掉。

**动效组件** — 内置 16 套可直接用的动态组件，移植自 [React Bits](https://reactbits.dev) 的四大类：

| 分类 | 组件 |
| --- | --- |
| Text Animations | SplitText 逐字入场、ShinyText 流光文字、GradientText 渐变文字、DecryptedText 解码文字、CountUp 数字滚动 |
| Animations | BlurText 模糊渐显、MagnetLines 磁吸点阵、ClickSpark 点击迸发 |
| Components | SpotlightCard 聚光卡片、StarBorder 描边流光、TiltCard 3D 倾斜 |
| Backgrounds | Aurora 极光、Particles 粒子、GridMotion 网格流光 |
| Micro Interactions | MagneticButton 磁吸按钮、GlareHover 悬停扫光 |

React Bits 原版是 React 组件（每个组件有 JS-CSS / JS-TW / TS-CSS / TS-TW 四种口味，走 shadcn MCP 安装）。画布里跑的是 HTML 片段，所以这里是等价移植：全部改写成不依赖任何库的原生 HTML + CSS + JS，粘进 `type:"html"` 元素就能跑，也不用引 CDN。

说「来个流光文字」「粒子背景」「聚光卡片」，AI 会直接拿到对应组件的完整实现再落补丁，不是凭印象重写一个像样的效果。没有精确命中时，它会拿到一份 llms.txt 风格的目录自己挑。

**导出** — 右上角「导出」得到单个 `.html`，双击能看。布局、层级、旋转、动效、HTML 内部的交互全部保留，素材都是 data URL 所以文件自包含。多块画布会拼成一页纵向连贯滚动的长页面，段与段之间没有缝隙。

---

## 快捷键

| | |
| --- | --- |
| `V` / `T` / `R` | 选择 / 文字 / 形状 |
| 空格 + 拖 | 平移画布 |
| ⌘滚轮 / 双指捏合 | 以光标为中心缩放 |
| ⇧1 | 适应画布 |
| ⌘D | 复制 | 
| ⌫ | 删除 |
| ⌘Z / ⇧⌘Z | 撤销 / 重做 |
| ⌘E | 浏览器里预览导出效果 |
| ⌘S | 导出文件 |
| ⌘K | 打开对话 |
| 双击文字 | 就地编辑 |
| 双击 HTML 元素 | 进入交互模式，可直接点里面的按钮试效果 |
| Esc | 退出预览 / 交互 / 取消选中 |

---

## 换模型

任何兼容 `/v1/chat/completions` 的服务都能接。内置：DeepSeek、OpenAI、通义千问、智谱 GLM、Moonshot、Ollama 本地。

建议用长上下文、代码能力强的（DeepSeek-V3、GPT-4o、Qwen-Max 这档）。改 HTML 内部交互吃代码理解能力，小模型容易只改表面样式。

改生成策略看 `public/js/app.js` 里的 `SYS_PROMPT`。

---

## 给其他人用

默认只监听本机。分享有两种方式：

```bash
HOST=0.0.0.0 PORT=7788 node server.mjs
```

局域网内其他人用 `http://你的内网IP:7788` 打开。

放公网就在前面挂 nginx / Caddy 反代并配 HTTPS，**必须加访问控制**——`/api/chat` 花的是你的 Key。最简单的 Caddy 写法：

```
qboard.yourdomain.com {
  basicauth {
    you $2a$14$哈希值
  }
  reverse_proxy 127.0.0.1:7788
}
```

---

## 结构

```
qboard/
├── server.mjs              静态服务 + 配置读写 + 流式代理（零依赖）
├── public/
│   ├── index.html          界面骨架
│   ├── styles.css          视觉层
│   └── js/
│       ├── app.js          主控：导入、属性面板、agent 补丁、导出
│       ├── canvas.js       画布引擎：变换、吸附、浮层、行内编辑
│       ├── store.js        项目状态、IndexedDB 持久化、撤销栈
│       ├── anim.js         动效定义，编辑器与导出共用同一份 keyframes
│       └── export.js       导出为自包含单文件 HTML
├── config.json             ← 你的 Key 在这
└── start.sh                双击启动
```

几个实现要点：

- **HTML 拆三段**：导入 HTML 文件时用 `DOMParser` 拆成 body 结构、`<style>`、`<script>`，分别存 `html` / `css` / `js`。AI 改交互时改的就是这三段，改完重新塞回 iframe 的 srcdoc。这就是「5 秒闪一次 → 鼠标移上去才亮」能实现的原因。
- **动图不重编码**：JPEG/PNG 超过阈值会压到 1600px，但 GIF 只要一走 canvas 就退化成单帧，所以 GIF 原字节直传。
- **坐标单一来源**：节点的 x/y/w/h 都是画板内像素，旋转绕中心。缩放手柄用鼠标点在元素本地坐标系里算，所以旋转过的元素拖角也跟手。
- **状态存 IndexedDB**：data URL 动辄几 MB，localStorage 顶不住。DB 打不开或有超时会自动退回 localStorage，不会白屏。
- **补丁白名单**：AI 返回的 set 只接受已知字段，越界的键直接丢掉，防止模型把 `src` 之类改成乱七八糟的东西。

---

## 已知边界

- 视频、PDF、未知二进制都以 data URL 内嵌，导出文件可能很大（几十 MB）。真要发布建议压一下源文件。
- 链接只作为文本线索，不抓网页内容（跨域和反爬不可靠）。想收录某页就粘正文或截图。
- 单 Key 单画布，没做多用户隔离。给多人用各自 Key 需要改 `server.mjs` 的 `loadConfig()` 增加用户维度。
- HTML 元素的 iframe 用 `allow-same-origin`，是为了让内部脚本能读到自己的 DOM 做交互；这意味着不能往画布里放来源不可信的第三方页面。
