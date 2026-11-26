**[中文](README.md) · [English](README.en.md)**

# QBoard

A canvas where you can actually put things. Whatever you drop in stays exactly as it was: GIFs keep animating, SVG animations keep running, videos keep playing, and the scripts and hover effects inside HTML stay alive. You can drag, scale, rotate and reorder layers like in Figma; select any single element, say one thing to the AI, and it changes only that one. Then export a self-contained HTML file.

Zero dependencies, Node built-in modules only.

---

## Public address

Published to Artifact:

- https://artifact.catsco.cc/qboard/
- https://artifact.catsco.cn/qboard/   (same copy)

The public build differs from the local one in two ways, both of which follow from the premise that this address is public:

1. **The model key lives in your own browser** and travels with each request to the server, which uses it once and never writes it to disk. So nobody else can see the key you enter, and nobody using the site can spend your quota.
2. **HTML fragments are served from a same-origin URL** (`frag/<id>`) instead of through `srcdoc`. The gateway adds a CSP `script-src 'self'` to pages, and `srcdoc` inherits that policy, so any `<script>` inside a fragment gets blocked outright — which would mean an interaction rewrite like "make it trigger on hover" only changes the styles while all the logic is lost. With a same-origin URL the fragment runs in its own document and no longer inherits the CSP.

Two systemd services keep it up: `catsco-artifact-qboard` (the tunnel) and `catsco-artifact-qboard-app` (the app itself, port 7788).

## Three steps to start

```bash
cd qboard
./start.sh          # or node server.mjs
```

Open http://localhost:7788 . The first launch pops up a config panel: pick a provider preset, paste your API key, then save and test.

You can also edit `config.json` directly:

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-你的key",
  "model": "deepseek-chat",
  "temperature": 0.75
}
```

---

## What it can hold

| Type | Behavior |
| --- | --- |
| PNG / JPG / WebP | Normal static images; large ones are compressed to 1600px |
| GIF / animated WebP | Original bytes kept, animating on the canvas at all times |
| SVG | Rendered directly; `<animate>` inside it runs too |
| Video mp4 / webm / mov | Loops automatically |
| Audio mp3 / wav / m4a | A player appears in place |
| HTML files | Split into structure / style / script, and genuinely run inside an iframe |
| PDF | Embedded browser reader, with paging |
| txt / md / json / csv / code | First 4000 characters shown on the canvas; export uses the full text |
| Any other file | Kept as a card holding the original, still downloadable with one click after export |

---

## How to use it

**Place** — drag files onto the canvas, paste an image with ⌘V, or click "＋Text / ＋Shape / ＋HTML". When several files land at once they cascade and offset themselves automatically instead of piling up on top of each other.

**Adjust** — drag to move, resize from eight directions, rotate with the dot at the top; snapping kicks in near other elements and the board's center lines. The right-hand panel gives you precise control over position, corner radius, opacity, text style and animation parameters.

**Animation** — every element can have its own entrance (fade in / float up / pop / slide in / blur focus / grow) and loop (float / breathe / spin / sway / flicker), with editable duration, delay and easing. While editing everything stays still so it isn't distracting; animation only runs on "Preview" or when you hit "Replay" in the element panel.

**Ask the AI** — the chat window in the bottom right. Whatever is selected is what gets changed:

- Select a logo and say "start floating slowly after 2 seconds, one cycle of 4 seconds" → only that logo's animation changes
- Select an HTML card that flashes every 5 seconds and say "make it light up on hover instead" → it rewrites the CSS/JS inside that element and swaps the timed animation for `:hover`
- Select nothing and say "give the layout more breathing room" → it adjusts the overall layout

The AI outputs a JSON patch (`{ops:[...], say:"..."}`) rather than regenerating the whole page, so the positions you placed by hand are never blown away.

**Motion components** — 16 ready-to-use animated components, ported from the four categories in [React Bits](https://reactbits.dev):

| Category | Components |
| --- | --- |
| Text Animations | SplitText character-by-character entrance, ShinyText shimmering text, GradientText gradient text, DecryptedText decoding text, CountUp number roll |
| Animations | BlurText blur fade-in, MagnetLines magnetic dot grid, ClickSpark click burst |
| Components | SpotlightCard spotlight card, StarBorder glowing border, TiltCard 3D tilt |
| Backgrounds | Aurora, Particles, GridMotion flowing grid |
| Micro Interactions | MagneticButton magnetic button, GlareHover hover glare |

The original React Bits components are React components (each available in four flavors — JS-CSS / JS-TW / TS-CSS / TS-TW — installed through the shadcn MCP). The canvas runs HTML fragments, so these are equivalent ports: every one rewritten as dependency-free native HTML + CSS + JS that runs as soon as you paste it into a `type:"html"` element, with no CDN needed.

Say "give me some shimmering text", "a particle background" or "a spotlight card", and the AI gets that component's full implementation before writing the patch, instead of inventing something that merely looks the part from memory. When nothing matches exactly, it receives an llms.txt-style index and picks for itself.

**Export** — "Export" in the top right gives you a single `.html` that opens with a double click. Layout, z-order, rotation, animations and the interactions inside HTML elements are all preserved, and assets are data URLs so the file is self-contained. Multiple boards are stitched into one long page that scrolls continuously, with no gaps between sections.

---

## Shortcuts

| | |
| --- | --- |
| `V` / `T` / `R` | Select / Text / Shape |
| Space + drag | Pan the canvas |
| ⌘scroll / pinch | Zoom around the cursor |
| ⇧1 | Fit canvas |
| ⌘D | Duplicate |
| ⌫ | Delete |
| ⌘Z / ⇧⌘Z | Undo / Redo |
| ⌘E | Preview the export in the browser |
| ⌘S | Export file |
| ⌘K | Open the chat |
| Double-click text | Edit in place |
| Double-click an HTML element | Enter interaction mode and click its buttons to try them out |
| Esc | Exit preview / interaction / deselect |

---

## Switching models

Any service compatible with `/v1/chat/completions` works. Built in: DeepSeek, OpenAI, Qwen, Zhipu GLM, Moonshot, local Ollama.

Long-context models with strong coding ability are recommended (DeepSeek-V3, GPT-4o, Qwen-Max tier). Rewriting interactions inside HTML depends on code comprehension; small models tend to touch only the surface styling.

To change the generation strategy, look at `SYS_PROMPT` in `public/js/app.js`.

---

## Sharing it with others

By default it only listens on localhost. There are two ways to share it:

```bash
HOST=0.0.0.0 PORT=7788 node server.mjs
```

Others on the LAN open `http://你的内网IP:7788`.

