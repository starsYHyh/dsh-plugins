/**
 * Regression: the served wrapper must never pair a near-white brand fill with
 * white text, and must prefer the host's inverted-label token when present.
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

let handler = null
apply({
  systemPrompt: { section() {} },
  inject(deps, callback) {
    callback({ effect(fn) { fn() }, webServer: { register(route) { handler = route.handler; return () => {} } } })
  },
})

const server = http.createServer((request, response) => handler(request, response))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const fragment = new URL('../examples/buttons.html', import.meta.url).pathname

async function wrapperFor(scheme, vars) {
  const encoded = encodeURIComponent(Buffer.from(JSON.stringify(vars)).toString('base64'))
  const url =
    'http://127.0.0.1:' + port + '/dsh-visualize/view?path=' + encodeURIComponent(fragment) +
    '&id=vc&scheme=' + scheme + '&vars=' + encoded
  const response = await fetch(url)
  assert.equal(response.status, 200)
  return response.text()
}

// New client, dark theme: fill near-white, host supplies inverted label.
const modern = await wrapperFor('dark', {
  '--dsw-alias-bg-base': '#151517',
  '--dsw-alias-brand-primary': '#f9fafb',
  '--dsw-alias-button-primary-fill': '#f9fafb',
  '--dsw-alias-label-primary-inverted': '#353638',
})
assert.match(modern, /--primary-foreground: var\(--dsw-alias-label-primary-inverted, #111111\)/)
assert.match(modern, /--dsw-alias-label-primary-inverted: #353638/)

// Old client, no inverted token: luminance fallback must pick dark text.
const legacy = await wrapperFor('dark', {
  '--dsw-alias-bg-base': '#151517',
  '--dsw-alias-brand-primary': '#f9fafb',
})
assert.match(legacy, /--primary-foreground: var\(--dsw-alias-label-primary-inverted, #111111\)/)

// Light theme: dark fill still gets white text.
const light = await wrapperFor('light', {
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-brand-primary': '#0f1115',
})
assert.match(light, /--primary-foreground: var\(--dsw-alias-label-primary-inverted, #ffffff\)/)

// Static wrapper styles are served from runtime.css and center the content column.
assert.match(light, /body > \* \{ margin-left: auto; margin-right: auto; \}/)

server.close()
console.log('wrapper contrast regression passed')
