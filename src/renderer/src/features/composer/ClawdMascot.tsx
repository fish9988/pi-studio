// 输入框右上沿的桌面宠物（完整复刻原版多帧精灵表与 Web Animations 帧动画引擎）：
// 支持 Claude 像素蟹（crab，19 套双层墨水遮罩精灵表）、DeepSeek 小鲸鱼（deepy，18 套 5× 矢量精灵表）、
// DeepSeek 像素鲸鱼娘（whalegirl，22 套可变帧率像素条带）、OMP 像素 π（omp）与关闭（off）。
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { MascotCharacter, TaskState, TaskStatus } from "../../../../shared/ipc.ts";
import { useShellValue } from "../../app/shell-store.ts";
import { useT } from "../../i18n/use-t.ts";
import { useSettings } from "../../store/settings-store.ts";
import { systemReducesMotion } from "../settings/motion-preference.ts";
import crabUrlsRaw from "./crab-urls.json";
import { formatCount, formatMoney } from "./usage-format.ts";

const MASCOT_POS_STORAGE_KEY = "pi-studio:mascot-offset";

interface MascotOffset {
  x: number;
  y: number;
}

function readMascotOffset(): MascotOffset {
  try {
    const raw = globalThis.localStorage?.getItem(MASCOT_POS_STORAGE_KEY);
    if (!raw) return { x: 0, y: 0 };
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { x?: unknown }).x === "number" &&
      typeof (parsed as { y?: unknown }).y === "number" &&
      Number.isFinite((parsed as { x: number }).x) &&
      Number.isFinite((parsed as { y: number }).y)
    ) {
      return {
        x: Math.max(-720, Math.min(480, Math.round((parsed as { x: number }).x))),
        y: Math.max(-600, Math.min(240, Math.round((parsed as { y: number }).y))),
      };
    }
  } catch {
    // 忽略读取异常
  }
  return { x: 0, y: 0 };
}

