// Homepage scene. One particle system tells the whole page, act by act as you scroll:
//   1. hero: loose dust drifts behind the headline; scrolling into the statement assembles it
//      into a cluster of cubes ("sealed machines") beside the text, with labels pinned to corners
//   2. story (pinned): one build is approved (lime), its machine lifts out, its corners tick off the
//      four checks that pass before paying, then a tampered machine breaks apart in red
//   3. after the story: the cubes burst back into dust, and each pinned scene gathers it into an object
//      in the slot beside its text: a seal that answers each outcome, the globe with labels, a coin that
//      turns as the spending limits arrive around it, one big cube whose right half comes loose for
//      what a proof doesn't show, and a ring round the closing headline. Between scenes it is dust again.
//   4. the end: the dust fades out and a generated wireframe mountain range rises behind the footer
// Progress is read once per frame from element rects (no scroll listeners), and every act blends into
// the next by scroll position, so the scene never switches or disappears between sections.
// Reduced motion: no drift, no intro, acts still change with scroll as still frames.
import * as THREE from 'three';

const root = document.documentElement;
// site.css hides what this module drives only from here on: a failed CDN import leaves all of it readable.
root.classList.add('scene-live');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Dev aid: ?settle snaps every eased value to its target, to check a scroll position's final frame.
const SETTLE = new URLSearchParams(location.search).has('settle');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
const canvas = document.querySelector('[data-scene]');
const story = document.querySelector('[data-story]');
const storyStage = document.querySelector('[data-story-stage]');
const statementSec = document.querySelector('[data-statement]');
const footer = document.querySelector('.footer');
const land = document.querySelector('[data-land]');
const tagsEl = document.querySelector('[data-tags]');
const tags = tagsEl ? [...tagsEl.querySelectorAll('[data-tag]')] : [];
const tagLines = tagsEl ? [...tagsEl.querySelectorAll('[data-tag-line]')] : [];

const clamp01 = v => Math.min(1, Math.max(0, v));
const ramp = (v, a, b) => clamp01((v - a) / (b - a));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const easeOutExpo = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

// 0 when the element's top reaches the top of the viewport, 1 when its bottom reaches the bottom.
const pinnedProgress = el => {
  const r = el.getBoundingClientRect();
  return clamp01(-r.top / Math.max(1, r.height - innerHeight));
};

// --- Story DOM: steps, rail, callouts, checklist ---
const steps = story ? [...story.querySelectorAll('[data-step]')] : [];
story?.classList.add('is-live'); // site.css hides the steps it isn't showing only from here on
const callouts = story ? [...story.querySelectorAll('[data-callout]')] : [];
const railBars = story ? [...story.querySelectorAll('[data-rail] b')] : [];
const hud = story?.querySelector('[data-hud]');
const hudRows = hud ? [...hud.querySelectorAll('[data-check]')] : [];
const hudVerdict = hud?.querySelector('[data-hud-verdict]');
const timerArc = story?.querySelector('[data-timer]');
const timerText = story?.querySelector('[data-timer-text]');
let lastStep = -1, lastHud = '', lastSecs = -1;

function updateStory(p) {
  const s = p * steps.length;
  const idx = Math.min(steps.length - 1, Math.floor(s));
  if (idx !== lastStep) {
    steps.forEach((el, i) => el.classList.toggle('is-on', i === idx));
    callouts.forEach((el, i) => el.classList.toggle('is-on', i === idx));
    lastStep = idx;
  }
  railBars.forEach((b, i) => { b.style.transform = `scaleX(${clamp01(s - i)})`; });

  // The 120 s permission drains while step 4 is on screen.
  if (timerText) {
    const left = 1 - ramp(s, 3.05, 3.95);
    const secs = Math.round(120 * left);
    if (secs !== lastSecs) {
      if (timerArc) timerArc.style.transform = `scaleX(${left.toFixed(3)})`;
      timerText.textContent = secs;
      lastSecs = secs;
    }
  }

  if (!hud) return;
  const ticks = idx < 3 ? Math.floor(ramp(s, 2, 3) * 3) : idx === 3 ? 3 + Math.round(ramp(s, 3, 3.8) * 2) : 5;
  const key = `${idx}:${ticks}`;
  if (key === lastHud) return;
  lastHud = key;
  hud.classList.toggle('is-on', idx >= 2);
  const tampered = idx === 4;
  hud.dataset.mode = tampered ? 'rejected' : ticks >= 5 ? 'verified' : 'checking';
  const tamperStates = ['pass', 'pass', 'fail', 'na', 'pass'];
  hudRows.forEach((row, i) => {
    const state = tampered ? tamperStates[i] : i < ticks ? 'pass' : 'wait';
    row.dataset.state = state;
    const word = row.querySelector('[data-word]');
    if (word) word.textContent = { pass: i === 4 && tampered ? 'Expired unused' : 'Passed', fail: 'Failed', na: 'Skipped', wait: 'Checking' }[state];
  });
  if (hudVerdict) hudVerdict.textContent = tampered ? 'Rejected' : ticks >= 5 ? 'Verified' : 'Checking';
}

// --- Pinned scenes after the story: beats take turns, [data-at] items come on at a point in the scroll ---
const sceneSecs = [...document.querySelectorAll('[data-scene-sec]')].map(sec => ({
  sec, name: sec.dataset.sceneSec, slot: sec.querySelector('[data-slot]'), pinned: sec.classList.contains('scene-sec'),
  beats: [...sec.querySelectorAll('[data-beat]')], ats: [...sec.querySelectorAll('[data-at]')],
  rail: [...sec.querySelectorAll('[data-scene-rail] b')], last: -1,
}));
const pinsEl = document.querySelector('[data-pins]');
const pins = pinsEl ? [...pinsEl.querySelectorAll('[data-pin]')].map(el => ({ el, dir: el.dataset.pin.split(',').map(Number) })) : [];

