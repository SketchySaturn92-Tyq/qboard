/**
 * anim.js — 动效定义
 * 编辑器与导出共用同一份 keyframes，避免两处漂移。
 */

export const ENTERS = {
  none: null,
  fadeIn: { kf: 'qbFadeIn', from: 'opacity:0' },
  fadeUp: { kf: 'qbFadeUp' },
  popIn: { kf: 'qbPopIn' },
  slideLeft: { kf: 'qbSlideLeft' },
  slideRight: { kf: 'qbSlideRight' },
  blurIn: { kf: 'qbBlurIn' },
  scaleIn: { kf: 'qbScaleIn' },
};

export const LOOPS = {
  none: null,
  float: { kf: 'qbFloat', base: 4000 },
  pulse: { kf: 'qbPulse', base: 2600 },
  spin: { kf: 'qbSpin', base: 9000 },
  sway: { kf: 'qbSway', base: 3800 },
  blink: { kf: 'qbBlink', base: 2400 },
};

export const EASES = {
  spring: 'cubic-bezier(.18,1.34,.36,1)',
  'ease-out': 'cubic-bezier(.16,1,.3,1)',
  'ease-in-out': 'cubic-bezier(.65,0,.35,1)',
  linear: 'linear',
  'cubic-bezier(.18,1.34,.36,1)': 'cubic-bezier(.18,1.34,.36,1)',
};

export function normalizeAnim(anim) {
  const a = anim || {};
  return {
    enter: ENTERS[a.enter] !== undefined ? a.enter : 'fadeUp',
    loop: LOOPS[a.loop] !== undefined ? a.loop : 'none',
    dur: Number.isFinite(+a.dur) ? Math.max(80, Math.min(20000, +a.dur)) : 760,
    delay: Number.isFinite(+a.delay) ? Math.max(0, Math.min(20000, +a.delay)) : 0,
    ease: EASES[a.ease] ? a.ease : 'spring',
  };
}

/** 生成 inline animation 值 */
export function animationValue(anim) {
  const a = normalizeAnim(anim);
  const parts = [];
  const enter = ENTERS[a.enter];
  const loop = LOOPS[a.loop];

  if (enter) {
    parts.push(`${enter.kf} ${a.dur}ms ${EASES[a.ease] || EASES.spring} ${a.delay}ms 1 both`);
  }
  if (loop) {
    const dur = Math.max(1200, Math.round(a.dur * (loop.base / 760)));
    const delay = (enter ? a.dur + a.delay : a.delay);
    parts.push(`${loop.kf} ${dur}ms ease-in-out ${delay}ms infinite both`);
  }
  return parts.join(', ');
}

export const KEYFRAMES = `
@keyframes qbFadeIn   { from { opacity: 0 } to { opacity: 1 } }
@keyframes qbFadeUp   { from { opacity: 0; transform: translateY(26px) } to { opacity: 1; transform: none } }
@keyframes qbPopIn    { 0% { opacity: 0; transform: scale(.72) } 62% { opacity: 1; transform: scale(1.045) } 100% { opacity: 1; transform: scale(1) } }
@keyframes qbSlideLeft  { from { opacity: 0; transform: translateX(64px) } to { opacity: 1; transform: none } }
@keyframes qbSlideRight { from { opacity: 0; transform: translateX(-64px) } to { opacity: 1; transform: none } }
@keyframes qbBlurIn   { from { opacity: 0; filter: blur(14px); transform: scale(1.03) } to { opacity: 1; filter: blur(0); transform: none } }
@keyframes qbScaleIn  { from { opacity: 0; transform: scale(.9) } to { opacity: 1; transform: none } }
@keyframes qbFloat    { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-12px) } }
@keyframes qbPulse    { 0%,100% { transform: scale(1) } 50% { transform: scale(1.045) } }
@keyframes qbSpin     { from { transform: rotate(0) } to { transform: rotate(360deg) } }
@keyframes qbSway     { 0%,100% { transform: rotate(-2.2deg) } 50% { transform: rotate(2.2deg) } }
@keyframes qbBlink    { 0%,100% { opacity: 1 } 50% { opacity: .42 } }
`;

let installed = false;
export function installKeyframes() {
  if (installed) return;
  installed = true;
  const style = document.createElement('style');
  style.id = 'qb-keyframes';
  style.textContent = KEYFRAMES;
  document.head.appendChild(style);
}
