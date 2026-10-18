/**
 * dsh-visualize — host half.
 *
 * Serves an HTML visualization fragment as a self-contained, sandboxed
 * document for the client half, which embeds it inline in the conversation.
 *
 * Route: GET /dsh-visualize/view?path=<absolute .html>&id=<viewer>&scheme=<light|dark>&vars=<base64 JSON>
 *
 * Security: loopback-only, regular .html files only, 1 MB cap, theme values
 * sanitized before they reach CSS, fragment runs in an opaque-origin iframe
 * with a restrictive CSP.
 */
import { lstat, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickForeground } from './contrast.js'

/** Static wrapper styles shipped beside this module (read per request). */
const RUNTIME_CSS_PATH = fileURLToPath(new URL('./runtime.css', import.meta.url))

/** Text and mtime of the last runtime.css read. */
let runtimeCssCache = { text: '', mtimeMs: -1 }

export const name = 'dsh-visualize'

/** Services this plugin needs from the host composition. */
export const inject = ['webServer', 'systemPrompt']

/** Exact route the client half loads each viewer from. */
const ROUTE = '/dsh-visualize/view'

/** Hard cap for one fragment, matching the inline-visualization contract. */
const MAX_FRAGMENT_BYTES = 1000000

/** Cap for the base64 theme payload, so a crafted URL cannot bloat a response. */
const MAX_VARS_BYTES = 32768

/** Fragment suffixes accepted by the route. */
const ALLOWED_EXTENSIONS = new Set(['.html', '.htm'])

/** System-prompt announcement: capability, contract, and the content reference. */
export const GUIDANCE = [
  '本机已安装 dsh-visualize 插件：它把对话里的 HTML 可视化片段原位渲染成内联画布（sandbox iframe，跟随界面明暗主题，自动适配高度）。',
  '当用户想“看到 / 探索 / 对比 / 模拟”某个东西，且内联可视化比纯文字或表格更清楚时：先用 skill 工具加载 visualize skill，按它的规范把一个 HTML 片段写到工作区文件，然后在最终回复里单独用一行输出内容引用：',
  '\uE200visualize\uE202{"path":"<片段文件的绝对路径>"}\uE201',
  '规则：内容引用只出现在最终回复里（一次即可）；正文不要解释 HTML/iframe/实现细节；用户明确只要文字、表格或静态结构时不要使用；片段必须自包含，不要 fetch 外部接口。',
].join('\n')

/** Accept only requests addressed to this machine's loopback listener. */
function isTrustedLoopback(request) {
  const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : ''
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')
}

/** True when a resolved absolute path stays inside one of the readable roots. */
function isAllowedPath(absolutePath) {
  const roots = [homedir(), tmpdir()]
  return roots.some((root) => {
    const normalized = root.endsWith(sep) ? root : root + sep
    return absolutePath === root || absolutePath.startsWith(normalized)
  })
}

/** Escape text for HTML text and attribute positions. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Strip CSS-breaking characters from a computed theme value. */
function sanitizeCssValue(value) {
  return String(value)
    .replace(/[;{}<>\\]/g, '')
    .trim()
    .slice(0, 300)
}

/** Decode the base64 theme payload into a validated CSS custom-property map. */
function parseThemeVars(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  if (raw.length > MAX_VARS_BYTES) throw new Error('theme payload exceeds limit')
  let decoded
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    throw new Error('theme payload is not valid base64')
  }
  let parsed
  try {
    parsed = JSON.parse(decoded)
  } catch {
    throw new Error('theme payload is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('theme payload must be an object')
  }
  const vars = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^--[A-Za-z0-9-]+$/.test(key)) continue
    if (typeof value !== 'string' || value.length === 0) continue
    vars[key] = sanitizeCssValue(value)
  }
  return vars
}

/** Base runtime styles: theme aliases plus a small, dependency-free utility set. */
function runtimeCss(scheme, vars) {
  const dark = scheme === 'dark'
  // Pair the primary fill with the host's on-brand label; when a host does not
  // provide that token, derive a safe foreground from the fill's luminance so a
  // near-white brand color never receives white text.
  const brandFill =
    vars['--dsw-alias-button-primary-fill'] ||
    vars['--dsw-alias-brand-primary'] ||
    (dark ? '#f9fafb' : '#0f1115')
  const primaryForeground = pickForeground(brandFill) || '#ffffff'
  const themeEntries = Object.entries(vars)
    .map(([key, value]) => '  ' + key + ': ' + value + ';')
    .join('\n')
  return [
    ':root {',
    '  color-scheme: ' + (dark ? 'dark' : 'light') + ';',
    themeEntries,
    '  --background: var(--dsw-alias-bg-base, ' + (dark ? '#151517' : '#ffffff') + ');',
    '  --foreground: var(--dsw-alias-label-primary, ' + (dark ? '#f2f3f5' : '#1b1b1c') + ');',
    '  --muted: var(--dsw-alias-bg-layer-2, ' + (dark ? '#1e1f22' : '#f4f5f7') + ');',
    '  --muted-foreground: var(--dsw-alias-label-secondary, ' + (dark ? '#a9adb3' : '#5d6268') + ');',
    '  --border: var(--dsw-alias-border-l2, ' + (dark ? '#2e3034' : '#e3e4e6') + ');',
    '  --card: var(--dsw-alias-bg-layer-3, ' + (dark ? '#1b1c1e' : '#ffffff') + ');',
    '  --card-foreground: var(--dsw-alias-label-primary, ' + (dark ? '#f2f3f5' : '#1b1b1c') + ');',
    '  --primary: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7));',
    '  --primary-foreground: var(--dsw-alias-label-primary-inverted, ' + primaryForeground + ');',
    '  --link: var(--dsw-alias-link, ' + (dark ? '#7aa2ff' : '#2f6fed') + ');',
    '  --code-bg: var(--dsw-alias-markdown-code-block, ' + (dark ? '#1e1f22' : '#f4f5f7') + ');',
    '  --radius: 10px;',
    '  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;',
    '}',
  ].filter((line) => line !== '').join('\n')
}