// Figures count up from zero each time their card comes on.
function countUp(el) {
  const n = el.querySelector('[data-count]');
  if (!n) return;
  const target = parseFloat(n.dataset.count), dec = Number(n.dataset.decimals || 0);
  if (reduce) { n.textContent = target.toFixed(dec); return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / 1200);
    n.textContent = (target * (1 - Math.pow(1 - k, 3))).toFixed(dec);
    if (k < 1 && el.classList.contains('is-on')) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updateScenes() {
  for (const sc of sceneSecs) {
    const p = pinnedProgress(sc.sec);
    if (sc.beats.length) {
      const n = sc.beats.length, idx = Math.min(n - 1, Math.floor(p * n));
      if (idx !== sc.last) {
        sc.beats.forEach((el, i) => el.classList.toggle('is-on', i === idx));
        sc.last = idx;
      }
      sc.rail.forEach((b, i) => { b.style.transform = `scaleX(${clamp01(p * n - i)})`; });
    }
    sc.ats.forEach(el => {
      const on = p >= parseFloat(el.dataset.at);
      if (on === el.classList.contains('is-on')) return;
      el.classList.toggle('is-on', on);
      if (on) countUp(el);
    });
  }
}

// --- WebGL ---
const glOK = (() => {
  if (!canvas) return false;
  try { return !!(canvas.getContext('webgl2') || canvas.getContext('webgl')); } catch { return false; }
})();
if (!glOK) root.classList.add('no-webgl');

let scene, camera, renderer, cluster, floor, terrain, edges = [], U, pointsMat, cornerMat;
const ACTIVE = 4, TAMPER = 2;
const CUBES = [
  [-1, 1, 0.1], [0, 1, 0.45], [1, 1, -0.35],
  [-1, 0, 0.4], [0, 0, 0], [1, 0, 0.55],
  [-1, -1, -0.3], [0, -1, 0.3], [1, -1, -0.5],
  [-2, 0.5, -0.15], [2, -0.5, 0.15],
];
const GAP = 1.14;
// Hero tags: a cube corner in the cluster's local space, and where the label sits relative to it (px).
const TAG_ANCHORS = [
  { p: [0 * GAP + 0.5, 1 * GAP + 0.5, 0.45 * GAP + 0.5], dx: 70, dy: -64 },
  { p: [2 * GAP + 0.5, -0.5 * GAP + 0.5, 0.15 * GAP + 0.5], dx: 60, dy: 46 },
  { p: [0 * GAP + 0.5, -1 * GAP - 0.5, 0.3 * GAP + 0.5], dx: 48, dy: 64 },
];
const tmpV = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpN = new THREE.Vector3(), tmpD = new THREE.Vector3();
const SEAL_GREY = new THREE.Color('#8b8b94');

// Shape targets for the morphs, in the cluster's local space.
const dir = new THREE.Vector3();
function globePoint(out) {
  const r = 2.1, u = Math.random();
  if (u < 0.3) { // meridians
    const lon = Math.floor(Math.random() * 14) / 14 * Math.PI * 2, lat = (Math.random() - 0.5) * Math.PI;
    out.set(r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon));
  } else if (u < 0.55) { // parallels
    const lat = (Math.floor(Math.random() * 9) / 8 - 0.5) * Math.PI * 0.9, lon = Math.random() * Math.PI * 2;
    out.set(r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon));
  } else {
    out.randomDirection().multiplyScalar(r);
  }
  return out;
}

// Seal for the outcomes: an outer band and a hairline ring round a mark. The mark is a check, and every
// mark grain also has a place on an X, so the seal can turn from verified to refused.
// Returns [x, y, z, isMark, xX, yX, zX].
const CHECK = [[-0.85, 0.02], [-0.25, -0.6], [0.95, 0.72]];
const CROSS_A = [[-0.78, -0.78], [0.78, 0.78]], CROSS_B = [[-0.78, 0.78], [0.78, -0.78]];
function along(pts, t) {
  const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]));
  let d = t * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const k = Math.min(1, d / lens[i]);
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
    }
    d -= lens[i];
  }
}
function sealPoint() {
  const u = Math.random(), a = Math.random() * Math.PI * 2;
  if (u < 0.7) {
    const band = u < 0.56, r = band ? 1.78 + Math.random() * 0.34 : 1.46 + (Math.random() - 0.5) * 0.05;
    const p = [Math.cos(a) * r, Math.sin(a) * r, (Math.random() - 0.5) * (band ? 0.26 : 0.06)];
    return [...p, 0, ...p];
  }
  const t = Math.random(), jx = (Math.random() - 0.5) * 0.2, jy = (Math.random() - 0.5) * 0.2, jz = (Math.random() - 0.5) * 0.24;
  const c = along(CHECK, t), x = t < 0.5 ? along(CROSS_A, t * 2) : along(CROSS_B, t * 2 - 1);
  return [c[0] + jx, c[1] + jy, jz, 1, x[0] + jx, x[1] + jy, jz];
}

// One big sealed machine for the honest limits, filled with dust like the cubes, its twelve edges dense.
function boxPoint() {
  const s = 1.55, u = Math.random(), r = () => (Math.random() * 2 - 1) * s, j = () => (Math.random() - 0.5) * 0.07;
  if (u < 0.45) return [r(), r(), r()];
  if (u < 0.85) {
    const a = Math.random() < 0.5 ? -s : s, b = Math.random() < 0.5 ? -s : s, axis = Math.floor(Math.random() * 3);
    return axis === 0 ? [r(), a + j(), b + j()] : axis === 1 ? [a + j(), r(), b + j()] : [a + j(), b + j(), r()];
  }
  const p = [r(), r(), r()], ax = Math.floor(Math.random() * 3);
  p[ax] = Math.random() < 0.5 ? -s : s;
  return p;
}

// Ring for the closing call: a thin bright band and a looser halo, lying flat so a tilt makes it an
// ellipse round the headline.
function ringPoint() {
  const a = Math.random() * Math.PI * 2, halo = Math.random() < 0.3;
  const g = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  const r = 2 + g() * (halo ? 0.3 : 0.05);
  return [Math.cos(a) * r, g() * (halo ? 0.12 : 0.025), Math.sin(a) * r];
}

// Coin for the spending limits: the rim, a raised lip on both faces, the faces, and the Attessa mark (a ring
// round a dot) struck in the middle of each face.
function coinPoint() {
  const u = Math.random(), a = Math.random() * Math.PI * 2, side = Math.random() < 0.5 ? -1 : 1;
  const at = (r, z) => [Math.cos(a) * r, Math.sin(a) * r, z];
  if (u < 0.26) return at(2, (Math.random() - 0.5) * 0.34);
  if (u < 0.46) return at(1.74 + (Math.random() - 0.5) * 0.08, side * 0.19);
  if (u < 0.7) return at(1.95 * Math.sqrt(Math.random()), side * 0.16);
  if (u < 0.92) return at(0.62 + (Math.random() - 0.5) * 0.1, side * 0.21);
  return at(0.2 * Math.sqrt(Math.random()), side * 0.21);
}

