import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8")
const core = readFileSync(new URL("../../../../yaran-core/src/working_cue.rs", import.meta.url), "utf8")
const floor = Number(css.match(/@keyframes working-pulse\s*\{[\s\S]*?50%\s*\{\s*opacity:\s*([\d.]+)/)?.[1])
const luminance = (rgb: number[]) => rgb.reduce((sum, c, i) => {
  const s = c / 255
  return sum + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
}, 0)

describe("working status contrast", () => {
  it("shares the calibrated floor with the terminal UI", () => {
    expect(floor).toBe(Number(core.match(/PULSE_FLOOR: f32 = ([\d.]+)/)?.[1]))
  })

  it.each([10, 23, 38])("stays readable at the dimmest frame on background %s", (background) => {
    // Browser canvas measurements of Tailwind green-500 and the shipped dark
    // background/sidebar/selected tokens. The status is 12px, so AA needs 4.5.
    const bg = [background, background, background]
    const painted = [0, 201, 80].map((c, i) => c * floor + bg[i] * (1 - floor))
    expect((luminance(painted) + 0.05) / (luminance(bg) + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
})
