// Shared helpers for editing environment variables as `KEY=VALUE` text. Used by
// the global-env and per-project settings dialogs so the parse/serialize rules
// stay identical.

// Render an env map as sorted `KEY=VALUE` lines for a textarea.
export function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
}

// Editors must reject malformed lines before replacing the whole environment.
export function validateEnv(text: string): string | null {
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) {
      return `Line ${index + 1} must use KEY=VALUE.`
    }
  }
  return null
}

// Blank lines and comments are skipped; values may themselves contain `=`.
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = Object.create(null)
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue // skip lines with no key
    env[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return env
}