function writeMascotOffset(offset: MascotOffset): void {
  try {
    if (offset.x === 0 && offset.y === 0) globalThis.localStorage?.removeItem(MASCOT_POS_STORAGE_KEY);
    else globalThis.localStorage?.setItem(MASCOT_POS_STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // 忽略配额异常
  }
}

type MascotAnimKey =
  | "idle"
  | "idle-look"
  | "idle-wave"
  | "idle-laptop"
  | "idle-spout"
  | "thinking"
  | "typing"
  | "music"
  | "conducting"
  | "building"
  | "error"
  | "happy"
  | "notification"
  | "compacting"
  | "sleeping"
  | "waking"
  | "poke-left"
  | "poke-right"
  | "tickle"
  | "drag";

interface MascotSheet {
  frames: number;
  box: [number, number, number, number];
  still: number;
  columns?: number;
  durs?: number[];
}

const CRAB_URLS = crabUrlsRaw as Record<string, { body: string; ink: string }>;

/** 精灵表地址：下面两张表里写的是公开目录的相对路径（`./mascot/x.svg`），但自定义属性是在 composer.css 里被
 *  `background-image: var(--mascot-sheet)` 消费的，相对 url() 会按**那份样式表**解析——开发时 CSS 由 Vite 注入文档，
 *  基址是 `http://localhost:5173/` 所以能用；打包后样式表在 `app://studio/assets/index-xxx.css`，就变成
 *  `app://studio/assets/mascot/x.svg`（404，鲸鱼娘和小鲸鱼都不显示）。这里一律换成绝对地址，两边都对得上。 */
function sheetUrl(url: string): string {
  return new URL(url, document.baseURI).href;
}

const DEEPY_SHEET_URLS: Record<string, string> = {
  idle: "./mascot/22360387d0e1.svg",
  "idle-look": "./mascot/ae2250afa4d4.svg",
  "idle-spout": "./mascot/7f10aaf08b36.svg",
  thinking: "./mascot/07ba49c55318.svg",
  typing: "./mascot/917b19426a88.svg",
  music: "./mascot/e4c4d54e666e.svg",
  conducting: "./mascot/2d4bd629514d.svg",
  building: "./mascot/84bc02d65566.svg",
  error: "./mascot/d0b76604f76f.svg",
  happy: "./mascot/62647b81453f.svg",
  notification: "./mascot/b5c88fffcd08.svg",
  compacting: "./mascot/bd48fda92d54.svg",
  sleeping: "./mascot/c94f98071b0f.svg",
  waking: "./mascot/aee0b9809ae6.svg",
  "poke-left": "./mascot/5ff45ccd6396.svg",
  "poke-right": "./mascot/6cda22c8c355.svg",
  tickle: "./mascot/192fda8da55a.svg",
  drag: "./mascot/3b6d7b199795.svg",
};

const WHALE_GIRL_SHEET_URLS: Record<string, string> = {
  idle: "./mascot/012cc14e9f0e.png",
  "idle-look": "./mascot/737bbc7bac2e.png",
  "idle-spout": "./mascot/b523bd91586b.png",
  thinking: "./mascot/bbb172bc2d30.png",
  typing: "./mascot/667ef769c4cf.png",
  music: "./mascot/f78f468b38e7.png",
  conducting: "./mascot/6e1d28718c56.png",
  building: "./mascot/3584a1cea0ef.png",
  error: "./mascot/5ffd3420f353.png",
  happy: "./mascot/b75776c4e109.png",
  notification: "./mascot/40ad6f7bff18.png",
  compacting: "./mascot/2ee5f5c4da8d.png",
  carrying: "./mascot/97e74499dffc.png",
  sleeping: "./mascot/59c57341b28b.png",
  waking: "./mascot/6f19e3c60d66.png",
  "poke-left": "./mascot/467d7763b760.png",
  "poke-right": "./mascot/9bad6b536520.png",
  tickle: "./mascot/61494b8e050c.png",
  drag: "./mascot/656baa41eef1.png",
  swim: "./mascot/8a2b002872f2.png",
  "smile-hearts": "./mascot/e22e8d694fc9.png",
  "thumbs-up": "./mascot/f5ab76c06270.png",
};

const CRAB_SHEETS: Record<string, MascotSheet> = {
  idle: { frames: 24, box: [24, 20, 24, 16], still: 0 },
  "idle-look": { frames: 31, box: [24, 20, 24, 16], still: 0 },
  "idle-wave": { frames: 12, box: [24, 15, 24, 21], still: 0 },
  "idle-laptop": { frames: 43, box: [14, 13, 34, 23], still: 0 },
  thinking: { frames: 48, box: [20, 0, 30, 36], still: 24 },
  typing: { frames: 6, box: [15, 22, 28, 14], still: 0 },
  music: { frames: 16, box: [19, 9, 31, 27], still: 0 },
  conducting: { frames: 24, box: [20, 12, 29, 24], still: 0 },
  building: { frames: 6, box: [15, 19, 28, 17], still: 0 },
  error: { frames: 24, box: [23, 11, 26, 25], still: 4 },
  happy: { frames: 32, box: [18, 6, 34, 30], still: 3 },
  notification: { frames: 16, box: [24, 8, 24, 28], still: 0 },
  compacting: { frames: 20, box: [21, 20, 30, 16], still: 3 },
  sleeping: { frames: 32, box: [18, 1, 31, 35], still: 0 },
  waking: { frames: 12, box: [24, 4, 24, 32], still: 11 },
  "poke-left": { frames: 10, box: [24, 20, 27, 16], still: 0 },
  "poke-right": { frames: 10, box: [21, 20, 27, 16], still: 0 },
  tickle: { frames: 16, box: [23, 18, 26, 18], still: 0 },
  drag: { frames: 8, box: [23, 12, 26, 22], still: 0 },
};

const DEEPY_SHEETS: Record<string, MascotSheet> = {
  idle: { frames: 48, box: [12, 26, 36, 24], still: 0 },
  "idle-look": { frames: 68, box: [11, 11, 37, 39], still: 0 },
  "idle-spout": { frames: 64, box: [8, 17, 39, 33], still: 0 },
  thinking: { frames: 48, box: [0, 6, 47, 44], still: 20 },
  typing: { frames: 48, box: [0, 17, 52, 33], still: 16 },
  music: { frames: 32, box: [2, 10, 48, 40], still: 0 },
  conducting: { frames: 48, box: [1, 0, 51, 50], still: 6 },
  building: { frames: 48, box: [2, 0, 50, 50], still: 0 },
  error: { frames: 48, box: [4, 17, 45, 33], still: 24 },
  happy: { frames: 52, box: [0, 5, 52, 45], still: 44 },
  notification: { frames: 32, box: [3, 7, 47, 43], still: 12 },
  compacting: { frames: 56, box: [2, 14, 46, 36], still: 20 },
  sleeping: { frames: 64, box: [2, 2, 44, 48], still: 10 },
  waking: { frames: 30, box: [8, 4, 44, 46], still: 29 },
  "poke-left": { frames: 40, box: [1, 16, 50, 34], still: 0 },
  "poke-right": { frames: 40, box: [8, 16, 44, 34], still: 0 },
  tickle: { frames: 48, box: [9, 17, 43, 33], still: 0 },
  drag: { frames: 24, box: [10, 4, 41, 46], still: 0 },
};

const WHALE_GIRL_SHEETS: Record<string, MascotSheet> = {
  idle: {
    frames: 21,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 21,
    durs: [700, 280, 280, 240, 360, 60, 90, 60, 650, 280, 280, 240, 420, 60, 80, 60, 140, 60, 80, 60, 800],
  },
  "idle-look": {
    frames: 13,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 13,
    durs: [500, 420, 70, 80, 70, 380, 420, 110, 420, 140, 140, 140, 400],
  },
  "idle-spout": {
    frames: 11,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 11,
    durs: [450, 260, 110, 110, 130, 150, 170, 170, 170, 350, 400],
  },
  thinking: {
    frames: 17,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 17,
    durs: [220, 220, 260, 260, 260, 300, 170, 170, 170, 170, 170, 170, 90, 110, 200, 200, 260],
  },
  typing: {
    frames: 14,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 14,
    durs: [150, 170, 150, 170, 150, 170, 210, 150, 170, 150, 170, 150, 170, 210],
  },
  music: { frames: 8, box: [0, 0, 69, 66], still: 0, columns: 8, durs: [150, 150, 150, 150, 150, 150, 150, 150] },
  conducting: {
    frames: 12,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 12,
    durs: [150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150],
  },
  building: {
    frames: 24,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 24,
    durs: [
      130, 100, 80, 90, 100, 120, 90, 130, 130, 100, 80, 90, 100, 120, 90, 130, 130, 100, 80, 90, 100, 120, 90, 130,
    ],
  },
  error: {
    frames: 10,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 10,
    durs: [90, 80, 80, 80, 90, 200, 200, 160, 200, 300],
  },
  happy: {
    frames: 11,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 11,
    durs: [200, 90, 90, 100, 100, 100, 100, 110, 110, 120, 400],
  },
  notification: {
    frames: 8,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 8,
    durs: [110, 110, 110, 110, 110, 110, 110, 110],
  },
  compacting: {
    frames: 10,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 10,
    durs: [300, 130, 130, 130, 130, 200, 100, 160, 220, 240],
  },
  sleeping: { frames: 6, box: [0, 0, 69, 66], still: 0, columns: 6, durs: [330, 330, 330, 330, 330, 330] },
  waking: {
    frames: 11,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 11,
    durs: [420, 110, 120, 100, 100, 110, 200, 70, 80, 70, 500],
  },
  "poke-left": {
    frames: 11,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 11,
    durs: [300, 110, 90, 90, 200, 140, 140, 240, 200, 200, 400],
  },
  "poke-right": {
    frames: 11,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 11,
    durs: [300, 110, 90, 90, 200, 140, 140, 240, 200, 200, 400],
  },
  tickle: {
    frames: 14,
    box: [0, 0, 69, 66],
    still: 0,
    columns: 14,
    durs: [90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 200, 400],
  },
  drag: { frames: 10, box: [0, 0, 69, 66], still: 0, columns: 10, durs: [90, 90, 90, 90, 90, 90, 90, 90, 90, 90] },
};

const RUNNING_CYCLE: readonly MascotAnimKey[] = ["thinking", "typing", "conducting", "building"];

function OmpPiSvg({ status, poked }: { status: TaskStatus; poked: boolean }) {
  const active = status === "running" || status === "starting" || status === "needs_you" || poked;
  const error = status === "error";
  return (
    <svg className="composer-crab-svg" width="48" height="34" viewBox="0 0 24 17" shapeRendering="crispEdges">
      {active && (
        <g className="mascot-spout">
          <rect x="11" y="0" width="2" height="2" fill="#22D3EE" />
          <rect x="5" y="1" width="1" height="1" fill="#F472B6" />
          <rect x="18" y="1" width="1" height="1" fill="#A78BFA" />
        </g>
      )}
      <rect x="2" y="3" width="20" height="2" fill="#6366F1" />
      <rect x="1" y="5" width="22" height="3" fill="#8B5CF6" />
      <rect x="19" y="3" width="3" height="5" fill="#7C3AED" />
      <rect x="5" y="8" width="5" height="6" fill="#EC4899" />
      <rect x="14" y="8" width="5" height="6" fill="#06B6D4" />
      <rect x="5" y="5" width="14" height="4" fill="#312E81" />
      {error ? (
        <path d="M7 6h1v1H7zM9 6h1v1H9zM8 7h1v1H8zM14 6h1v1h-1zM16 6h1v1h-1zM15 7h1v1h-1z" fill="#F43F5E" />
      ) : (
        <>
          <rect x="7" y="6" width="2" height="2" fill="#38BDF8" />
          <rect x="15" y="6" width="2" height="2" fill="#38BDF8" />
        </>
      )}
      <rect x={active ? 3 : 4} y="14" width="4" height="3" fill="#DB2777" />
      <rect x={active ? 17 : 16} y="14" width="4" height="3" fill="#0891B2" />
    </svg>
  );
}

export function ClawdMascot({
  status = "idle",
  characterOverride,
  sessionUsage = null,
}: {
  status?: TaskStatus | undefined;
  characterOverride?: MascotCharacter;
  sessionUsage?: TaskState["sessionUsage"] | undefined;
}) {
  const t = useT();
  const storedCharacter = useShellValue("mascot") ?? "clawd";
  const character = characterOverride ?? storedCharacter;
  const settings = useSettings();
  const reducedMotion = (settings?.reduceMotion ?? false) || systemReducesMotion();

  const rootRef = useRef<HTMLSpanElement | null>(null);
  const ompRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLSpanElement | null>(null);
  const animRef = useRef<Animation | null>(null);
  const clickTimesRef = useRef<number[]>([]);
  const dragStartRef = useRef<{ x: number; y: number; baseX: number; baseY: number; active: boolean } | null>(null);

  const [pointerState, setPointerState] = useState<MascotAnimKey | null>(null);
  const [ambientState, setAmbientState] = useState<MascotAnimKey>("idle");
  const [runningStep, setRunningStep] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [offset, setOffset] = useState<MascotOffset>(readMascotOffset);
  const [narrowGutter, setNarrowGutter] = useState(false);

  // 监测聊天面板与输入框之间的右侧留白宽度：留白充足时锚定在输入框外侧留白区（绝不压正文），过窄时贴外沿
  useEffect(() => {
    const el = rootRef.current ?? ompRef.current;
    const composerEl = el?.closest<HTMLElement>(".composer");
    const panelEl = el?.closest<HTMLElement>(".panel") ?? composerEl?.parentElement?.parentElement ?? null;
    if (!composerEl || !panelEl) return;
    const measure = () => {
      const pRect = panelEl.getBoundingClientRect();
      const cRect = composerEl.getBoundingClientRect();
      const rightSpace = pRect.right - cRect.right;
      // 阈值按角色宽度算（缩放后 clawd 约 79px、whalegirl 约 105px，再加外沿 6px 与一点余量）：
      // 留白刚好够放下整个角色但要贴着正文时，早一步切到 [data-narrow]（贴右外沿），不要等真被裁掉才切
      const narrowThreshold = character === "whalegirl" ? 116 : 90;
      setNarrowGutter(rightSpace < narrowThreshold);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panelEl);
    ro.observe(composerEl);
    return () => ro.disconnect();
  }, [character]);

  // 输入避让与鼠标避让都已移除（2026-11-12）：桌宠不再半透明，保持实心可点。

  // 空闲时周期性触发小动作（左顾右盼、招手/喷水、掏出笔记本电脑打字）
  useEffect(() => {
    if (reducedMotion || status !== "idle" || pointerState !== null || character === "off" || character === "omp") {
      setAmbientState("idle");
      return;
    }
    let subTimer: number | undefined;
    const timer = window.setInterval(() => {
      const r = Math.random();
      if (r < 0.35) {
        setAmbientState("idle-look");
        subTimer = window.setTimeout(() => setAmbientState("idle"), 2400);
      } else if (r < 0.65) {
        setAmbientState(character === "clawd" ? "idle-wave" : "idle-spout");
        subTimer = window.setTimeout(() => setAmbientState("idle"), 1800);
      } else if (r < 0.88 && character === "clawd") {
        setAmbientState("idle-laptop");
        subTimer = window.setTimeout(() => setAmbientState("idle"), 3400);
      }
    }, 7500);
    return () => {
      clearInterval(timer);
      clearTimeout(subTimer);
    };
  }, [reducedMotion, status, pointerState, character]);

  // 任务运行中：在思考（吹泡泡/思考气泡）、打字、指挥、建造之间轮转
  useEffect(() => {
    if (status !== "running") {
      setRunningStep(0);
      return;
    }
    const timer = window.setInterval(() => {
      setRunningStep((prev) => (prev + 1) % RUNNING_CYCLE.length);
    }, 4200);
    return () => clearInterval(timer);
  }, [status]);

  const statusKey: MascotAnimKey =
    status === "error"
      ? "error"
      : status === "needs_you"
        ? "notification"
        : status === "starting"
          ? "thinking"
          : status === "running"
            ? (RUNNING_CYCLE[runningStep] ?? "typing")
            : ambientState;

  const effectiveKey: MascotAnimKey = reducedMotion ? "idle" : (pointerState ?? statusKey);

  useEffect(() => {
    const root = rootRef.current;
    const strip = stripRef.current;
    if (!root || !strip || character === "off" || character === "omp") return;

    const sheetTable = character === "clawd" ? CRAB_SHEETS : character === "deepy" ? DEEPY_SHEETS : WHALE_GIRL_SHEETS;
    const sheet = sheetTable[effectiveKey] ?? sheetTable["idle"]!;
    const gutter = character === "whalegirl" ? 0 : 1;
    const baseFrameMs = character === "deepy" ? 50 : character === "clawd" ? 80 : 100;

    const cellW = sheet.box[2] + gutter * 2;
    const cellH = sheet.box[3] + gutter * 2;
    const cols = sheet.columns ?? 8;
    const stripH = cellH * Math.ceil(sheet.frames / cols);

    root.style.setProperty("--mascot-x", String(sheet.box[0]));
    root.style.setProperty("--mascot-y", String(sheet.box[1]));
    root.style.setProperty("--mascot-w", String(sheet.box[2]));
    root.style.setProperty("--mascot-h", String(sheet.box[3]));
    root.style.setProperty("--mascot-cell-w", String(cellW));
    root.style.setProperty("--mascot-columns", String(cols));
    root.style.setProperty("--mascot-strip-h", String(stripH));

    if (character === "clawd") {
      const urls = CRAB_URLS[effectiveKey] ?? CRAB_URLS["idle"]!;
      root.style.setProperty("--mascot-sheet", `url("${sheetUrl(urls.body)}")`);
      root.style.setProperty("--crab-ink", `url("${sheetUrl(urls.ink)}")`);
    } else if (character === "deepy") {
      const url = DEEPY_SHEET_URLS[effectiveKey] ?? DEEPY_SHEET_URLS["idle"]!;
      root.style.setProperty("--mascot-sheet", `url("${sheetUrl(url)}")`);
    } else {
      const url = WHALE_GIRL_SHEET_URLS[effectiveKey] ?? WHALE_GIRL_SHEET_URLS["idle"]!;
      root.style.setProperty("--mascot-sheet", `url("${sheetUrl(url)}")`);
    }

    const frameOffset = (frame: number) =>
      `translate(${-((frame % cols) * cellW + gutter) * 2}px, ${-(Math.floor(frame / cols) * cellH + gutter) * 2}px)`;

    if (animRef.current) {
      animRef.current.cancel();
      animRef.current = null;
    }

    if (reducedMotion) {
      strip.style.transform = frameOffset(sheet.still);
      return;
    }

    strip.style.transform = "";
    const keyframes: Keyframe[] = [];
    let duration = 0;

    if (!sheet.durs) {
      duration = sheet.frames * baseFrameMs;
      for (let f = 0; f < sheet.frames; f++) {
        keyframes.push({
          offset: f / sheet.frames,
          transform: frameOffset(f),
          easing: "steps(1)",
        });
      }
    } else {
      duration = sheet.durs.reduce((s, d) => s + d, 0);
      let at = 0;
      for (let f = 0; f < sheet.frames; f++) {
        keyframes.push({
          offset: at / duration,
          transform: frameOffset(f),
          easing: "steps(1)",
        });
        at += sheet.durs[f]!;
      }
    }

    const isOnce =
      effectiveKey === "poke-left" ||
      effectiveKey === "poke-right" ||
      effectiveKey === "tickle" ||
      effectiveKey === "happy";

    keyframes.push({
      offset: 1,
      transform: frameOffset(isOnce ? sheet.frames - 1 : 0),
    });

    const anim = strip.animate(keyframes, {
      duration,
      iterations: isOnce ? 1 : Infinity,
      fill: "forwards",
    });
    animRef.current = anim;

    if (isOnce) {
      anim.onfinish = () => setPointerState(null);
    }

    return () => {
      anim.cancel();
    };
  }, [character, effectiveKey, reducedMotion]);

  if (character === "off") return null;

  const hasBubble =
    sessionUsage !== null && sessionUsage !== undefined && (sessionUsage.cost > 0 || sessionUsage.tokens.total > 0);
  const bubble = hasBubble ? (
    <span className="composer-mascot-bubble" data-open={hovered ? "" : undefined} aria-hidden="true">
      <span className="composer-mascot-bubble-row">
        <span className="composer-mascot-bubble-label">{t("composer.mascotCost")}</span>
        <span className="composer-mascot-bubble-figure">{formatMoney(sessionUsage.cost)}</span>
      </span>
      <span className="composer-mascot-bubble-row" data-row="sub">
        <span className="composer-mascot-bubble-label">{t("composer.mascotTokens")}</span>
        <span className="composer-mascot-bubble-figure">{formatCount(sessionUsage.tokens.total)}</span>
      </span>
    </span>
  ) : null;

  const isDragging = pointerState === "drag";
  const posStyle = {
    "--mascot-dx": `${offset.x}px`,
    "--mascot-dy": `${offset.y}px`,
  } as CSSProperties;

  const beginDrag = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    dragStartRef.current = { x: e.clientX, y: e.clientY, baseX: offset.x, baseY: offset.y, active: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: PointerEvent<HTMLElement>) => {
    const d = dragStartRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.active && Math.hypot(dx, dy) >= 4) {
      d.active = true;
      setPointerState("drag");
    }
    if (d.active) {
      const next: MascotOffset = {
        x: Math.max(-680, Math.min(420, Math.round(d.baseX + dx))),
        y: Math.max(-540, Math.min(180, Math.round(d.baseY + dy))),
      };
      setOffset(next);
    }
  };

  const endDrag = (e: PointerEvent<HTMLElement>, isOmp = false) => {
    const d = dragStartRef.current;
    dragStartRef.current = null;
    if (d?.active) {
      const next: MascotOffset = {
        x: Math.max(-680, Math.min(420, Math.round(d.baseX + (e.clientX - d.x)))),
        y: Math.max(-540, Math.min(180, Math.round(d.baseY + (e.clientY - d.y)))),
      };
      setOffset(next);
      writeMascotOffset(next);
      setPointerState("happy");
      if (isOmp) window.setTimeout(() => setPointerState(null), 650);
      return;
    }
    if (isOmp) {
      setPointerState("happy");
      window.setTimeout(() => setPointerState(null), 650);
      return;
    }
    const now = performance.now();
    const recent = clickTimesRef.current.filter((item) => now - item < 450);
    recent.push(now);
    clickTimesRef.current = recent;
    if (recent.length >= 4) {
      clickTimesRef.current = [];
      setPointerState("tickle");
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setPointerState(e.clientX - rect.left < rect.width / 2 ? "poke-left" : "poke-right");
  };

  const resetOffsetOnDoubleClick = () => {
    const zero = { x: 0, y: 0 };
    setOffset(zero);
    writeMascotOffset(zero);
  };

  if (character === "omp") {
    return (
      <div
        ref={ompRef}
        className="composer-crab"
        style={posStyle}
        data-character="omp"
        data-narrow={narrowGutter || undefined}
        data-dragging={isDragging || undefined}
        data-state={pointerState ? "waiting" : status}
        aria-hidden="true"
        data-testid="composer-crab"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={(e) => endDrag(e, true)}
        onDoubleClick={resetOffsetOnDoubleClick}
      >
        {bubble}
        <OmpPiSvg status={status} poked={pointerState !== null} />
      </div>
    );
  }

  return (
    <span
      ref={rootRef}
      className={`composer-mascot composer-mascot-${character}`}
      style={posStyle}
      data-character={character}
      data-narrow={narrowGutter || undefined}
      data-dragging={isDragging || undefined}
      data-animation={effectiveKey}
      data-ready=""
      aria-hidden="true"
      data-testid="composer-crab"
    >
      <span className="composer-mascot-sprite">
        <span ref={stripRef} className="composer-mascot-strip" />
      </span>
      <span
        className="composer-mascot-hit"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={(e) => endDrag(e, false)}
        onDoubleClick={resetOffsetOnDoubleClick}
      >
        {bubble}
      </span>
    </span>
  );
}