const VERT = /* glsl */`
  attribute float aCube;
  attribute float aCorner;
  attribute vec4 aRand;
  attribute vec3 aGlobe;
  attribute vec4 aSeal;
  attribute vec3 aSealX;
  attribute vec3 aCoin;
  attribute vec3 aBox;
  attribute vec3 aRing;
  uniform float uTime, uSize, uPixelRatio, uActive, uActiveAmt, uTamper, uTamperAmt, uScatter, uLift, uChecks, uDrift, uIntro;
  uniform vec3 uW;
  uniform vec2 uW2;
  uniform float uMarkX, uBreak, uSealYaw, uCoinYaw, uBoxYaw, uHalf;
  varying float vActive;
  varying float vTamper;
  varying float vLit;
  varying float vFade;
  varying float vGlit;
  varying float vTw;
  varying float vSeal;
  vec3 yaw(vec3 v, float a) {
    float c = cos(a), s = sin(a);
    return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
  }
  void main() {
    vec3 p = position;
    float isActive = 1.0 - step(0.5, abs(aCube - uActive));
    float isTamper = 1.0 - step(0.5, abs(aCube - uTamper));
    p.z += isActive * uLift;
    p += isTamper * uScatter * aRand.xyz * (0.8 + aRand.w * 2.2);
    // The shapes after the story, weighted by uW: a seal, the globe, a coin. The seal and coin are turned
    // against the cluster's spin so the mark always reads and the coin turns with the scroll.
    vec3 seal = mix(aSeal.xyz, aSealX, uMarkX * aSeal.w);
    seal += aRand.xyz * uBreak * (aSeal.w * 0.45 + step(0.8, aRand.w) * 1.3);
    // The big cube faces you; with uHalf its right half comes loose into dust while the left half holds.
    vec3 box = yaw(aBox, uBoxYaw);
    box += aRand.xyz * uHalf * smoothstep(-0.25, 0.9, box.x) * (0.4 + aRand.w * 1.5);
    float shapeAmt = uW.x + uW.y + uW.z + uW2.x + uW2.y;
    p = p * (1.0 - shapeAmt) + yaw(seal, uSealYaw) * uW.x + aGlobe * uW.y + yaw(aCoin, uCoinYaw) * uW.z + box * uW2.x + aRing * uW2.y;
    vSeal = uW.x * mix(step(0.4, aRand.w), 1.0, aSeal.w);
    p += aRand.xyz * uIntro * (3.5 + aRand.w * 9.0);
    p += uDrift * 0.014 * vec3(sin(uTime * 0.7 + aRand.w * 6.3), cos(uTime * 0.6 + aRand.w * 5.1), sin(uTime * 0.5 + aRand.w * 4.2));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float base = uSize * uPixelRatio * (0.55 + aRand.w * 0.9) / -mv.z;
    // Glitter: about one grain in a hundred catches the light while the dust is loose, then shrinks back
    // into plain dust as it gathers into the cubes.
    float h = fract(sin(dot(aRand.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float glit = step(aCorner, -0.5) * step(0.991, h) * uIntro;
    gl_PointSize = mix(base, min(base * 9.0, 44.0 * uPixelRatio), glit);
    vGlit = glit;
    float tw = 0.5 + 0.5 * sin(uTime * (1.3 + fract(h * 97.0) * 2.4) + aRand.w * 40.0);
    // Keep the flares off the copy: much fainter over the left two-thirds of the screen, where the hero
    // headline and intro sit.
    vec2 ndc = gl_Position.xy / gl_Position.w;
    float quiet = 1.0 - 0.85 * smoothstep(0.86, 0.6, abs(ndc.x + 0.18)) * smoothstep(0.7, 0.45, abs(ndc.y - 0.02));
    vTw = (0.18 + 0.82 * pow(tw, 4.0)) * quiet;
    float morph = shapeAmt;
    vActive = isActive * uActiveAmt * (1.0 - morph);
    vTamper = isTamper * uTamperAmt * (1.0 - morph);
    vLit = isActive * step(0.0, aCorner) * step(aCorner + 0.5, uChecks) * (1.0 - morph);
    vFade = 1.0 - uIntro * 0.4;
  }
`;
const FRAG = /* glsl */`
  uniform vec3 uColor, uAccent, uFail, uSeal;
  uniform float uOthersDim, uOpacity, uAlpha;
  varying float vActive;
  varying float vTamper;
  varying float vLit;
  varying float vFade;
  varying float vGlit;
  varying float vTw;
  varying float vSeal;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = smoothstep(0.5, 0.0, d);
    // Glitter shape: a hot core, a soft halo and four thin rays that reach further as the grain flares.
    float reach = pow(smoothstep(0.18 + 0.32 * vTw, 0.0, d), 2.0);
    float rays = (smoothstep(0.03, 0.0, abs(c.x)) + smoothstep(0.03, 0.0, abs(c.y))) * reach;
    float star = smoothstep(0.07, 0.0, d) + pow(a, 3.0) * 0.35 + rays;
    a = mix(a, star * vTw * 2.2, vGlit);
    vec3 col = mix(uColor, uAccent, max(vActive, vLit));
    col = mix(col, uFail, vTamper);
    col = mix(col, uSeal, vSeal);
    col = mix(col, vec3(1.0), vGlit);
    float dim = mix(1.0, 0.22, uOthersDim * (1.0 - max(max(vActive, vTamper), vLit)));
    gl_FragColor = vec4(col, a * dim * uAlpha * uOpacity * vFade * (1.0 + vLit));
  }
`;

