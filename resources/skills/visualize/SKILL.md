---
name: visualize
description: "Create interactive inline visualizations and explorable diagrams directly in conversation (e.g. draggable tangent points, sliders, simulations, math/algorithm intuition, comparisons). Use when visual exploration or adjustable controls clarify how something works."
---

# Visualize (Inline Interactive Gen UI)

Use interactive inline visuals proactively when the user asks to understand how something works, explore "what happens when", inspect math/geometry/algorithms with adjustable parameters, or compare dynamic behaviors.

## When to use which format

- **Markdown table**: plain tabular comparison or data lookup.
- **Mermaid (`mermaid` fence)**: static node-edge flows, architecture, state machines, sequence diagrams.
- **Interactive Gen UI (`::visualize`)**: geometry with draggable points/lines, sliders, steppers, dynamic simulations, interactive charts, or UI prototypes.
- **Static SVG (`svg` fence)**: simple non-interactive diagrams only — keep background `transparent`, never wrap in `#ffffff`/`#f8fafc` boxes, and use `currentColor` for labels/axes where possible.

## How to emit an interactive visual

1. Write a clean, self-contained HTML fragment file (ASCII lowercase hyphenated filename, e.g. `mean-value-theorem.html`) using the `write` tool into the inline visualizations directory given in the system context (do not pollute the user's git project directory unless requested).
2. In your final Markdown response, place the directive on its **own line** (no backticks, no code fence, no extra markdown link):
   `::visualize{"path":"mean-value-theorem.html","title":"Mean Value Theorem"}`
   (You may pass either the filename inside the visualizations directory or its absolute path; add `"mode":"wide"` only when multi-panel comparison genuinely needs full width.)
3. Keep prose outside the visual concise. Do **not** repeat big explanatory paragraphs, full proofs, or redundant headings inside the HTML.

## Design & theme rules (seamless native look)

The host embeds your visual **chromeless and transparent** directly inside the chat stream, and automatically injects theme-synced CSS variables and base utility classes (`.btn`, `.btn-primary`, `.btn-sm`, `.form-range`, `.form-control`, `.form-select`, `.card`, `.viz-controls`, `.viz-row`, `.viz-grid`, `.viz-stat`, `.viz-badge`, `.tabular-nums`, `.text-muted`, `.text-small`).

- **Transparent top-level surface**: Never set `background: #ffffff`, `#f8fafc`, or dark fixed backgrounds on `body` or root wrappers. Leave the outer canvas transparent so it blends seamlessly with every light/dark/tinted theme.
- **No unnecessary outer card**: Plot graphs, SVG diagrams, and interactive controls directly on the transparent surface without wrapping the entire visual in an extra bordered box. Reserve `.card` only for small numeric readout pills/stats when helpful.
- **Theme-aware colors only**: Use CSS variables everywhere (including inside SVG `fill`/`stroke`):
  - Text: `var(--foreground)` (primary), `var(--muted-foreground)` (secondary labels/ticks)
  - Hairlines & grids: `var(--border)`
  - Surfaces & controls: `var(--card)`, `var(--muted)`, `var(--primary)`, `var(--primary-foreground)`, `var(--accent)`
  - Series palette: `var(--viz-series-1)` through `var(--viz-series-6)` (plus semantic `var(--blue)`, `var(--green)`, `var(--orange)`, `var(--red)`, `var(--purple)`)
- **Responsive sizing**: Let SVG scale cleanly (`width: 100%; height: auto; display: block` with a clear `viewBox`). Do not use `100vh`, `position: fixed`, or fixed pixel heights that cause internal scrollbars. The host resizes height automatically to fit your content.
- **Direct manipulation**: Prefer dragging points directly on SVG/Canvas (`pointerdown`/`pointermove`/`pointerup` with `setPointerCapture`) paired with compact sliders/presets and live tabular numbers (`.tabular-nums`).

## Host bridge (`window.piStudio`)

- `window.piStudio.widgetState` / `window.piStudio.setWidgetState({ modelContent, privateContent })`: persist lightweight view state across the session.
- `window.piStudio.sendFollowUp({ prompt })`: ask a follow-up question carrying current `modelContent` (gated by user confirmation in the host).
- `window.piStudio.quoteToComposer(text)`: insert a result snippet into the user's composer.
- Avoid network `fetch`/XHR/WebSocket calls (blocked by sandbox CSP).
