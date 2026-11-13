// 新任务首页背景字符波纹场：等宽数字与字母网格在漂移云层下稀疏显隐，左键点按主区激起阻尼二维波纹（前缘蓝色、尾迹淡灰），随余晖自然消散。
// WebGL2 单通道纹理图集绘制；静止时只按字符刷新周期定时唤醒，无波纹不跑帧循环；减弱动态或关闭设置项时不挂载。
import { useEffect, useRef } from "react";
import { useShellValue } from "../../app/shell-store.ts";
import { useSettings } from "../../store/index.ts";
import { onThemeChange } from "../../ui/theme-change.ts";

const RIPPLE = {
  fontSize: 10,
  cellWidth: 7,
  cellHeight: 15,
  changeRate: 2,
  digitRatio: 0.3,
  cloudScale: 100,
  cloudCoverage: 0.65,
  cloudSoftness: 0.1,
  cloudDrift: 8,
  idleAlphaLight: 0.045,
  idleAlphaDark: 0.06,
  speedNear: 1100,
  speedFar: 80,
  speedFalloff: 240,
  damping: 1,
  borderCells: 6,
  turbulence: 0.45,
  turbulenceScale: 180,
  sourceFrequency: 6,
  sourceRadius: 36,
  sourceAmplitude: 1.4,
  waveGain: 3.5,
  glowDecay: 1.2,
  glowAlpha: 0.22,
  waveAlpha: 0.85,
  patchScale: 60,
  patchFloor: 0.3,
} as const;

const WAVE_STEP = 1 / 600;
const MAX_ADVANCE = 0.05;
const REST_HEIGHT = 0.003;
const DIGITS = "0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GLYPHS = DIGITS + LETTERS;
const COVERAGE_TO_THRESHOLD = 0.39;
const INVISIBLE_ALPHA = 0.01;

type Rgb = readonly [number, number, number];

interface FieldPalette {
  ink: Rgb;
  wave: Rgb;
  dark: boolean;
  fontFamily: string;
}

