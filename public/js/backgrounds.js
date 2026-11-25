/**
 * backgrounds.js — live animated canvas backgrounds.
 *
 * Each template is a self-contained html/css/js triple that gets injected into
 * an iframe by fragUrl(). Constraints for every entry:
 *   - zero external resources (no CDN, no fonts, no images, no scripts)
 *   - fills the frame: html,body covered with margin 0 / height 100% / overflow hidden
 *   - infinite, seamless CSS animation (first and last keyframe identical),
 *     cycle between 8s and 30s
 *   - <= 8 animated elements, filter blur <= 80px, transform/opacity only,
 *     no will-change, no backdrop-filter, no oversized shadows
 *   - mid-dark base so white text stays readable on top
 *   - viewport-relative units only (vw/vh/%), no hardcoded pixel canvas sizes
 *   - css under 2500 chars, js empty when pure CSS is enough
 */

export const BACKGROUNDS = [
  {
    id: 'color-bends',
    name: '流动光斑',
    desc: '紫粉蓝大色块缓慢漂移融合',
    swatch: 'linear-gradient(120deg,#2b1055,#ff4d8d,#7ad7f0)',
    html: '<div class="fb"><i class="b b1"></i><i class="b b2"></i><i class="b b3"></i><i class="b b4"></i></div>',
    css: 'html,body{margin:0;height:100%;overflow:hidden}'
      + 'body{background:#150f2b}'
      + '.fb{position:absolute;inset:-15%;filter:blur(58px);mix-blend-mode:screen}'
      + '.fb .b{position:absolute;width:66vmax;height:66vmax;border-radius:50%;animation:bend 24s ease-in-out infinite}'
      + '.fb .b1{left:-16%;top:-14%;background:radial-gradient(circle,#a13bff 0,rgba(161,59,255,0) 62%)}'
      + '.fb .b2{right:-18%;top:-6%;background:radial-gradient(circle,#ff4d8d 0,rgba(255,77,141,0) 60%);animation-duration:19s;animation-delay:-7s}'
      + '.fb .b3{left:2%;bottom:-30%;background:radial-gradient(circle,#2f8dff 0,rgba(47,141,255,0) 60%);animation-duration:29s;animation-delay:-13s}'
      + '.fb .b4{right:-10%;bottom:-18%;background:radial-gradient(circle,#7ad7f0 0,rgba(122,215,240,0) 58%);animation-duration:22s;animation-delay:-4s}'
      + '@keyframes bend{0%,100%{transform:translate3d(0,0,0) scale(1)}'
      + '33%{transform:translate3d(5vw,-6vh,0) scale(1.16)}'
      + '66%{transform:translate3d(-6vw,4vh,0) scale(.9)}}',
    js: '',
  },

  {
    id: 'aurora',
    name: '极光',
    desc: '三道斜向光带缓慢呼吸流过',
    swatch: 'linear-gradient(135deg,#06121a,#2ef2c0,#8b6cff)',
    html: '<div class="au"><i></i><i></i><i></i></div>',
    css: 'html,body{margin:0;height:100%;overflow:hidden}'
      + 'body{background:#06121a}'
      + '.au{position:absolute;inset:-25%;filter:blur(42px);mix-blend-mode:screen}'
      + '.au i{position:absolute;left:-35%;width:170%;height:20vmin;border-radius:50%;'
      + 'background:linear-gradient(90deg,rgba(60,255,200,0),rgba(60,255,200,.7),rgba(130,90,255,.45),rgba(60,255,200,0));'
      + 'transform:rotate(-17deg);animation:veil 16s ease-in-out infinite}'
      + '.au i:nth-child(1){top:8%}'
      + '.au i:nth-child(2){top:40%;height:13vmin;'
      + 'background:linear-gradient(90deg,rgba(150,110,255,0),rgba(150,110,255,.7),rgba(90,235,210,.4),rgba(150,110,255,0));'
      + 'animation-duration:21s;animation-delay:-6s}'
      + '.au i:nth-child(3){top:62%;height:24vmin;'
      + 'background:linear-gradient(90deg,rgba(80,255,180,0),rgba(80,255,180,.55),rgba(190,120,255,.35),rgba(80,255,180,0));'
      + 'animation-duration:27s;animation-delay:-14s}'
      + '@keyframes veil{0%,100%{transform:rotate(-17deg) translate3d(-7%,0,0) scaleY(.8);opacity:.4}'
      + '50%{transform:rotate(-17deg) translate3d(7%,0,0) scaleY(1.2);opacity:.95}}',
    js: '',
  },

  {
    id: 'mesh-grid',
    name: '网格流光',
    desc: '细网格上一道对角高光扫过',
    swatch: 'linear-gradient(135deg,#111a26,#78dcff,#c896ff)',
    html: '<div class="mg"><i></i></div>',
    css: 'html,body{margin:0;height:100%;overflow:hidden}'
      + 'body{background:#111a26}'
      + '.mg{position:absolute;inset:0;'
      + 'background-image:linear-gradient(rgba(150,205,255,.13) 1px,transparent 1px),'
      + 'linear-gradient(90deg,rgba(150,205,255,.13) 1px,transparent 1px);'
      + 'background-size:5.5vmin 5.5vmin}'
      + '.mg:before{content:"";position:absolute;inset:0;'
      + 'background:radial-gradient(115% 100% at 50% 45%,rgba(17,26,38,0) 28%,rgba(9,14,22,.86) 100%)}'
      + '.mg i{position:absolute;top:50%;left:50%;width:76vmax;height:18vmin;margin:-9vmin 0 0 -38vmax;'
      + 'background:linear-gradient(90deg,transparent,rgba(120,220,255,.55),rgba(200,150,255,.5),transparent);'
      + 'filter:blur(26px);opacity:0;'
      + 'transform:rotate(-34deg) translate3d(-120vmax,0,0);animation:sweep 15s ease-in-out infinite}'
      // band is fully off-screen and fully transparent at 0% and 100%, so the
      // loop restart is invisible: both end frames render identically.
      + '@keyframes sweep{0%{opacity:0;transform:rotate(-34deg) translate3d(-120vmax,0,0)}'
      + '8%{opacity:1}92%{opacity:1}'
      + '100%{opacity:0;transform:rotate(-34deg) translate3d(120vmax,0,0)}}',
    js: '',
  },

  {
    id: 'noise-flow',
    name: '噪点流动',
    desc: '细腻颗粒感缓慢漂移起伏',
    swatch: 'linear-gradient(115deg,#3b2a55,#141822,#8fb8ff)',
    html: '<div class="nf"><i></i><i></i><i></i></div>',
    css: 'html,body{margin:0;height:100%;overflow:hidden}'
      + 'body{background:radial-gradient(115% 95% at 18% 8%,#3b2a55,#141822 68%)}'
      + '.nf{position:absolute;inset:-14%;mix-blend-mode:screen;animation:grain 26s ease-in-out infinite}'
      + '.nf i{position:absolute;inset:0;display:block}'
      // 1px dot grids at co-prime spacings read as film grain once they overlap;
      // sub-pixel dots vanish under anti-aliasing, so keep radius at 1px.
      + '.nf i:nth-child(1){opacity:.13;background-image:'
      + 'radial-gradient(#fff 1px,transparent 1px),radial-gradient(#fff 1px,transparent 1px),'
      + 'radial-gradient(#fff 1px,transparent 1px),radial-gradient(#fff 1px,transparent 1px);'
      + 'background-size:3px 3px,5px 5px,7px 7px,11px 11px;'
      + 'background-position:0 0,1px 2px,3px 4px,6px 1px}'
      + '.nf i:nth-child(2){opacity:.1;transform:rotate(9deg);background-image:'
      + 'radial-gradient(#fff 1px,transparent 1px),radial-gradient(#fff 1px,transparent 1px),'
      + 'radial-gradient(#fff 1px,transparent 1px);'
      + 'background-size:13px 13px,17px 17px,4px 4px;'
      + 'background-position:0 0,5px 7px,2px 3px}'
      + '.nf i:nth-child(3){inset:0;filter:blur(46px);opacity:.5;animation:grain 18s ease-in-out infinite;'
      + 'background:radial-gradient(52% 36% at 30% 32%,rgba(120,180,255,.42),transparent 70%),'
      + 'radial-gradient(48% 34% at 74% 70%,rgba(205,120,225,.34),transparent 70%)}'
      + '@keyframes grain{0%,100%{transform:translate3d(0,0,0)}'
      + '50%{transform:translate3d(-1.2%,1%,0) scale(1.03)}}',
    js: '',
  },
];

const INDEX = new Map(BACKGROUNDS.map((item) => [item.id, item]));

/** Look up one template by id; unknown ids return null. */
export function findBackground(id) {
  if (id == null) return null;
  return INDEX.get(String(id)) || null;
}