To put it on the public internet, put nginx / Caddy in front as a reverse proxy with HTTPS, and **you must add access control** — `/api/chat` spends your key. The simplest Caddy config:

```
qboard.yourdomain.com {
  basicauth {
    you $2a$14$哈希值
  }
  reverse_proxy 127.0.0.1:7788
}
```

---

## Structure

```
qboard/
├── server.mjs              static server + config read/write + streaming proxy (zero dependencies)
├── public/
│   ├── index.html          UI skeleton
│   ├── styles.css          visual layer
│   └── js/
│       ├── app.js          main controller: import, property panel, agent patches, export
│       ├── canvas.js       canvas engine: transforms, snapping, overlays, inline editing
│       ├── store.js        project state, IndexedDB persistence, undo stack
│       ├── anim.js         animation definitions; editor and export share the same keyframes
│       └── export.js       export to a self-contained single HTML file
├── config.json             ← your key lives here
└── start.sh                double-click to launch
```

A few implementation notes:

- **HTML split into three parts**: when importing an HTML file, `DOMParser` splits it into the body structure, the `<style>` and the `<script>`, stored as `html` / `css` / `js`. Those three parts are what the AI edits when it rewrites interactions, and the result is fed back into the iframe's srcdoc. That is why "flash every 5 seconds → light up on hover" works at all.
- **Animated images are never re-encoded**: JPEG/PNG above the threshold get compressed to 1600px, but a GIF collapses to a single frame the moment it goes through canvas, so GIFs are passed through byte for byte.
- **One source of truth for coordinates**: a node's x/y/w/h are all pixels inside the board, and rotation is around the center. Resize handles are computed from the mouse position in the element's local coordinate space, so the corner of a rotated element still tracks your cursor.
- **State in IndexedDB**: data URLs are routinely several MB, which localStorage can't take. If the DB won't open or times out it falls back to localStorage automatically rather than showing a blank page.
- **Patch allowlist**: the `set` the AI returns only accepts known fields and drops any out-of-range keys, which stops the model from rewriting things like `src` into garbage.

---

## Known limits

- Video, PDF and unknown binaries are embedded as data URLs, so exported files can get large (tens of MB). Compress your source files if you really intend to publish.
- Links are treated as text clues only; page contents are never fetched (cross-origin and anti-scraping make that unreliable). To include a page, paste its text or a screenshot.
- One key, one canvas — there is no multi-user isolation. Giving several people their own keys means adding a user dimension to `loadConfig()` in `server.mjs`.
- HTML elements' iframes use `allow-same-origin` so their inner scripts can read their own DOM to handle interactions; that also means you shouldn't place untrusted third-party pages on the canvas.