// Footer mountains, four layers that share one height field and rise together:
//   ground: solid, page-coloured, so peaks hide what is behind them and stand out as silhouettes
//   glow:   a soft light behind the far end of the valley
//   lines:  a dense wireframe, brighter on the crests and where the light reaches
//   glints: a few points twinkling on the highest crests
const TERRAIN_RISE = /* glsl */`
  uniform float uRise;
  vec3 risen(vec3 p) { return vec3(p.x, p.y * (0.35 + 0.65 * uRise) - (1.0 - uRise) * 2.6, p.z); }
`;
const TERRAIN_VERT = /* glsl */`
  attribute float aShade;
  attribute float aKind;
  varying float vDepth, vShade, vKind, vX, vY, vZ;
  ${TERRAIN_RISE}
  void main() {
    vec4 mv = modelViewMatrix * vec4(risen(position), 1.0);
    vDepth = -mv.z;
    vShade = aShade;
    vKind = aKind;
    vX = position.x;
    vY = position.y;
    vZ = position.z;
    gl_Position = projectionMatrix * mv;
  }
`;
// Contour rows carry the image; the cross lines are kept faint. Rows pack tighter with distance, so their
// brightness falls with depth to stop the far ranges merging into a band. The ground in front fades into
// the dark so the eye goes to the mountains.
const TERRAIN_FRAG = /* glsl */`
  uniform vec3 uColor, uLight;
  uniform float uOpacity;
  varying float vDepth, vShade, vKind, vX, vY, vZ;
  void main() {
    float far = smoothstep(56.0, 34.0, vDepth);
    float near = smoothstep(9.0, 19.0, vDepth);
    float density = clamp(18.0 / vDepth, 0.32, 1.0);
    float lit = exp(-vX * vX / 110.0 - (vZ + 30.0) * (vZ + 30.0) / 260.0);
    float a = (0.07 + 0.035 * clamp(vY, 0.0, 4.0) + 0.24 * vShade + 0.36 * lit * (0.45 + vShade)) * density * far * near * uOpacity;
    a *= mix(1.0, 0.3, vKind);
    gl_FragColor = vec4(mix(uColor, uLight, lit * 0.65) * a, a);
  }
`;
const GROUND_VERT = /* glsl */`
  ${TERRAIN_RISE}
  void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(risen(position), 1.0); }
`;
const GROUND_FRAG = /* glsl */`
  uniform vec3 uBg;
  void main() { gl_FragColor = vec4(uBg, 1.0); }
`;
const GLOW_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const GLOW_FRAG = /* glsl */`
  uniform vec3 uLight;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 d = (vUv - 0.5) * vec2(2.4, 6.5);
    float a = (exp(-dot(d, d)) * 0.12 + exp(-dot(d, d) * 7.0) * 0.14) * uOpacity;
    gl_FragColor = vec4(uLight * a, a);
  }
`;
const GLINT_VERT = /* glsl */`
  attribute float aSeed;
  uniform float uTime, uPixelRatio, uOpacity;
  varying float vA;
  ${TERRAIN_RISE}
  void main() {
    vec4 mv = modelViewMatrix * vec4(risen(position) + vec3(0.0, 0.03, 0.0), 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = pow(0.5 + 0.5 * sin(uTime * (0.7 + aSeed * 1.9) + aSeed * 60.0), 6.0);
    vA = (0.15 + 0.85 * tw) * uOpacity * smoothstep(40.0, 14.0, -mv.z);
    gl_PointSize = (1.5 + 4.5 * tw) * uPixelRatio * 12.0 / -mv.z;
  }
`;
const GLINT_FRAG = /* glsl */`
  varying float vA;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float rays = (smoothstep(0.05, 0.0, abs(c.x)) + smoothstep(0.05, 0.0, abs(c.y))) * smoothstep(0.5, 0.0, d);
    float a = min(1.0, (smoothstep(0.22, 0.0, d) + rays * 0.6) * vA);
    gl_FragColor = vec4(vec3(a), a);
  }
`;
// Value noise for the height field.
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, octaves = 3) {
  let f = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < octaves; i++) { f += amp * noise(x * fr, y * fr); fr *= 2.03; amp *= 0.5; }
  return f;
}
// Ridged multifractal: each octave folds the noise into sharp crests, and finer octaves only add detail
// where the coarser ones already made a ridge, so slopes read as eroded rock rather than soft hills.
// Octaves are rotated against each other so the value-noise grid never shows.
function ridged(x, z) {
  let f = 0, amp = 0.6, w = 1;
  for (let i = 0; i < 6; i++) {
    const c = Math.cos(i * 0.9), s = Math.sin(i * 0.9);
    let n = 1 - Math.abs(noise(c * x - s * z + i * 17.3, s * x + c * z - i * 9.1) * 2 - 1);
    n *= n;
    f += n * amp * w;
    w = Math.min(1, n * 1.8);
    x *= 2.05; z *= 2.05; amp *= 0.5;
  }
  return f;
}
// Ranges rise with distance, a valley opens down the middle toward the light, and the far ranges close it.
// A slow envelope gathers the ridges into a few big massifs, and a power curve sharpens the peaks so the
// skylines are jagged. Heights are capped by eye so no peak climbs into the footer text.
function height(x, z) {
  const wx = x + (fbm(x * 0.06 + 3.1, z * 0.06 - 1.7) - 0.5) * 7;
  const wz = z + (fbm(x * 0.06 - 5.2, z * 0.06 + 2.4) - 0.5) * 7;
  const massif = smooth(clamp01((fbm(x * 0.045 + 11.3, z * 0.045 - 4.2) - 0.12) * 2.4));
  const back = ramp(-z, 2, 22);
  const valley = 1 - 0.85 * Math.exp(-(x * x) / (4 + Math.max(0, -z) * 0.5)) * (1 - ramp(-z, 20, 30));
  return Math.pow(ridged(wx * 0.08, wz * 0.08), 1.3) * (0.8 + 2.9 * back) * (0.35 + 0.9 * massif) * valley - 0.3;
}

function buildTerrain(group, small) {
  const x0 = -32, x1 = 32, z0 = -36, z1 = 2;
  const dx = small ? 0.26 : 0.13, dz = small ? 0.28 : 0.14, colEvery = small ? 4 : 5;
  const nx = Math.round((x1 - x0) / dx) + 1, nz = Math.round((z1 - z0) / dz) + 1;
  const hs = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) hs[j * nx + i] = height(x0 + i * dx, z0 + j * dz);
  const at = (i, j) => hs[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  // Shade: crests (higher than the ground around them) light up, and height adds a little on top.
  const shade = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const h = at(i, j), crest = h - (at(i - 2, j) + at(i + 2, j) + at(i, j - 2) + at(i, j + 2)) / 4;
    shade[j * nx + i] = Math.min(1.3, Math.max(0, crest) * 14 + Math.max(0, h) * 0.12);
  }
  const vert = (i, j) => [x0 + i * dx, at(i, j), z0 + j * dz];

  // Ground: one mesh over the grid, pushed back a touch in depth so the lines on it always win.
  const gpos = new Float32Array(nx * nz * 3), idx = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) gpos.set(vert(i, j), (j * nx + i) * 3);
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
  gg.setIndex(idx);
  const ground = new THREE.Mesh(gg, new THREE.ShaderMaterial({
    uniforms: { uRise: TU.uRise, uBg: TU.uBg }, vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
  }));
  ground.frustumCulled = false;

  // Lines: every row across (contours), and faint cross lines every few columns into the distance.
  const lpos = [], lsh = [], lkind = [];
  const seg = (i1, j1, i2, j2, kind) => {
    lpos.push(...vert(i1, j1), ...vert(i2, j2));
    lsh.push(shade[j1 * nx + i1], shade[j2 * nx + i2]);
    lkind.push(kind, kind);
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx - 1; i++) seg(i, j, i + 1, j, 0);
  for (let i = 0; i < nx; i += colEvery) for (let j = 0; j < nz - 1; j++) seg(i, j, i, j + 1, 1);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lpos), 3));
  lg.setAttribute('aShade', new THREE.BufferAttribute(new Float32Array(lsh), 1));
  lg.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(lkind), 1));
  // Additive layers write premultiplied colour, so faint pixels keep their alpha and fade out smoothly
  // instead of being cut off where the canvas meets the page.
  const lines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({
    uniforms: TU, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  }));
  lines.frustumCulled = false;
  lines.renderOrder = 2;

  // Glints: the sharpest crests that stand high enough to catch the light.
  const cand = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (shade[j * nx + i] > 0.75 && at(i, j) > 0.9) cand.push([i, j]);
  const picks = cand.sort(() => Math.random() - 0.5).slice(0, small ? 160 : 420);
  const gl = new THREE.BufferGeometry();
  gl.setAttribute('position', new THREE.BufferAttribute(new Float32Array(picks.flatMap(([i, j]) => vert(i, j))), 3));
  gl.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(picks.map(() => Math.random())), 1));
  const glints = new THREE.Points(gl, new THREE.ShaderMaterial({
    uniforms: TU, vertexShader: GLINT_VERT, fragmentShader: GLINT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  }));
  glints.frustumCulled = false;
  glints.renderOrder = 3;

  group.add(ground, lines, glints);
}