function hash(a: number, b: number): number {
  let h = (a * 374_761_393 + b * 668_265_263) | 0;
  h = ((h ^ (h >>> 13)) * 1_274_126_177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx;
  const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

function fractalNoise(x: number, y: number): number {
  return (valueNoise(x, y) * 4 + valueNoise(x * 2.1 + 7, y * 2.1 + 3) * 2 + valueNoise(x * 4.3 + 13, y * 4.3 + 11)) / 7;
}

function smooth(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function glyphIndex(column: number, row: number, tick: number): number {
  const digit = hash(column * 7 + tick * 13, row * 11 + tick * 3) < RIPPLE.digitRatio;
  const pick = hash(column * 131 + tick, row * 197 + tick * 7);
  return digit ? Math.floor(pick * DIGITS.length) : DIGITS.length + Math.floor(pick * LETTERS.length);
}

function cloudClear(x: number, y: number): number {
  const noise = fractalNoise(x / RIPPLE.cloudScale, y / RIPPLE.cloudScale);
  const threshold = 0.5 + (RIPPLE.cloudCoverage - 0.5) * COVERAGE_TO_THRESHOLD;
  return smooth((noise - threshold + RIPPLE.cloudSoftness) / (2 * RIPPLE.cloudSoftness));
}

function patchClear(x: number, y: number): number {
  const noise = fractalNoise(x / RIPPLE.patchScale + 31, y / RIPPLE.patchScale + 17);
  return RIPPLE.patchFloor + (1 - RIPPLE.patchFloor) * smooth((noise - 0.35) / 0.3);
}

interface Source {
  column: number;
  row: number;
  time: number;
  duration: number;
  radiusScale: number;
  amplitudeScale: number;
}

interface WaveField {
  readonly height: Float32Array;
  active(): boolean;
  disturb(column: number, row: number): void;
  advance(seconds: number): void;
}

function createWaveField(columns: number, rows: number): WaveField {
  const cells = columns * rows;
  const height = new Float32Array(cells);
  const velocity = new Float32Array(cells);
  const speedSquared = new Float32Array(cells);
  const speedFactor = new Float32Array(cells);
  const damping = new Float32Array(cells);
  const seed = Math.random() * 1000;
  const { cellWidth, cellHeight } = RIPPLE;
  const widthSquared = cellWidth * cellWidth;
  const heightSquared = cellHeight * cellHeight;
  let sources: Source[] = [];
  let moving = false;
  let behind = 0;

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const cell = row * columns + column;
      const noise = fractalNoise(
        (column * cellWidth) / RIPPLE.turbulenceScale + seed,
        (row * cellHeight) / RIPPLE.turbulenceScale + seed,
      );
      speedFactor[cell] = Math.min(1.4, Math.max(0.3, 1 + RIPPLE.turbulence * (noise - 0.5) * 3.2));
      const edge = Math.min(column, row, columns - 1 - column, rows - 1 - row);
      const border = Math.max(0, 1 - edge / RIPPLE.borderCells) ** 2;
      damping[cell] = RIPPLE.damping + border * 12;
    }
  }

  function raiseSpeeds(column: number, row: number): void {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const cell = r * columns + c;
        const distance = Math.hypot((c - column) * cellWidth, (r - row) * cellHeight);
        const speed =
          (RIPPLE.speedFar + (RIPPLE.speedNear - RIPPLE.speedFar) * Math.exp(-distance / RIPPLE.speedFalloff)) *
          (speedFactor[cell] ?? 1);
        const squared = speed * speed;
        if (squared > (speedSquared[cell] ?? 0)) speedSquared[cell] = squared;
      }
    }
  }

  function drive(): void {
    for (const source of sources) {
      const envelope = Math.sin((Math.PI * source.time) / source.duration);
      const rate = Math.cos(2 * Math.PI * RIPPLE.sourceFrequency * source.time) * 2 * Math.PI * RIPPLE.sourceFrequency;
      const radius = RIPPLE.sourceRadius * source.radiusScale;
      const reachColumns = Math.ceil((radius * 3) / cellWidth);
      const reachRows = Math.ceil((radius * 3) / cellHeight);
      for (let r = Math.max(0, source.row - reachRows); r <= Math.min(rows - 1, source.row + reachRows); r++) {
        for (
          let c = Math.max(0, source.column - reachColumns);
          c <= Math.min(columns - 1, source.column + reachColumns);
          c++
        ) {
          const dx = (c - source.column) * cellWidth;
          const dy = (r - source.row) * cellHeight;
          const gauss = Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius));
          const idx = r * columns + c;
          height[idx] =
            (height[idx] ?? 0) + RIPPLE.sourceAmplitude * source.amplitudeScale * envelope * rate * gauss * WAVE_STEP;
        }
      }
      source.time += WAVE_STEP;
    }
    sources = sources.filter((source) => source.time < source.duration);
  }

  function step(): void {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const cell = r * columns + c;
        const here = height[cell] ?? 0;
        const left = height[c > 0 ? cell - 1 : cell] ?? 0;
        const right = height[c < columns - 1 ? cell + 1 : cell] ?? 0;
        const above = height[r > 0 ? cell - columns : cell] ?? 0;
        const below = height[r < rows - 1 ? cell + columns : cell] ?? 0;
        const laplacian = (left + right - 2 * here) / widthSquared + (above + below - 2 * here) / heightSquared;
        velocity[cell] =
          (velocity[cell] ?? 0) +
          ((speedSquared[cell] ?? 0) * laplacian - (damping[cell] ?? 1) * (velocity[cell] ?? 0)) * WAVE_STEP;
      }
    }
    let peak = 0;
    for (let cell = 0; cell < cells; cell++) {
      const next = (height[cell] ?? 0) + (velocity[cell] ?? 0) * WAVE_STEP;
      height[cell] = next;
      peak = Math.max(peak, Math.abs(next));
    }
    drive();
    moving = sources.length > 0 || peak > REST_HEIGHT;
    if (!moving) {
      height.fill(0);
      velocity.fill(0);
      speedSquared.fill(0);
    }
  }

  return {
    height,
    active: () => moving,
    disturb(column, row) {
      if (columns <= 0 || rows <= 0) return;
      raiseSpeeds(column, row);
      sources.push({
        column,
        row,
        time: 0,
        duration: (1 + Math.floor(Math.random() * 2)) / RIPPLE.sourceFrequency,
        radiusScale: 0.7 + Math.random() * 1.1,
        amplitudeScale: 0.6 + Math.random() * 0.8,
      });
      moving = true;
    },
    advance(seconds) {
      if (columns <= 0 || rows <= 0) return;
      behind += Math.min(Math.max(0, seconds), MAX_ADVANCE);
      while (behind >= WAVE_STEP) {
        step();
        behind -= WAVE_STEP;
      }
    },
  };
}

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D cells;
uniform sampler2D atlas;
uniform vec2 size;
uniform vec2 grid;
uniform vec2 cellPixels;
uniform vec2 atlasCell;
uniform float glyphCount;
uniform vec3 ink;
uniform vec3 wave;
out vec4 color;
void main() {
  vec2 position = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 cell = min(floor(position / cellPixels), grid - 1.0);
  vec2 local = position - cell * cellPixels;
  vec4 data = texelFetch(cells, ivec2(cell), 0);
  float glyph = floor(data.r * 255.0 + 0.5);
  vec2 inAtlas = vec2(glyph * atlasCell.x + local.x * atlasCell.x / cellPixels.x, local.y * atlasCell.y / cellPixels.y);
  float coverage = texture(atlas, inAtlas / vec2(glyphCount * atlasCell.x, atlasCell.y)).a;
  float alpha = data.g * coverage;
  color = vec4(mix(ink, wave, data.b) * alpha, alpha);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

interface GlyphField {
  draw(now: number, palette: FieldPalette, still: boolean): void;
  needsDraw(now: number, still: boolean): boolean;
  busy(): boolean;
  invalidate(): void;
  dispose(): void;
}

function createGlyphField(
  canvas: HTMLCanvasElement,
  columns: number,
  rows: number,
  waves: WaveField,
): GlyphField | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (gl === null) return null;
  const atlasCanvas = canvas.ownerDocument.createElement("canvas");
  const atlasContext = atlasCanvas.getContext("2d");
  if (atlasContext === null) return null;

  const cells = Math.max(1, columns * rows);
  const data = new Uint8Array(cells * 4);
  let program: WebGLProgram | null = null;
  let cellTexture: WebGLTexture | null = null;
  let atlasTexture: WebGLTexture | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let atlasKey = "";

  function createTexture(unit: number, filter: number): WebGLTexture | null {
    const texture = gl!.createTexture();
    if (texture === null) return null;
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, texture);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    return texture;
  }

  function build(): boolean {
    const vs = compileShader(gl!, gl!.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl!, gl!.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (vs === null || fs === null) return false;
    const created = gl!.createProgram();
    if (created === null) return false;
    gl!.attachShader(created, vs);
    gl!.attachShader(created, fs);
    gl!.linkProgram(created);
    gl!.deleteShader(vs);
    gl!.deleteShader(fs);
    if (!gl!.getProgramParameter(created, gl!.LINK_STATUS)) {
      gl!.deleteProgram(created);
      return false;
    }
    program = created;
    gl!.useProgram(program);
    uniforms = {};
    for (const name of ["cells", "atlas", "size", "grid", "cellPixels", "atlasCell", "glyphCount", "ink", "wave"]) {
      uniforms[name] = gl!.getUniformLocation(program, name);
    }
    cellTexture = createTexture(0, gl!.NEAREST);
    atlasTexture = createTexture(1, gl!.LINEAR);
    if (cellTexture === null || atlasTexture === null) return false;
    if (uniforms["cells"]) gl!.uniform1i(uniforms["cells"], 0);
    if (uniforms["atlas"]) gl!.uniform1i(uniforms["atlas"], 1);
    atlasKey = "";
    return true;
  }

  if (!build()) return null;

  function buildAtlas(font: string, dpr: number): void {
    const safeFont = font !== "" ? font : "monospace";
    const key = `${safeFont}|${dpr}`;
    if (key === atlasKey || atlasTexture === null) return;
    const width = Math.ceil(RIPPLE.cellWidth * dpr);
    const height = Math.ceil(RIPPLE.cellHeight * dpr);
    atlasCanvas.width = width * GLYPHS.length;
    atlasCanvas.height = height;
    atlasContext!.setTransform(width / RIPPLE.cellWidth, 0, 0, height / RIPPLE.cellHeight, 0, 0);
    atlasContext!.clearRect(0, 0, RIPPLE.cellWidth * GLYPHS.length, RIPPLE.cellHeight);
    atlasContext!.font = `${RIPPLE.fontSize}px ${safeFont}`;
    atlasContext!.textBaseline = "middle";
    atlasContext!.textAlign = "center";
    atlasContext!.fillStyle = "#fff";
    for (let index = 0; index < GLYPHS.length; index++) {
      atlasContext!.fillText(
        GLYPHS[index] ?? "0",
        index * RIPPLE.cellWidth + RIPPLE.cellWidth / 2,
        RIPPLE.cellHeight / 2,
      );
    }
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTexture);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, atlasCanvas);
    if (uniforms["atlasCell"]) gl!.uniform2f(uniforms["atlasCell"], width, height);
    if (uniforms["glyphCount"]) gl!.uniform1f(uniforms["glyphCount"], GLYPHS.length);
    atlasKey = key;
  }

  const { cellWidth, cellHeight } = RIPPLE;
  const glow = new Float32Array(cells);
  const patch = new Float32Array(cells);
  const glyphs = new Uint8Array(cells);
  const cloudColumns = new Map<number, Float32Array>();
  let lastTick = -1;
  let lastDraw = 0;
  let glowing = false;
  let stale = true;

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      patch[row * columns + column] = patchClear(column * cellWidth + cellWidth / 2, row * cellHeight + cellHeight / 2);
    }
  }

  function onContextLost(event: Event): void {
    event.preventDefault();
  }
  function onContextRestored(): void {
    if (build()) stale = true;
  }
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  function tickAt(now: number, still: boolean): number {
    return still ? 0 : Math.floor((now / 1000) * RIPPLE.changeRate);
  }

  function cloudColumn(absolute: number): Float32Array {
    let column = cloudColumns.get(absolute);
    if (column === undefined) {
      column = new Float32Array(rows);
      for (let row = 0; row < rows; row++) {
        column[row] = cloudClear(absolute * cellWidth + cellWidth / 2, row * cellHeight + cellHeight / 2);
      }
      cloudColumns.set(absolute, column);
    }
    return column;
  }

  return {
    invalidate() {
      stale = true;
    },
    busy: () => waves.active() || glowing,
    needsDraw(now, still) {
      return stale || waves.active() || glowing || tickAt(now, still) !== lastTick;
    },
    draw(now, palette, still) {
      if (columns <= 0 || rows <= 0 || program === null || cellTexture === null) return;
      const tick = tickAt(now, still);
      if (tick !== lastTick) {
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) {
            glyphs[row * columns + column] = glyphIndex(column, row, tick);
          }
        }
      }
      const drift = Math.floor(((still ? 0 : now / 1000) * RIPPLE.cloudDrift) / cellWidth);
      for (const absolute of cloudColumns.keys()) {
        if (absolute < drift) cloudColumns.delete(absolute);
      }
      const decay = Math.exp(-Math.min(Math.max(0, now - lastDraw) / 1000, 0.1) / RIPPLE.glowDecay);
      const idleAlpha = palette.dark ? RIPPLE.idleAlphaDark : RIPPLE.idleAlphaLight;

      let brightest = 0;
      for (let column = 0; column < columns; column++) {
        const clouds = cloudColumn(column + drift);
        for (let row = 0; row < rows; row++) {
          const cell = row * columns + column;
          const strength = Math.tanh(RIPPLE.waveGain * Math.abs(waves.height[cell] ?? 0));
          const shown = Math.max((glow[cell] ?? 0) * decay, strength);
          const lit = shown < 0.01 ? 0 : shown;
          glow[cell] = lit;
          let alpha = idleAlpha * (clouds[row] ?? 0);
          if (lit > 0) {
            brightest = Math.max(brightest, lit);
            alpha = Math.min(1, alpha + (patch[cell] ?? 1) * (lit * RIPPLE.glowAlpha + strength * RIPPLE.waveAlpha));
          }
          const at = cell * 4;
          data[at] = glyphs[cell] ?? 0;
          data[at + 1] = alpha < INVISIBLE_ALPHA ? 0 : Math.round(alpha * 255);
          data[at + 2] = lit > 0 ? Math.round(strength * 255) : 0;
        }
      }

      const dpr = canvas.width / Math.max(1, columns * cellWidth);
      buildAtlas(palette.fontFamily, dpr);
      gl.useProgram(program);
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (uniforms["size"]) gl.uniform2f(uniforms["size"], canvas.width, canvas.height);
      if (uniforms["grid"]) gl.uniform2f(uniforms["grid"], columns, rows);
      if (uniforms["cellPixels"]) gl.uniform2f(uniforms["cellPixels"], RIPPLE.cellWidth * dpr, RIPPLE.cellHeight * dpr);
      if (uniforms["ink"])
        gl.uniform3f(uniforms["ink"], palette.ink[0] / 255, palette.ink[1] / 255, palette.ink[2] / 255);
      if (uniforms["wave"])
        gl.uniform3f(uniforms["wave"], palette.wave[0] / 255, palette.wave[1] / 255, palette.wave[2] / 255);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cellTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, columns, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      glowing = brightest > 0;
      lastTick = tick;
      lastDraw = now;
      stale = false;
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (program !== null) gl.deleteProgram(program);
      if (cellTexture !== null) gl.deleteTexture(cellTexture);
      if (atlasTexture !== null) gl.deleteTexture(atlasTexture);
    },
  };
}

