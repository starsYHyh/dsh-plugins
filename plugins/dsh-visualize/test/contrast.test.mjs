import assert from 'node:assert/strict'
import { parseColor, relativeLuminance, contrastRatio, pickForeground } from '../lib/contrast.js'

// Parsing
assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 })
assert.deepEqual(parseColor('#0f1115'), { r: 15, g: 17, b: 21 })
assert.deepEqual(parseColor('rgb(249, 250, 251)'), { r: 249, g: 250, b: 251 })
assert.deepEqual(parseColor('rgb(249 250 251)'), { r: 249, g: 250, b: 251 })
assert.deepEqual(parseColor('color(srgb 0.145 0.2 0.9)'), { r: 37, g: 51, b: 230 })
assert.equal(parseColor('color-mix(in srgb, red 50%, blue)'), null)

// Foreground selection
assert.equal(pickForeground('#ffffff'), '#111111')
assert.equal(pickForeground('#0f1115'), '#ffffff')
assert.equal(pickForeground('rgb(37, 99, 235)'), '#ffffff')
assert.equal(pickForeground('rgb(249, 250, 251)'), '#111111')
assert.equal(pickForeground('not-a-color'), null)

// Paired theme colors used by the DSH design system
const light = { fill: '#0f1115', text: '#ffffff' }
const dark = { fill: '#f9fafb', text: '#353638' }
assert.ok(contrastRatio(parseColor(light.fill), parseColor(light.text)) >= 4.5)
assert.ok(contrastRatio(parseColor(dark.fill), parseColor(dark.text)) >= 4.5)

// Derived fallback always clears WCAG AA for near-white brand fills
const derived = pickForeground('#f9fafb')
assert.ok(contrastRatio(parseColor('#f9fafb'), parseColor(derived)) >= 4.5)

console.log('contrast unit tests passed')
