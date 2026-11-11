// 思考强度滑块弹层（复刻 DSH effort-picker）：
// 顶部显示「思考强度 + 当前档位名」，下方「更快 ↔ 更强」刻度轴，中间是 26px 圆角凹槽与 16×30px 白色圆润拨片。
// 指针按下平滑阻尼跟随（detent 曲线），松手落入最近档位；滑至最高档（data-apex）时切换为 5 行像素点阵微光流画布。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { MessageKey } from "../../../../shared/i18n/index.ts";
import type { ThinkingLevel } from "../../../../shared/omp-wire/rpc-wire.generated.ts";
import { useT } from "../../i18n/use-t.ts";
import { useSettings } from "../../store/settings-store.ts";
import { Popover } from "../../ui/Popover.tsx";
import { onThemeChange } from "../../ui/theme-change.ts";
import { systemReducesMotion } from "../settings/motion-preference.ts";
import { thinkingLabel } from "./thinking-levels.ts";

const KNOB_W = 16;
const BAND_H = 26;
const FIELD_ROWS = 5;
const DETENT = 0.8;
const DRAG_THRESHOLD_PX = 3;
const FLASH_S = 2.4;
const FLOW_S = 3.2;
const SURFACE_S = 0.24;
const FLOW_CLUSTERS = 9;
const FLOW_ROW_SHIFT = 0.03;
const FLOW_JITTER = 0.05;
const PEAK_APEX_SHARE = 62;
const PEAK_SHARE_SPREAD = 22;
const GLOW_PEAK = 0.9;
const FLOW_PEAK = 0.95;

type Channels = [number, number, number];

interface FieldBlock {
  x: number;
  y: number;
  size: number;
  peak: number;
  flashDelay: number;
  flashDur: number;
  entrance: number;
  flowOffset: number;
  flowStrength: number;
  fade: number;
}

interface FieldGrid {
  widthDev: number;
  heightDev: number;
  dpr: number;
  blocks: FieldBlock[];
}

function cellUnit(r: number, c: number, seed: number): number {
  let h = Math.imul(r + 1, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca6b) ^ Math.imul(seed + 1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function easeStandard(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return 1 - Math.pow(1 - c, 3);
}

function easeInOut(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

function flowStrength(r: number, c: number, fx: number): number {
  const cluster = Math.min(FLOW_CLUSTERS - 1, Math.floor(fx * FLOW_CLUSTERS));
  const coarse = cellUnit(cluster, r, 6);
  const fine = cellUnit(r, c, 7);
  const gate = coarse * 0.4 + fine * 0.6;
  return 0.04 + smoothstep(0.46, 0.58, gate) * 0.92;
}

function cellFade(fx: number): number {
  if (fx <= 0.05) return 0;
  if (fx >= 0.75) return 1;
  const t = (fx - 0.05) / 0.7;
  return t * t * (3 - 2 * t);
}

function solveField(wDev: number, dpr: number): FieldGrid {
  const gap = Math.max(1, Math.round(dpr));
  const margin = Math.max(1, Math.round(0.5 * dpr));
  const heightDev = Math.round(BAND_H * dpr);
  const size = Math.max(3, Math.floor((heightDev - 2 * margin - (FIELD_ROWS - 1) * gap) / FIELD_ROWS));
  const cols = Math.max(1, Math.floor((wDev + gap) / (size + gap)));
  const restX = wDev - (cols * size + (cols - 1) * gap);
  const restY = heightDev - (FIELD_ROWS * size + (FIELD_ROWS - 1) * gap);
  const left = Math.floor(restX / 2);
  const top = Math.floor(restY / 2);
  const blocks: FieldBlock[] = [];
  for (let r = 0; r < FIELD_ROWS; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const fx = cols > 1 ? c / (cols - 1) : 1;
      blocks.push({
        x: left + c * (size + gap),
        y: top + r * (size + gap),
        size,
        peak: (100 - (PEAK_APEX_SHARE - cellUnit(r, c, 1) * PEAK_SHARE_SPREAD)) / 100,
        flashDelay: cellUnit(r, c, 2) * FLASH_S * 0.95 + FLASH_S * 0.21,
        flashDur: FLASH_S * (0.92 + cellUnit(r, c, 3) * 0.16),
        entrance: (1 - fx) * FLASH_S * 0.31 + cellUnit(r, c, 4) * FLASH_S * 0.055,
        flowOffset: fx * FLOW_S + r * FLOW_S * FLOW_ROW_SHIFT + cellUnit(r, c, 5) * FLOW_S * FLOW_JITTER,
        flowStrength: flowStrength(r, c, fx),
        fade: cellFade(fx),
      });
    }
  }
  return { widthDev: wDev, heightDev, dpr, blocks };
}

function flashEnvelope(p: number): number {
  if (p < 0.14) return 0;
  if (p < 0.2) return easeInOut((p - 0.14) / 0.06);
  if (p <= 0.34) return 1;
  if (p >= 1) return 0;
  return 1 - easeInOut((p - 0.34) / 0.66);
}

function arrivalGlow(phase: number): number {
  if (phase <= 0 || phase >= 1) return 0;
  if (phase < 0.3) return GLOW_PEAK * easeStandard(phase / 0.3);
  return GLOW_PEAK * (1 - easeStandard((phase - 0.3) / 0.7));
}

function flowEnvelope(p: number, strength: number): number {
  const peak = strength * FLOW_PEAK;
  if (p < 0.03) return peak * (p / 0.03);
  if (p < 0.06) return peak * (1 - (p - 0.03) / 0.03);
  return 0;
}

function parseColorChannels(raw: string, fallback: Channels): Channels {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
    }
  }
  const rgbMatch = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(trimmed);
  if (rgbMatch) {
    return [Math.round(Number(rgbMatch[1])), Math.round(Number(rgbMatch[2])), Math.round(Number(rgbMatch[3]))];
  }
  return fallback;
}

