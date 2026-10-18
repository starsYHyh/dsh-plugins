---
name: visualize
description: Create an interactive HTML visualization that renders inline in the conversation. Use when the user needs to see, explore, compare, or simulate something and a visual explains it better than prose or a plain table. Not for standalone files, websites, or project deliverables.
---

# Visualize (inline)

An inline visualization is one self-contained HTML fragment rendered inside a sandboxed iframe in the conversation. The drawing is plain HTML/CSS/JS (or SVG/canvas); this skill defines the workflow and the output contract.

## When to use

Use it when the user needs to **see or explore** something in the conversation:

- compare quantities, trends, distributions, or a timeline;
- explain how something works (process, state machine, layout, data flow);
- simulate a parameter change ("what happens if…") with controls;
- preview or tune a small UI idea (component, dialog, mobile screen).

Do **not** use it when:

- the user wants a table → answer with a Markdown table;
- a static labeled structure is enough → use a Mermaid code block;
- the user asks for a file, website, app page, or project change → build the real artifact instead;
- a short paragraph explains it already.

## Workflow

1. Choose a short ASCII slug, e.g. `latency-budget`.
2. Write the fragment to a file under the workspace:
   `<workspace>/visualizations/<slug>.html`. Create the directory if needed.
3. Keep the fragment under 1 MB and self-contained (see rules below).
4. In the **final** response, put the content reference on its own line, exactly:

   ```text
   visualize{"path":"<absolute path>"}
   ```

   Example: ```text
   visualize{"path":"/Users/me/project/visualizations/latency-budget.html"}
   ```

5. Optionally add one short sentence before or after the reference. Do not describe HTML, iframes, files, or this skill.

The path must be absolute and end in `.html`. One reference per visualization; emit it once, in the final response only.

## Fragment rules

- **Fragment only** — no `<!doctype>`, `<html>`, `<head>`, or `<body>`. The host supplies the document shell.
- **Self-contained** — inline all CSS and JS. No `fetch`, XHR, WebSocket, or external API calls; the CSP blocks them.
- **External resources** — allowed only from `cdn.jsdelivr.net`, `unpkg.com`, `esm.sh`, `cdnjs.cloudflare.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, `fonts.bunny.net`. Images: inline SVG, `data:` URIs, or HTTPS URLs. Prefer no dependencies.
- **Theme-aware** — use the CSS variables below; never hardcode white/black palettes. The host sets `color-scheme` and passes the current values.
- **Size** — design for widths from 320px to ~900px; the viewer is full message width. Avoid fixed outer widths and internal scroll areas.
- **JS** — plain scripts are allowed (they run sandboxed). Guard optional APIs. Do not navigate the top page or open pop-ups.

## Theme variables

Surfaces and text:

`text
--background        page surface (usually transparent — keep it)
--foreground        primary text
--muted             subtle surface fill
--muted-foreground  secondary text
--card              raised surface
--card-foreground   text on --card
--border            hairlines
--primary           accent fill (buttons/active)
--primary-foreground text on --primary
--link              link color
--code-bg           inline/pre code background
--radius            corner radius (default 10px)
`

Utility classes available: `.card`, `.btn`, `.btn-primary`, `.table` (with `.table th`/`.table td`), `.text-muted`, `.text-small`, `.text-error`, `.viz-grid`, `.viz-stat`, `.viz-stat-value`, `.sr-only`, `hr`, `code`, `pre`. Prefer these over custom chrome; add custom CSS only for the visual itself.

## Design guidance

- Smallest composition that answers the question: one chart, one diagram, one panel. No decorative cards or filler stat rows.
- Label axes and important values directly; add a legend only when several series cannot be labeled inline.
- Pair color with text or shape so meaning never depends on color alone.
- Semantic HTML, native `button`/`input` controls, visible labels; decorative icons are `aria-hidden`.
- Animate transitions only when they add meaning; honor `prefers-reduced-motion`.
- The iframe height follows its content automatically; do not set `position: fixed` or `100vh` layouts.

## Minimal example

`html
<div class="card">
  <h3>请求延迟分布</h3>
  <svg viewBox="0 0 320 120" role="img" aria-label="延迟分桶柱状图">
    <g fill="var(--primary)">
      <rect x="8"   y="52" width="36" height="60" rx="4"></rect>
      <rect x="56"  y="24" width="36" height="88" rx="4"></rect>
      <rect x="104" y="64" width="36" height="48" rx="4"></rect>
      <rect x="152" y="88" width="36" height="24" rx="4"></rect>
    </g>
    <g fill="var(--muted-foreground)" font-size="11">
      <text x="26"  y="114" text-anchor="middle">p50</text>
      <text x="74"  y="114" text-anchor="middle">p90</text>
      <text x="122" y="114" text-anchor="middle">p99</text>
      <text x="170" y="114" text-anchor="middle">&gt;p99</text>
    </g>
  </svg>
  <p class="text-small text-muted">单位：毫秒；数据来自最近 24 小时。</p>
</div>
`

## Failure handling

If the fragment cannot be written (permission, path), say so plainly and fall back to a Markdown table or prose. Never emit a content reference to a file you did not write.
