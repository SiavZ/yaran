import { describe, expect, it } from "vitest"
import { envToText, parseEnv, validateEnv } from "./env"

describe("environment editor validation", () => {
  it("accepts comments, blank lines, spaced keys and values containing equals", () => {
    const text = "# comment\n\n API_KEY =a=b \nEMPTY=\n"
    expect(validateEnv(text)).toBeNull()
    expect(parseEnv(text)).toEqual({ API_KEY: "a=b", EMPTY: "" })
  })

  it.each(["API_KEY", "=value", "   =value"])("reports the malformed line instead of silently dropping %s", (line) => {
    expect(validateEnv(`# comment\nOK=value\n${line}`)).toBe("Line 3 must use KEY=VALUE.")
  })

  it("round-trips environment names that match object properties", () => {
    const env = parseEnv("__proto__=value\nconstructor=another")
    expect(Object.keys(env)).toEqual(["__proto__", "constructor"])
    expect(envToText(env)).toBe("__proto__=value\nconstructor=another")
  })
})
