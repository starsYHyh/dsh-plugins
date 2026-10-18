# dsh-visualize

Inline HTML visualizations inside the DSH conversation: the assistant writes a
self-contained HTML fragment, the reply carries a content reference, and the web
client renders it in a sandboxed iframe with the current DSH theme.

## 参考来源

设计思路参考了 OpenAI Codex 内置的 `visualize` skill：由 skill 描述工作流与输出契约，客户端把 HTML 片段渲染成对话内联画布。

本插件的 skill 文案、Host/Client 实现、样式与测试均为重新编写，不包含 Codex 的源码或资源；代码以 MIT 授权。
## Layout

    lib/index.js      host half: /dsh-visualize/view route, theme injection, CSP
    lib/client.js     client half: content-reference scan, iframe viewer, copy menu
    lib/contrast.js   primary-button contrast fallback
    lib/runtime.css   static wrapper styles (read per request)
    skill/SKILL.md    visualize skill (install to ~/.dsh/skills/visualize/)
    examples/         demo and button fragments
    test/             regression tests + GUI-free harness

## Source location

This plugin lives in the dsh-plugins repository:

    ~/.dsh/dsh-plugins/plugins/dsh-visualize          <- checkout
    ~/.dsh/profiles/desktop/plugins/dsh-visualize     -> symlink or copy

## Install

See the repository README (安装 dsh-visualize). Short version:

1. Copy or symlink this directory into ~/.dsh/profiles/<profile>/plugins/dsh-visualize.
2. Copy skill/SKILL.md to ~/.dsh/skills/visualize/SKILL.md.
3. Add the loader row to the profile's cordis.patch.yml:

       - insert:
           - id: dsh-visualize
             name: ./plugins/dsh-visualize/lib/index.js

4. Restart the desktop app. Host-half changes need a restart; runtime.css edits
   apply to the next rendered viewer without one.

## Configuration

    - id: dsh-visualize
      name: ./plugins/dsh-visualize/lib/index.js
      config:
        enabled: true          # false disables the route and the prompt section
        announceToAgent: true  # false hides the system-prompt announcement

## Security

- The route answers loopback requests only.
- Only regular .html / .htm files under the home directory or the system
  temporary directory are readable, capped at 1 MB.
- Theme values are sanitized before they reach CSS.
- The fragment runs in an opaque-origin iframe (sandbox="allow-scripts") with a
  restrictive CSP: no connect-src, no frames, no objects; scripts and styles are
  inline or from a small CDN allowlist.
- The fragment cannot reach the host page, its storage, or the DSH APIs.

## Layout

The wrapper centers block-level content by default (auto inline margins), so a
fragment with a max-width column sits in the middle of the canvas while
full-width content is unaffected.

## Theme pairing

Primary buttons pair a fill with the host's on-brand label instead of assuming
white text:

- fill: --dsw-alias-button-primary-fill (falls back to brand-primary)
- text: --dsw-alias-label-primary-inverted
- fallback: when a host does not provide the inverted token, the wrapper picks
  black or white text from the fill's WCAG luminance, so a near-white brand
  color can never receive white text.

## Self test

Open the GUI with the query parameter:

    http://127.0.0.1:<port>/?dshVisualizeSelftest=/absolute/path/to/examples/demo.html

A status badge reports "iframe loaded" and then the measured height.

## Tests

    node test/contrast.test.mjs
    node test/wrapper-contrast.test.mjs
    HARNESS_FRAGMENT=/absolute/path/to/fragment.html node test/harness.mjs

## Contract

- Fragment only: no doctype, html, head, or body elements.
- Self-contained; no fetch/XHR/WebSocket.
- Theme variables: --background, --foreground, --muted, --muted-foreground,
  --card, --border, --primary, --primary-foreground, --link, --code-bg,
  --radius.
- The viewer grows with its content; no fixed or viewport-sized layouts.