// Shared by every terrain layer.
const TU = {
  uTime: { value: 0 }, uRise: { value: 0 }, uOpacity: { value: 0 }, uPixelRatio: { value: 1 },
  uColor: { value: new THREE.Color('#f2f2f3') }, uLight: { value: new THREE.Color('#eceee6') }, uBg: { value: new THREE.Color('#030304') },
};
function makeTerrain(small) {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(130, 34), new THREE.ShaderMaterial({
    uniforms: { uLight: TU.uLight, uOpacity: TU.uOpacity }, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  }));
  // Behind the farthest ridge, centred on its height, so it outlines the peaks as a horizon light.
  glow.position.set(0, 1.4, -42);
  glow.renderOrder = 1;
  group.add(glow);
  // The height field takes a moment to build and isn't seen until the footer, so build it when idle,
  // and only on a page whose footer shows the mountains.
  if (land?.offsetHeight) (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => buildTerrain(group, small));
  return group;
}

function cssColor(name) {
  return new THREE.Color(getComputedStyle(root).getPropertyValue(name).trim() || '#ffffff');
}

function initGL() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x030304, 9, 30);
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 80);
  camera.position.set(0, 0, 10);

  cluster = new THREE.Group();
  scene.add(cluster);

  const small = innerWidth < 760;
  const perCube = small ? 800 : 1800;
  const n = CUBES.length * perCube;
  const pos = new Float32Array(n * 3), cube = new Float32Array(n), corner = new Float32Array(n), rand = new Float32Array(n * 4);
  const tmp = new THREE.Vector3();
  // Targets for the later shapes, one set per particle layer.
  const shapes = count => {
    const s = {
      globe: new Float32Array(count * 3), seal: new Float32Array(count * 4), sealX: new Float32Array(count * 3),
      coin: new Float32Array(count * 3), box: new Float32Array(count * 3), ring: new Float32Array(count * 3),
    };
    for (let i = 0; i < count; i++) {
      s.globe.set(globePoint(tmp).toArray(), i * 3);
      const sp = sealPoint();
      s.seal.set(sp.slice(0, 4), i * 4);
      s.sealX.set(sp.slice(4), i * 3);
      s.coin.set(coinPoint(), i * 3);
      s.box.set(boxPoint(), i * 3);
      s.ring.set(ringPoint(), i * 3);
    }
    return s;
  };
  CUBES.forEach((c, ci) => {
    for (let k = 0; k < perCube; k++) {
      const i = ci * perCube + k;
      pos.set([c[0] * GAP + Math.random() - 0.5, c[1] * GAP + Math.random() - 0.5, c[2] * GAP + Math.random() - 0.5], i * 3);
      cube[i] = ci;
      corner[i] = -1;
      dir.randomDirection();
      rand.set([dir.x, dir.y, dir.z, Math.random()], i * 4);
    }
  });

  U = {
    uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() },
    uColor: { value: cssColor('--scene-base') }, uAccent: { value: cssColor('--scene-accent') }, uFail: { value: cssColor('--fail') },
    uActive: { value: ACTIVE }, uActiveAmt: { value: 0 }, uTamper: { value: TAMPER }, uTamperAmt: { value: 0 },
    uScatter: { value: 0 }, uLift: { value: 0 }, uChecks: { value: 0 }, uOthersDim: { value: 0 },
    uOpacity: { value: 1 }, uDrift: { value: reduce ? 0 : 1 }, uIntro: { value: reduce ? 0 : 1 },
    uSeal: { value: cssColor('--scene-accent') },
    uW: { value: new THREE.Vector3() }, uMarkX: { value: 0 }, uBreak: { value: 0 }, uSealYaw: { value: 0 }, uCoinYaw: { value: 0 },
    uW2: { value: new THREE.Vector2() }, uBoxYaw: { value: 0 }, uHalf: { value: 0 },
  };
  const makeMat = (size, alpha) => new THREE.ShaderMaterial({
    uniforms: { ...U, uSize: { value: size }, uAlpha: { value: alpha } },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const geo = (p, cb, cr, rd, sh) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aCube', new THREE.BufferAttribute(cb, 1));
    g.setAttribute('aCorner', new THREE.BufferAttribute(cr, 1));
    g.setAttribute('aRand', new THREE.BufferAttribute(rd, 4));
    g.setAttribute('aGlobe', new THREE.BufferAttribute(sh.globe, 3));
    g.setAttribute('aSeal', new THREE.BufferAttribute(sh.seal, 4));
    g.setAttribute('aSealX', new THREE.BufferAttribute(sh.sealX, 3));
    g.setAttribute('aCoin', new THREE.BufferAttribute(sh.coin, 3));
    g.setAttribute('aBox', new THREE.BufferAttribute(sh.box, 3));
    g.setAttribute('aRing', new THREE.BufferAttribute(sh.ring, 3));
    return g;
  };
  pointsMat = makeMat(small ? 26 : 22, 0.62);
  const pts = new THREE.Points(geo(pos, cube, corner, rand, shapes(n)), pointsMat);
  pts.frustumCulled = false;
  cluster.add(pts);

  // Corner dots: eight per cube. The approved machine's first four light up as the checks pass.
  const cn = CUBES.length * 8;
  const cpos = new Float32Array(cn * 3), ccube = new Float32Array(cn), ccorner = new Float32Array(cn), crand = new Float32Array(cn * 4);
  CUBES.forEach((c, ci) => {
    for (let k = 0; k < 8; k++) {
      const i = ci * 8 + k;
      cpos.set([c[0] * GAP + ((k & 1) ? 0.5 : -0.5), c[1] * GAP + ((k & 2) ? 0.5 : -0.5), c[2] * GAP + ((k & 4) ? 0.5 : -0.5)], i * 3);
      ccube[i] = ci; ccorner[i] = k;
      dir.randomDirection();
      crand.set([dir.x, dir.y, dir.z, 0.85], i * 4);
    }
  });
  cornerMat = makeMat(small ? 95 : 80, 1);
  const cpts = new THREE.Points(geo(cpos, ccube, ccorner, crand, shapes(cn)), cornerMat);
  cpts.frustumCulled = false;
  cluster.add(cpts);

  // Edges: one line box per cube so each can take its own colour, lift and fade.
  const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  CUBES.forEach((c, ci) => {
    const l = new THREE.LineSegments(box, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false, color: U.uColor.value.clone() }));
    l.position.set(c[0] * GAP, c[1] * GAP, c[2] * GAP);
    l.userData.home = l.position.z;
    cluster.add(l);
    edges[ci] = l;
  });

  // Receding grid floor for depth during the first acts.
  floor = new THREE.GridHelper(60, 60);
  floor.material.transparent = true;
  floor.material.depthWrite = false;
  floor.material.color = cssColor('--scene-grid');
  floor.position.y = -3.2;
  scene.add(floor);

  // The ground shader writes its colour as is, so give it the page colour in display (sRGB) values.
  TU.uBg.value.copy(cssColor('--bg')).convertLinearToSRGB();
  TU.uPixelRatio.value = renderer.getPixelRatio();
  terrain = makeTerrain(small);
  scene.add(terrain);

  resize();
  addEventListener('resize', resize);
}