let probeCtx: CanvasRenderingContext2D | null = null;

function resolveCssColor(raw: string, fallback: Rgb): Rgb {
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  if (probeCtx === null) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    probeCtx = c.getContext("2d", { willReadFrequently: true });
  }
  if (probeCtx === null) return fallback;
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = "#8a8a85";
  probeCtx.fillStyle = trimmed;
  probeCtx.fillRect(0, 0, 1, 1);
  const px = probeCtx.getImageData(0, 0, 1, 1).data;
  return [px[0] ?? fallback[0], px[1] ?? fallback[1], px[2] ?? fallback[2]];
}

function readFieldPalette(canvas: HTMLCanvasElement): FieldPalette {
  const style = getComputedStyle(canvas);
  const dark = style.colorScheme === "dark";
  const ink = resolveCssColor(style.getPropertyValue("--text-3"), [138, 138, 133]);
  // 波纹前缘跟主题强调色：写死一片蓝会在暖色 / 森系主题里变成噪点。
  const wave = resolveCssColor(style.getPropertyValue("--accent"), dark ? [127, 166, 255] : [59, 110, 240]);
  const fontFamily = style.getPropertyValue("--font-mono").trim() || "monospace";
  return { ink, wave, dark, fontFamily };
}

export function HomeRippleCanvas() {
  const enabled = useShellValue("homeRipple") !== false;
  const reduceMotion = useSettings()?.reduceMotion === true;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = canvas?.parentElement;
    if (!enabled || !canvas || !root) return;

    const systemReduced = () => reduceMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = -1;
    let height = -1;
    let dpr = 0;
    let waves: WaveField = createWaveField(0, 0);
    let field: GlyphField | null = null;
    let palette = readFieldPalette(canvas);
    let timer = 0;
    let raf = 0;
    let previous = performance.now();

    function stopTimers(): void {
      if (timer !== 0) {
        window.clearTimeout(timer);
        timer = 0;
      }
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function sleep(now: number): void {
      if (document.hidden || systemReduced()) return;
      const period = 1000 / RIPPLE.changeRate;
      timer = window.setTimeout(wake, period - (now % period) + 1);
    }

    function stepFrame(now: number): void {
      raf = 0;
      if (!field) return;
      const still = systemReduced();
      waves.advance(still ? 0 : (now - previous) / 1000);
      previous = now;
      if (canvas!.width > 0 && field.needsDraw(now, still)) {
        field.draw(now, palette, still);
      }
      if (field.busy() && !still) wake();
      else sleep(now);
    }

    function wake(): void {
      if (timer !== 0) {
        window.clearTimeout(timer);
        timer = 0;
      }
      if (document.hidden || raf !== 0 || !field) return;
      raf = window.requestAnimationFrame(stepFrame);
    }

    function layout(): void {
      const nextWidth = root!.clientWidth;
      const nextHeight = root!.clientHeight;
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (nextWidth <= 0 || nextHeight <= 0) return;
      if (nextWidth === width && nextHeight === height && nextDpr === dpr) return;
      const columns = Math.ceil(nextWidth / RIPPLE.cellWidth);
      const rows = Math.ceil(nextHeight / RIPPLE.cellHeight);
      width = nextWidth;
      height = nextHeight;
      dpr = nextDpr;
      canvas!.width = Math.round(columns * RIPPLE.cellWidth * nextDpr);
      canvas!.height = Math.round(rows * RIPPLE.cellHeight * nextDpr);
      canvas!.style.width = `${columns * RIPPLE.cellWidth}px`;
      canvas!.style.height = `${rows * RIPPLE.cellHeight}px`;
      field?.dispose();
      waves = createWaveField(columns, rows);
      field = createGlyphField(canvas!, columns, rows, waves);
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.button !== 0 || systemReduced() || !field) return;
      const box = canvas!.getBoundingClientRect();
      const column = Math.floor((event.clientX - box.left) / RIPPLE.cellWidth);
      const row = Math.floor((event.clientY - box.top) / RIPPLE.cellHeight);
      previous = performance.now();
      waves.disturb(column, row);
      wake();
    }

    function onVisibility(): void {
      if (!document.hidden) {
        previous = performance.now();
        wake();
      } else {
        stopTimers();
      }
    }

    layout();
    wake();

    const resizeObserver = new ResizeObserver(() => {
      layout();
      wake();
    });
    resizeObserver.observe(root);
    root.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    const stopTheme = onThemeChange(() => {
      palette = readFieldPalette(canvas);
      field?.invalidate();
      wake();
    });

    return () => {
      stopTimers();
      resizeObserver.disconnect();
      root.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("visibilitychange", onVisibility);
      stopTheme();
      field?.dispose();
    };
  }, [enabled, reduceMotion]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} className="empty-ripple-canvas" aria-hidden="true" data-testid="empty-ripple" />;
}
