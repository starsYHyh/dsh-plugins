/**
 * Color helpers for theme-safe primary-button contrast.
 *
 * The wrapper prefers the host's paired tokens (button-primary-fill +
 * label-primary-inverted); these helpers produce a fallback foreground when a
 * host does not provide the inverted label, so a white brand fill can never
 * receive white text.
 */

/** Parse a CSS color into 0-255 RGB channels, or null when unsupported. */
export function parseColor(value) {
  if (typeof value !== 'string') return null
  const input = value.trim().toLowerCase()
  if (input === '') return null

  const hex = /^#([0-9a-f]{3,8})$/.exec(input)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: parseInt(digits[0] + digits[0], 16),
        g: parseInt(digits[1] + digits[1], 16),
        b: parseInt(digits[2] + digits[2], 16),
      }
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
      }
    }
    return null
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(input)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map((part) => {
      if (part.endsWith('%')) return (parseFloat(part) / 100) * 255
      return parseFloat(part)
    })
    if (channels.some((channel) => !Number.isFinite(channel))) return null
    return {
      r: Math.max(0, Math.min(255, Math.round(channels[0]))),
      g: Math.max(0, Math.min(255, Math.round(channels[1]))),
      b: Math.max(0, Math.min(255, Math.round(channels[2]))),
    }
  }

  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(input)
  if (srgb) {
    return {
      r: Math.round(Math.max(0, Math.min(1, parseFloat(srgb[1]))) * 255),
      g: Math.round(Math.max(0, Math.min(1, parseFloat(srgb[2]))) * 255),
      b: Math.round(Math.max(0, Math.min(1, parseFloat(srgb[3]))) * 255),
    }
  }

  return null
}

/** WCAG relative luminance for an RGB color. */
export function relativeLuminance(color) {
  const channel = (value) => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG contrast ratio between two parsed colors. */
export function contrastRatio(a, b) {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Pick black or white text for a fill color, whichever has more contrast.
 * Returns null when the color cannot be parsed so callers can keep a fallback.
 */
export function pickForeground(color) {
  const rgb = parseColor(color)
  if (!rgb) return null
  const luminance = relativeLuminance(rgb)
  const whiteRatio = 1.05 / (luminance + 0.05)
  const blackRatio = (luminance + 0.05) / 0.05
  return whiteRatio >= blackRatio ? '#ffffff' : '#111111'
}