let viewW = 1, viewH = 1;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  viewH = 2 * 10 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  viewW = viewH * camera.aspect;
}

// Pointer parallax, eased so it has weight rather than snapping to the cursor.
const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
if (finePointer && !reduce) {
  addEventListener('pointermove', e => {
    mouse.tx = (e.clientX / innerWidth) * 2 - 1;
    mouse.ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
}

const st = {
  x: 0, y: 0, scale: 1, rotX: 0.42, turn: 0.8, spin: 0.05, opacity: 1, active: 0, dim: 0, lift: 0, checks: 0, tamper: 0, scatter: 0,
  edgeA: 0, camX: 0, camY: 0, camZ: 10, floor: 1, terrain: 0, dust: 1, edges: 1,
  wSeal: 0, wGlobe: 0, wCoin: 0, wBox: 0, wRing: 0, markX: 0, brk: 0, toneFail: 0, toneGrey: 0, half: 0,
};
let t0 = performance.now(), time = 0, introT = 0, needsFrame = true, spun = 0, coinTurn = 0;
const startAt = performance.now() + 150;

const smooth = t => t * t * (3 - 2 * t);
const blend = (a, b, t) => { const o = {}; for (const k in a) o[k] = a[k] + (b[k] - a[k]) * t; return o; };

// Where a scene's slot sits on the z=0 plane, and the cluster scale that fits a shape of radius r into it
// (into its width alone when byWidth is set).
function slotPlace(sc, r, byWidth = false) {
  const b = sc.slot?.getBoundingClientRect();
  if (!b || !b.width) return { x: 0, y: 0 };
  const k = viewH / innerHeight;
  return {
    x: (b.left + b.width / 2 - innerWidth / 2) * k,
    y: (innerHeight / 2 - (b.top + b.height / 2)) * k,
    scale: ((byWidth ? b.width : Math.min(b.width, b.height)) / 2) * k / r,
  };
}

// How present a scene's object is. A pinned scene forms as it arrives, holds while pinned and dissolves as
// it leaves. A section that scrolls normally holds while it covers the middle of the screen, however tall it is.
function presence(sc) {
  const r = sc.sec.getBoundingClientRect(), H = innerHeight;
  // On phones nothing pins and each object has its own slot above its text: it forms as the slot scrolls
  // in and lets go as the slot leaves, so it never sits behind the words.
  if (innerWidth < 720) {
    const b = sc.slot?.getBoundingClientRect();
    if (!b || !b.height) return 0;
    return ramp(H - b.top, 0, b.height * 0.9) * ramp(b.bottom, 0, b.height * 0.9);
  }
  if (sc.pinned) return ramp((H - r.top) / H, 0.35, 1) * (1 - ramp((H - r.bottom) / H, 0, 0.6));
  return ramp(H - r.top, H * 0.3, H * 0.6) * ramp(r.bottom, H * 0.4, H * 0.7);
}

// What each pinned scene asks of the particles, given its progress through the pin.
function sceneTarget(sc, loose) {
  const p = pinnedProgress(sc.sec);
  if (sc.name === 'outcomes') {
    // Verified (lime check), then tampered (red, the mark breaks apart), then unapproved (grey X),
    // changing exactly where the text changes outcome.
    const b = p * 3;
    const fail = ramp(b, 0.85, 1.15) * (1 - ramp(b, 1.85, 2.15)), grey = ramp(b, 1.85, 2.15);
    return { ...loose, ...slotPlace(sc, 2.2), rotX: 0.1, spin: 0.04, opacity: 1, dust: 0, wSeal: 1, markX: grey, brk: fail, toneFail: fail, toneGrey: grey };
  }
  if (sc.name === 'explore') return { ...loose, ...slotPlace(sc, 2.7), rotX: 0.3, spin: 0.09, opacity: 0.95, dust: 0, wGlobe: 1 };
  if (sc.name === 'limits') {
    coinTurn = p * Math.PI * 4; // two full turns across the pin, a half turn per limit
    return { ...loose, ...slotPlace(sc, 2.1), rotX: 0.28, spin: 0.03, opacity: 1, dust: 0, wCoin: 1 };
  }
  if (sc.name === 'proves') {
    // Whole while what a proof shows arrives on the left; its right half comes loose as what it doesn't
    // show arrives on the right.
    return { ...loose, ...slotPlace(sc, 2.5), rotX: 0.32, spin: 0.03, opacity: 0.95, dust: 0, wBox: 1, half: ramp(p, 0.3, 0.6) };
  }
  if (sc.name === 'explorer') {
    // The explorer's seal shows the result: a lime check when verified, red and breaking when rejected,
    // grey with its mark loose when unattested, and grey while checking. With no result it stays dust.
    const v = sc.sec.dataset.verdict;
    if (!['verified', 'rejected', 'unattested', 'wait'].includes(v)) return loose;
    const fail = v === 'rejected' ? 1 : 0, grey = v === 'unattested' || v === 'wait' ? 1 : 0;
    const brk = v === 'rejected' ? 1 : v === 'unattested' ? 0.7 : v === 'wait' ? 1 : 0;
    return { ...loose, ...slotPlace(sc, 2.2), rotX: 0.1, spin: 0.04, opacity: 1, dust: 0, floor: 0, edges: 0, wSeal: 1, brk, toneFail: fail, toneGrey: grey };
  }
  if (sc.name === 'uses') {
    // One object per use case, formed while its text is on and burst back into dust between them: the
    // verified seal for risk checks, the globe for routes, a coin for payments, a sealed machine for data.
    const b = p * 4;
    const w = [0, 1, 2, 3].map(i => {
      let d = b - (i + 0.5);
      if ((i === 0 && d < 0) || (i === 3 && d > 0)) d = 0;
      return 1 - ramp(Math.abs(d), 0.3, 0.5);
    });
    const sum = w[0] + w[1] + w[2] + w[3];
    coinTurn = p * Math.PI * 3;
    return {
      ...loose, ...slotPlace(sc, 2.4), spin: 0.05, opacity: 1, dust: 1 - sum, floor: 0, edges: 0,
      rotX: 0.1 * w[0] + 0.3 * w[1] + 0.28 * w[2] + 0.32 * w[3] + 0.3 * (1 - sum),
      wSeal: w[0], wGlobe: w[1], wCoin: w[2], wBox: w[3], half: 0, markX: 0, brk: 0, toneFail: 0, toneGrey: 0,
    };
  }
  if (sc.name === 'cta') {
    // A ring lying round the headline, tilted so it reads as an ellipse that frames the words. A phone is too
    // narrow for it to clear the copy, so there the call to action keeps the plain dust.
    if (innerWidth < 720) return loose;
    return { ...loose, ...slotPlace(sc, 2.4, true), rotX: 0.44, spin: 0.06, opacity: 0.85, dust: 0, wRing: 1 };
  }
  return loose;
}

// The scene is one continuous journey. Each act is a full set of targets, and scroll position blends one
// act into the next, so nothing switches, jumps or blinks out between sections.
function targets() {
  const wide = innerWidth >= 720;
  const storyR = story?.getBoundingClientRect();
  const s = (story ? pinnedProgress(story) : 0) * 5;
  const baseScale = Math.min(viewH * 0.115, viewW * (wide ? 0.064 : 0.125));
  const statR = statementSec?.getBoundingClientRect();
  const asm = statR ? ramp((innerHeight - statR.top) / innerHeight, 0.1, 0.8) : 0;
  const enter = storyR ? ramp((innerHeight - storyR.top) / innerHeight, 0.35, 1) : 0;
  // Pages without the story go straight to the scene stage, starting from their dust.
  const morph = storyR ? ramp((innerHeight - storyR.bottom) / innerHeight, 0, 0.7) : 1;
  const footR = footer?.getBoundingClientRect();
  const footP = footR ? clamp01((innerHeight - footR.top) / innerHeight) : 0;
  const landR = land?.getBoundingClientRect();
  // Phones stack the page, so the cubes get room of their own instead of sitting beside the text: under
  // the statement, then in the gap the story leaves between its words and its checklist.
  const k = viewH / innerHeight;
  const toWorld = (px, py) => ({ x: (px - innerWidth / 2) * k, y: (innerHeight / 2 - py) * k });
  const under = !wide && statR ? toWorld(innerWidth / 2, statR.bottom - innerHeight * 0.23) : { x: 0, y: 0 };
  const stageR = !wide ? storyStage?.getBoundingClientRect() : null;
  const gap = stageR && stageR.height ? toWorld(stageR.left + stageR.width / 2, stageR.top + stageR.height / 2) : { x: 0, y: viewH * 0.17 };
  const fit = stageR && stageR.height ? Math.min(1, Math.max(0.5, stageR.height / 320)) : 1;

  // Act 1: loose dust behind the hero, which the statement assembles into the cube cluster beside it.
  const dust = {
    x: 0, y: 0, scale: baseScale, rotX: 0.42, turn: 0.8, spin: 0.05, opacity: wide ? 1 : 0.7, dust: 1,
    active: 0, dim: 0, lift: 0, checks: 0, tamper: 0, scatter: 0, edgeA: 0, camX: 0, camY: 0, camZ: 10, floor: 1, edges: 1,
    wSeal: 0, wGlobe: 0, wCoin: 0, wBox: 0, wRing: 0, markX: 0, brk: 0, toneFail: 0, toneGrey: 0, half: 0,
  };
  const cubes = { ...dust, x: wide ? viewW * 0.3 : under.x, y: wide ? 0 : under.y, scale: baseScale * 0.9, turn: 0, dust: 0 };
  // Act 2: the pinned story.
  const told = {
    ...cubes,
    x: wide ? viewW * 0.2 : gap.x, y: wide ? -viewH * 0.04 : gap.y, scale: baseScale * 0.74 * (wide ? 1 : fit),
    turn: 0.15 + s * 0.12, spin: 0.02,
    active: ramp(s, 0.1, 0.7), dim: ramp(s, 0.1, 0.7), lift: ramp(s, 1.05, 1.8) * 1.3, edgeA: ramp(s, 2.0, 2.6),
    checks: ramp(s, 3.0, 3.85) * 4, tamper: ramp(s, 4.0, 4.3), scatter: ramp(s, 4.15, 4.9),
    // On phones the camera barely moves, so the cubes stay inside their gap
    camZ: 10 - ramp(s, 0.6, 2.2) * (wide ? 2.2 : 0.6) + ramp(s, 3.9, 4.6) * (wide ? 1.1 : 0.3),
    camX: wide ? viewW * 0.2 * ramp(s, 0.6, 2.2) * 0.35 - ramp(s, 3.9, 4.6) * 0.4 : 0,
    camY: wide ? ramp(s, 2.2, 3.8) * 0.5 - ramp(s, 3.9, 4.6) * 0.5 : 0,
  };
  // Act 3: the story ends with the cubes bursting back into dust. Each pinned scene after it gathers the
  // dust into its own object in the slot beside its text (a seal, the globe, a coin) and lets it go again
  // as the scene leaves, so every hand-off has the same rhythm: form, hold, burst, form.
  const loose = statementSec ? {
    ...told, x: 0, y: 0, scale: baseScale, rotX: 0.42, turn: 0, spin: 0.05, opacity: wide ? 0.75 : 0.5, dust: 1,
    active: 0, dim: 0, lift: 0, checks: 0, tamper: 0, scatter: 0, edgeA: 0, camX: 0, camY: 0, camZ: 10, floor: 0, edges: 0,
  } : dust;
  let after = loose;
  for (const sc of sceneSecs) {
    const here = presence(sc);
    if (here > 0) after = blend(after, sceneTarget(sc, loose), smooth(here));
  }
  const tg = blend(blend(blend(dust, cubes, smooth(asm)), told, smooth(enter)), after, smooth(morph));
  // Act 4: the dust fades out as the footer arrives, and the mountains rise behind it.
  tg.opacity *= 1 - ramp(footP, 0.05, 0.5);
  tg.terrain = landR && landR.height ? clamp01((innerHeight - landR.top) / landR.height) : 0;
  // On other pages loose dust is full behind the page header, then quieter behind the reading. Anything
  // the dust has formed (the explorer's seal) keeps its full strength.
  if (!statementSec) tg.opacity *= 1 - 0.6 * tg.dust * ramp(scrollY / innerHeight, 0.15, 0.9);
  return tg;
}
if (SETTLE) window.__sceneTargets = targets;
if (SETTLE) window.__sceneParts = () => ({ terrain, TU, renderer, scene, camera });

function frame(now) {
  const dt = Math.min(0.05, (now - t0) / 1000);
  t0 = now;

  const storyP = story ? pinnedProgress(story) : 0;
  const storyR = story?.getBoundingClientRect();
  const landR = land?.getBoundingClientRect();

  if (story) updateStory(storyP);
  updateScenes();

  if (renderer) {
    time += reduce ? 0 : dt;
    introT = reduce || SETTLE ? 1 : Math.min(1, (now - startAt) / 2400);
    const tg = targets();
    // World height on the z=0 plane for a viewport pixel row (the camera looks straight down the z axis here).
    const yW = px => (0.5 - px / innerHeight) * viewH;
    // The ground follows the bottom of the footer, so the mountains scroll in with the page and the page ends on them.
    const groundY = landR ? yW(landR.bottom) + 0.35 : -2.6;

    const rate = SETTLE ? 1e4 : reduce ? 40 : 4.5;
    for (const k of Object.keys(st)) st[k] = damp(st[k], tg[k], k === 'checks' ? 10 : rate, dt);
    // The turn accumulates from an eased speed, so an act changing pace never makes the cluster jump.
    spun += st.spin * (reduce ? 0 : dt);
    mouse.x = damp(mouse.x, mouse.tx, 3, dt);
    mouse.y = damp(mouse.y, mouse.ty, 3, dt);

    camera.position.set(st.camX + mouse.x * 0.25, st.camY - mouse.y * 0.15, st.camZ);
    camera.lookAt(st.camX * 0.6, st.camY * 0.6, 0);
    floor.position.z = reduce ? 0 : (time * 0.35) % 1;
    floor.material.opacity = 0.5 * st.floor;
    floor.visible = st.floor > 0.01;

    cluster.visible = st.opacity > 0.01;
    cluster.position.set(st.x, st.y, 0);
    cluster.scale.setScalar(st.scale);
    const rotY = -0.6 + spun + st.turn + mouse.x * 0.22;
    cluster.rotation.set(st.rotX + mouse.y * 0.12, rotY, 0.06);
    terrain.position.y = groundY;
    // The seal faces you with a slow sway; the coin turns with the scroll plus a slow idle turn.
    U.uSealYaw.value = -rotY + 0.3 * Math.sin(time * 0.5) + mouse.x * 0.2;
    U.uCoinYaw.value = -rotY + coinTurn + time * 0.35;
    U.uBoxYaw.value = -rotY + 0.5 + 0.18 * Math.sin(time * 0.4);

    // Globe labels: each sits on a point of the globe, turns with it and fades out round the back.
    if (pinsEl) {
      const show = innerWidth >= 900 ? ramp(st.wGlobe, 0.85, 1) : 0;
      pinsEl.style.visibility = show > 0.01 ? 'visible' : 'hidden';
      if (show > 0.01) {
        cluster.updateMatrixWorld();
        const centre = tmpC.setFromMatrixPosition(cluster.matrixWorld);
        pins.forEach(pin => {
          const w = tmpV.set(pin.dir[0] * 2.1, pin.dir[1] * 2.1, pin.dir[2] * 2.1).applyMatrix4(cluster.matrixWorld);
          const facing = tmpN.copy(w).sub(centre).normalize().dot(tmpD.copy(camera.position).sub(w).normalize());
          const v = w.project(camera);
          const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight;
          const tx = Math.min(innerWidth - pin.el.offsetWidth - 16, x - 14);
          pin.el.style.transform = `translate(${tx.toFixed(1)}px, ${(y - pin.el.offsetHeight / 2).toFixed(1)}px)`;
          pin.el.style.opacity = (show * ramp(facing, 0.05, 0.35)).toFixed(3);
        });
      }
    }

    // Tags: once the cluster has assembled beside the statement, project three cube corners to the
    // screen and pin a label to each with a line. They leave as the story arrives.
    if (tagsEl) {
      const storyIn = storyR ? clamp01((innerHeight - storyR.top) / (innerHeight * 0.5)) : 0;
      const alpha = innerWidth >= 900 ? ramp(1 - st.dust, 0.9, 1) * (1 - storyIn) : 0;
      tagsEl.style.opacity = alpha.toFixed(3);
      if (alpha > 0.01) {
        cluster.updateMatrixWorld();
        TAG_ANCHORS.forEach((a, i) => {
          const v = tmpV.set(...a.p).applyMatrix4(cluster.matrixWorld).project(camera);
          const ax = (v.x + 1) / 2 * innerWidth, ay = (1 - v.y) / 2 * innerHeight;
          const el = tags[i], w = el.offsetWidth, h = el.offsetHeight;
          const tx = Math.min(innerWidth - w - 16, Math.max(16, ax + a.dx - (a.dx < 0 ? w : 0)));
          const ty = ay + a.dy - h / 2;
          el.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
          const line = tagLines[i];
          line.setAttribute('x1', ax.toFixed(1)); line.setAttribute('y1', ay.toFixed(1));
          line.setAttribute('x2', (a.dx < 0 ? tx + w : tx).toFixed(1)); line.setAttribute('y2', (ty + h / 2).toFixed(1));
        });
      }
    }

    U.uTime.value = time;
    U.uIntro.value = st.dust;
    U.uOpacity.value = st.opacity * easeOutExpo(introT);
    U.uActiveAmt.value = st.active;
    U.uOthersDim.value = st.dim;
    U.uLift.value = st.lift;
    U.uChecks.value = st.checks;
    U.uTamperAmt.value = st.tamper;
    U.uScatter.value = st.scatter;
    U.uW.value.set(st.wSeal, st.wGlobe, st.wCoin);
    U.uW2.value.set(st.wBox, st.wRing);
    U.uHalf.value = st.half;
    U.uMarkX.value = st.markX;
    U.uBreak.value = st.brk;

    const base = U.uColor.value, accent = U.uAccent.value, fail = U.uFail.value;
    U.uSeal.value.copy(accent).lerp(fail, st.toneFail).lerp(SEAL_GREY, st.toneGrey);
    const shape = (1 - st.wSeal - st.wGlobe - st.wCoin - st.wBox - st.wRing) * st.edges;
    edges.forEach((l, i) => {
      const m = l.material;
      l.visible = shape > 0.02;
      if (!l.visible) return;
      const intro = 1 - U.uIntro.value;
      if (i === ACTIVE) {
        m.color.copy(base).lerp(accent, Math.max(st.active, st.edgeA));
        m.opacity = (0.22 + 0.6 * st.edgeA) * st.opacity * shape * intro;
        l.position.z = l.userData.home + st.lift;
      } else if (i === TAMPER) {
        m.color.copy(base).lerp(fail, st.tamper);
        m.opacity = 0.22 * (1 - st.scatter) * st.opacity * shape * intro;
        l.scale.setScalar(1 + st.scatter * 0.5);
      } else {
        m.color.copy(base);
        m.opacity = 0.22 * st.opacity * (1 - st.dim * 0.7) * shape * intro;
      }
    });


    terrain.visible = st.terrain > 0.01;
    TU.uOpacity.value = st.terrain;
    TU.uRise.value = st.terrain;
    TU.uTime.value = time;

    renderer.render(scene, camera);
  }

  if (!reduce || needsFrame) requestAnimationFrame(frame);
  needsFrame = false;
}

if (glOK) {
  try { initGL(); } catch (e) { console.error(e); root.classList.add('no-webgl'); renderer = null; }
}
root.classList.add('scene-ready');

// Reduced motion: the loop stops after a frame; scrolling or resizing asks for one more.
if (reduce) {
  const kick = () => { if (!needsFrame) { needsFrame = true; requestAnimationFrame(frame); } };
  addEventListener('scroll', kick, { passive: true });
  addEventListener('resize', kick);
}
requestAnimationFrame(frame);