/**
 * Read the static wrapper stylesheet. Cached until mtime changes, so style
 * edits reach the next rendered viewer without restarting the host.
 */
async function loadRuntimeCss() {
  try {
    const stats = await lstat(RUNTIME_CSS_PATH)
    if (runtimeCssCache.text !== '' && stats.mtimeMs === runtimeCssCache.mtimeMs) {
      return runtimeCssCache.text
    }
    const text = await readFile(RUNTIME_CSS_PATH, 'utf8')
    runtimeCssCache = { text, mtimeMs: stats.mtimeMs }
    return text
  } catch {
    return ''
  }
}

/** Restrictive CSP for the fragment document; keep in sync with the skill. */
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://fonts.bunny.net",
  'img-src data: blob: https:',
  'font-src data: https://fonts.gstatic.com https://fonts.bunny.net',
  'media-src data: blob: https:',
  'worker-src blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** Height bridge: post the content height to the embedding page. */
function heightBridgeScript(viewerId) {
  const idLiteral = JSON.stringify(viewerId).replaceAll('<', '\\u003c')
  return [
    '<script>',
    '(function () {',
    '  var viewerId = ' + idLiteral + ';',
    '  function post() {',
    '    try {',
    '      var height = Math.max(',
    '        document.body ? document.body.scrollHeight : 0,',
    '        document.documentElement ? document.documentElement.scrollHeight : 0',
    '      );',
    "      parent.postMessage({ type: 'dsh-visualize:height', id: viewerId, height: height }, '*');",
    '    } catch (error) {',
    '      /* the embedding page may already be gone */',
    '    }',
    '  }',
    "  if (typeof ResizeObserver !== 'undefined') {",
    '    new ResizeObserver(post).observe(document.documentElement);',
    '  }',
    "  window.addEventListener('load', post);",
    "  window.addEventListener('error', post);",
    '  setTimeout(post, 0);',
    '  setTimeout(post, 60);',
    '  setTimeout(post, 400);',
    '})();',
    '</script>',
  ].join('\n')
}

/** Export bridge: render this document to a PNG and reply to the parent. */
function exportBridgeScript() {
  return [
    '<script>',
    '(function () {',
    '  function currentBackground() {',
    "    var style = getComputedStyle(document.documentElement);",
    "    var value = style.getPropertyValue('--dsw-alias-bg-base').trim();",
    "    if (!value) value = style.getPropertyValue('--background').trim();",
    "    if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') {",
    "      value = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#151517' : '#ffffff';",
    '    }',
    '    return value;',
    '  }',
    '',
    '  function renderPng() {',
    '    return new Promise(function (resolve, reject) {',
    '      try {',
    '        var width = Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));',
    '        var height = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));',
    '        var clone = document.documentElement.cloneNode(true);',
    "        var scripts = clone.querySelectorAll('script');",
    '        for (var index = 0; index < scripts.length; index++) {',
    '          scripts[index].parentNode.removeChild(scripts[index]);',
    '        }',
    "        var html = new XMLSerializer().serializeToString(clone);",
    "        var svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"' + width + '\" height=\"' + height + '\">' +",
    "          '<foreignObject width=\"100%\" height=\"100%\">' + html + '</foreignObject></svg>';",
    "        var image = new Image();",
    "        image.onload = function () {",
    '          try {',
    '            var scale = 2;',
    "            var canvas = document.createElement('canvas');",
    '            canvas.width = width * scale;',
    '            canvas.height = height * scale;',
    "            var context = canvas.getContext('2d');",
    "            if (!context) { reject(new Error('2d context unavailable')); return; }",
    '            context.fillStyle = currentBackground();',
    '            context.fillRect(0, 0, canvas.width, canvas.height);',
    '            context.setTransform(scale, 0, 0, scale, 0, 0);',
    '            context.drawImage(image, 0, 0, width, height);',
    "            resolve({ dataUrl: canvas.toDataURL('image/png'), width: width, height: height });",
    '          } catch (error) {',
    '            reject(error);',
    '          }',
    '        };',
    "        image.onerror = function () { reject(new Error('render failed')); };",
    "        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);",
    '      } catch (error) {',
    '        reject(error);',
    '      }',
    '    });',
    '  }',
    '',
    "  window.addEventListener('message', function (event) {",
    '    if (event.source !== window.parent) return;',
    '    var data = event.data;',
    "    if (!data || data.type !== 'dsh-visualize:export') return;",
    '    renderPng().then(function (result) {',
    "      window.parent.postMessage({ type: 'dsh-visualize:export-result', requestId: data.requestId, dataUrl: result.dataUrl, width: result.width, height: result.height }, '*');",
    '    }).catch(function (error) {',
    "      window.parent.postMessage({ type: 'dsh-visualize:export-result', requestId: data.requestId, error: String(error && error.message ? error.message : error) }, '*');",
    '    });',
    '  });',
    '})();',
    '</script>',
  ].join('\n')
}