function EffortMatrixCanvas({
  active,
  width,
  reducedMotion,
}: {
  active: boolean;
  width: number;
  reducedMotion: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas || width <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio > 0 ? window.devicePixelRatio : 1, 2);
    const grid = solveField(Math.round(width * dpr), dpr);
    canvas.width = grid.widthDev;
    canvas.height = grid.heightDev;
    canvas.style.width = `${grid.widthDev / dpr}px`;
    canvas.style.height = `${grid.heightDev / dpr}px`;

    let accent: Channels = [217, 119, 87];
    let flash: Channels = [255, 214, 196];
    const readPalette = () => {
      const style = getComputedStyle(document.documentElement);
      accent = parseColorChannels(style.getPropertyValue("--accent"), [217, 119, 87]);
      flash = [
        Math.min(255, Math.round(accent[0] + (255 - accent[0]) * 0.62)),
        Math.min(255, Math.round(accent[1] + (255 - accent[1]) * 0.62)),
        Math.min(255, Math.round(accent[2] + (255 - accent[2]) * 0.62)),
      ];
    };
    readPalette();
    const stopTheme = onThemeChange(readPalette);

    const paintBlock = (block: FieldBlock) => {
      const radius = Math.min(Math.max(1, Math.round(dpr)), block.size / 2);
      ctx.beginPath();
      ctx.roundRect(block.x, block.y, block.size, block.size, radius);
      ctx.fill();
    };

    if (reducedMotion) {
      ctx.clearRect(0, 0, grid.widthDev, grid.heightDev);
      ctx.fillStyle = `rgb(${accent[0]} ${accent[1]} ${accent[2]})`;
      for (const block of grid.blocks) {
        if (block.fade === 0) continue;
        ctx.globalAlpha = block.fade;
        paintBlock(block);
      }
      ctx.globalAlpha = 1;
      return () => stopTheme();
    }

    let raf = 0;
    let enteredAt = 0;
    const shade: Channels = [0, 0, 0];

    const step = (now: number) => {
      if (document.hidden) {
        raf = 0;
        return;
      }
      if (enteredAt === 0) enteredAt = now;
      const t = (now - enteredAt) / 1000;
      ctx.clearRect(0, 0, grid.widthDev, grid.heightDev);
      for (const block of grid.blocks) {
        const phase = (t - block.entrance) / SURFACE_S;
        const rise = phase <= 0 ? 0 : phase >= 1 ? 1 : easeStandard(phase);
        if (rise === 0) continue;
        let fp = ((t - block.flashDelay) / block.flashDur) % 1;
        if (fp < 0) fp += 1;
        const flashShare = block.peak * flashEnvelope(fp);
        let flp = ((t + block.flowOffset) / FLOW_S) % 1;
        if (flp < 0) flp += 1;
        const flow = flowEnvelope(flp, block.flowStrength);
        const glow = arrivalGlow(phase);
        const over = glow + flow - glow * flow;
        for (let ch = 0; ch < 3; ch += 1) {
          const base = accent[ch]!;
          const hi = flash[ch]!;
          const lit = base + (hi - base) * flashShare;
          shade[ch] = lit + (hi - lit) * over;
        }
        ctx.globalAlpha = block.fade * rise;
        ctx.fillStyle = `rgb(${Math.round(shade[0])} ${Math.round(shade[1])} ${Math.round(shade[2])})`;
        paintBlock(block);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(step);
    };

    const onVisibility = () => {
      if (!document.hidden && raf === 0) {
        enteredAt = 0;
        raf = requestAnimationFrame(step);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(step);

    return () => {
      stopTheme();
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
    };
  }, [active, width, reducedMotion]);

  return <canvas ref={canvasRef} className="effort-pop-matrix-canvas" aria-hidden="true" />;
}

function dampTravel(x: number, count: number, span: number): number {
  if (count < 2 || span <= 0) return x;
  const seg = span / (count - 1);
  const index = Math.floor(x / seg);
  if (index >= count - 1) return x;
  const t = (x - index * seg) / seg;
  return (index + t - (DETENT * Math.sin(2 * Math.PI * t)) / (2 * Math.PI)) * seg;
}

function nearestIndex(x: number, count: number, span: number): number {
  if (count <= 1 || span <= 0) return 0;
  const ratio = x / span;
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
}

export function EffortPopover({
  open,
  onClose,
  levels,
  value,
  onSelect,
}: {
  open: boolean;
  onClose(): void;
  levels: readonly ThinkingLevel[];
  value: ThinkingLevel | null;
  onSelect(level: ThinkingLevel): void;
}) {
  const t = useT();
  const settings = useSettings();
  const reducedMotion = (settings?.reduceMotion ?? false) || systemReducesMotion();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackWidth, setTrackWidth] = useState(252);
  const [pressed, setPressed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [liveTravel, setLiveTravel] = useState<number | null>(null);
  const [liveIndex, setLiveIndex] = useState<number | null>(null);
  const downXRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!open || !el) return;
    const measure = () => {
      if (el.clientWidth > 0) setTrackWidth(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  const selectedIndex = Math.max(0, value === null ? 0 : levels.indexOf(value));
  const activeIndex = pressed && liveIndex !== null ? liveIndex : selectedIndex;
  const activeLevel = levels[activeIndex] ?? value ?? null;
  const activeText =
    activeLevel !== null && thinkingLabel[activeLevel] ? t(thinkingLabel[activeLevel] as MessageKey) : "";
  const isApex = levels.length > 1 && activeIndex === levels.length - 1;
  const span = Math.max(0, trackWidth - KNOB_W);
  const stopX = (idx: number) => (levels.length < 2 ? span : (idx / (levels.length - 1)) * span);
  const travelPx = pressed && liveTravel !== null ? liveTravel : stopX(selectedIndex);

  const pointerToRaw = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const zoom = rect.width > 0 && el.clientWidth > 0 ? rect.width / el.clientWidth : 1;
      const localX = (clientX - rect.left) / zoom - KNOB_W / 2;
      return Math.max(0, Math.min(span, localX));
    },
    [span],
  );

  const finishGesture = (commitIdx: number | null) => {
    setPressed(false);
    setDragging(false);
    setLiveTravel(null);
    setLiveIndex(null);
    pointerIdRef.current = null;
    if (commitIdx !== null) {
      const chosen = levels[commitIdx];
      if (chosen !== undefined && chosen !== value) onSelect(chosen);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || levels.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    pointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    downXRef.current = e.clientX;
    const raw = pointerToRaw(e.clientX);
    setPressed(true);
    setDragging(false);
    setLiveTravel(dampTravel(raw, levels.length, span));
    setLiveIndex(nearestIndex(raw, levels.length, span));
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pressed || pointerIdRef.current !== e.pointerId) return;
    if (!dragging && Math.abs(e.clientX - downXRef.current) >= DRAG_THRESHOLD_PX) {
      setDragging(true);
    }
    const raw = pointerToRaw(e.clientX);
    setLiveTravel(dampTravel(raw, levels.length, span));
    setLiveIndex(nearestIndex(raw, levels.length, span));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!pressed || pointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const raw = pointerToRaw(e.clientX);
    finishGesture(nearestIndex(raw, levels.length, span));
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (!pressed || pointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    finishGesture(liveIndex);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (levels.length === 0) return;
    let next = selectedIndex;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, selectedIndex - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(levels.length - 1, selectedIndex + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = levels.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const chosen = levels[next];
    if (chosen !== undefined && chosen !== value) onSelect(chosen);
  };

  return (
    <Popover open={open} onClose={onClose} width={284} align="start" label={t("composer.effortTitle")}>
      <div
        className="effort-pop"
        data-testid="effort-popover"
        data-apex={isApex || undefined}
        data-dragging={dragging || undefined}
        data-level={activeLevel ?? undefined}
      >
        <div className="effort-pop-head">
          <span className="effort-pop-label">{t("composer.effortTitle")}</span>
          <span className="effort-pop-value" data-testid="effort-popover-value">
            {activeText}
          </span>
        </div>
        <div className="effort-pop-steps" role="radiogroup" aria-label={t("composer.effortTitle")}>
          {levels.map((lvl) => {
            const label = thinkingLabel[lvl] ? t(thinkingLabel[lvl] as MessageKey) : lvl;
            const selected = lvl === activeLevel;
            return (
              <button
                key={lvl}
                type="button"
                role="radio"
                aria-checked={selected}
                className="effort-pop-step"
                data-selected={selected || undefined}
                data-testid={`effort-step-${lvl}`}
                onClick={() => {
                  onSelect(lvl);
                  onClose();
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="effort-pop-ends" aria-hidden="true">
          <span>{t("composer.effortFaster")}</span>
          <span>{t("composer.effortSmarter")}</span>
        </div>
        <div
          ref={trackRef}
          className="effort-pop-track"
          role="slider"
          tabIndex={0}
          aria-label={t("composer.effortTitle")}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, levels.length - 1)}
          aria-valuenow={activeIndex}
          aria-valuetext={activeText}
          data-testid="effort-slider"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
        >
          <div className="effort-pop-fill" style={{ width: `${Math.round(travelPx) + KNOB_W / 2}px` }} />
          <div className="effort-pop-ticks" aria-hidden="true">
            {levels.map((lvl, idx) => (
              <span
                key={lvl}
                className="effort-pop-tick"
                style={{ left: `${Math.round(stopX(idx) + KNOB_W / 2)}px` }}
              />
            ))}
          </div>
          <div className="effort-pop-matrix" aria-hidden="true">
            <EffortMatrixCanvas active={open && isApex} width={trackWidth} reducedMotion={reducedMotion} />
          </div>
          <div className="effort-pop-knob" style={{ translate: `${Math.round(travelPx)}px 0` }} />
        </div>
      </div>
    </Popover>
  );
}
