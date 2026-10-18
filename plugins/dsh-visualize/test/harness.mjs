/**
 * End-to-end harness for dsh-visualize without the real GUI.
 *
 * Serves a fake transcript with a content reference, the built client bundle,
 * and the real host route. Verifies scanning, iframe load, theme injection,
 * and the height bridge.
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { apply as applyHost } from '../lib/index.js'

const here = new URL('.', import.meta.url)
const clientJs = await readFile(new URL('../lib/client.js', here), 'utf8')
const demoPath = process.env.HARNESS_FRAGMENT || new URL('../examples/demo.html', here).pathname

let hostHandler = null
applyHost({
  systemPrompt: { section() {} },
  inject(deps, callback) {
    callback({
      effect(fn) { fn() },
      webServer: { register(route) { hostHandler = route.handler; return () => {} } },
    })
  },
})

const token = '\uE200visualize\uE202' + JSON.stringify({ path: demoPath }) + '\uE201'

const page = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-visualize harness</title>',
  '<style>',
  'body { --dsw-alias-bg-base: rgb(250 250 250); --dsw-alias-bg-layer-2: rgb(244 245 247); --dsw-alias-bg-layer-3: rgb(255 255 255); --dsw-alias-label-primary: rgb(27 27 28); --dsw-alias-label-secondary: rgb(93 98 104); --dsw-alias-border-l2: rgb(227 228 230); --dsw-alias-brand-primary: rgb(79 110 247); --dsw-alias-link: rgb(47 111 237); --dsw-alias-markdown-code-block: rgb(244 245 247); font-family: system-ui; padding: 24px; }',
  '</style></head><body>',
  '<p>lead-in text</p>',
  '<p id="token-line"></p>',
  '<p>trailing text</p>',
  '<script>window.__ModuleLoader__ = { load: function (entry) { window.__VIS = entry.factory(function () { throw new Error("no platform modules needed") }) } }</script>',
  '<script src="/plugins/client.js?v=2"></script>',
  '<script>',
  'window.__VIS.apply({ effect: function (fn) { fn() } })',
  'document.getElementById("token-line").textContent = ' + JSON.stringify(token) + ';',
  'setTimeout(function () {',
  '  var frames = document.querySelectorAll("iframe.dsh-visualize-frame")',
  '  var status = document.createElement("div")',
  '  status.id = "harness-status"',
  '  status.textContent = "HARNESS frames=" + frames.length + " height=" + (frames[0] ? (frames[0].getAttribute("data-height") || "pending") : "none")',
  '  document.body.appendChild(status)',
  '}, 2500)',
  '</script>',
  '</body></html>',
].join('\n')

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/plugins/client.js') {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(clientJs)
    return
  }
  if (url.pathname === '/dsh-visualize/view') {
    hostHandler(request, response)
    return
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
    return
  }
  response.writeHead(404)
  response.end('not found')
})

server.listen(0, '127.0.0.1', () => {
  console.log('HARNESS_URL=http://127.0.0.1:' + server.address().port + '/')
})