/** Compose the served document around one fragment. */
function buildDocument(options) {
  const fragment = options.fragment
  const title = options.title
  const viewerId = options.viewerId
  const scheme = options.scheme
  const vars = options.vars
  const staticCss = options.staticCss || ''
  const documentTitle = escapeHtml(title || 'Visualization')
  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-scheme="' + (scheme === 'dark' ? 'dark' : 'light') + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">',
    '<title>' + documentTitle + '</title>',
    '<style>',
    runtimeCss(scheme, vars),
    staticCss,
    '</style>',
    '</head>',
    '<body>',
    fragment,
    heightBridgeScript(viewerId),
    exportBridgeScript(),
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** Write a plain-text error response. */
function sendError(response, status, message) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(message + '\n')
}

/** Handle one viewer request. */
async function handleView(request, response) {
  if (!isTrustedLoopback(request)) {
    sendError(response, 403, 'dsh-visualize: loopback requests only')
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendError(response, 405, 'dsh-visualize: GET or HEAD only')
    return
  }

  let url
  try {
    url = new URL(request.url ?? ROUTE, 'http://127.0.0.1')
  } catch {
    sendError(response, 400, 'dsh-visualize: malformed request URL')
    return
  }

  let absolutePath
  try {
    const rawPath = url.searchParams.get('path')
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      sendError(response, 400, 'dsh-visualize: missing path parameter')
      return
    }
    if (rawPath.includes('\u0000')) {
      sendError(response, 400, 'dsh-visualize: invalid path')
      return
    }
    const trimmed = rawPath.trim()
    if (!trimmed.startsWith('/')) {
      sendError(response, 400, 'dsh-visualize: path must be absolute')
      return
    }
    absolutePath = resolve(trimmed)
    if (!ALLOWED_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
      sendError(response, 400, 'dsh-visualize: fragment must be a .html file')
      return
    }
    if (!isAllowedPath(absolutePath)) {
      sendError(response, 403, 'dsh-visualize: fragment is outside the readable roots')
      return
    }
  } catch (error) {
    sendError(response, 400, 'dsh-visualize: ' + (error instanceof Error ? error.message : String(error)))
    return
  }

  let stats
  try {
    stats = await lstat(absolutePath)
  } catch {
    sendError(response, 404, 'dsh-visualize: fragment not found')
    return
  }
  if (!stats.isFile()) {
    sendError(response, 400, 'dsh-visualize: fragment is not a regular file')
    return
  }
  if (stats.size > MAX_FRAGMENT_BYTES) {
    sendError(response, 413, 'dsh-visualize: fragment exceeds the 1 MB limit')
    return
  }

  let fragment
  try {
    fragment = await readFile(absolutePath, 'utf8')
  } catch (error) {
    sendError(response, 500, 'dsh-visualize: cannot read fragment: ' + (error instanceof Error ? error.message : String(error)))
    return
  }

  const scheme = url.searchParams.get('scheme') === 'dark' ? 'dark' : 'light'
  const viewerId = (url.searchParams.get('id') ?? '').slice(0, 64)
  const title = (url.searchParams.get('title') ?? '').slice(0, 200)
  let vars
  try {
    vars = parseThemeVars(url.searchParams.get('vars') ?? '')
  } catch (error) {
    sendError(response, 400, 'dsh-visualize: ' + (error instanceof Error ? error.message : String(error)))
    return
  }

  const staticCss = await loadRuntimeCss()
  const document = buildDocument({ fragment: fragment, title: title, viewerId: viewerId, scheme: scheme, vars: vars, staticCss: staticCss })
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(request.method === 'HEAD' ? undefined : document)
}

/**
 * Mount the plugin.
 * @param ctx - host context; the loader provides systemPrompt and webServer.
 * @param config - optional plugin configuration.
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  if (!enabled) return

  if ((config.announceToAgent ?? true) !== false) {
    ctx.systemPrompt.section({
      name: 'plugin:dsh-visualize',
      order: 210,
      text: GUIDANCE,
    })
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: handleView,
        }),
      'dsh-visualize: inline visualization route',
    )
  })
}
