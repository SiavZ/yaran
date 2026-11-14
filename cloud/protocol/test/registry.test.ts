/**
 * Keeps the data registries honest (Design §3, §4, §6, §13): codes are unique and well
 * formed, every error code an OpenAPI operation names exists in the registry, every
 * HTTP-emittable registry code is named by some operation (local and reserved codes
 * excepted), and refusal, audit-action, capability and close-code lists follow their rules.
 *
 * <module-headers:begin>
 * Uses:
 * test/registry.test.ts
 * ├── registry/audit-actions.json
 * ├── registry/capabilities.json
 * ├── registry/close-codes.json
 * ├── registry/errors.json
 * └── registry/refusals.json
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import audit from "../registry/audit-actions.json" with { type: "json" };
import capabilities from "../registry/capabilities.json" with { type: "json" };
import closeCodes from "../registry/close-codes.json" with { type: "json" };
import errors from "../registry/errors.json" with { type: "json" };
import refusals from "../registry/refusals.json" with { type: "json" };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const openapi = ["worker", "yaran-machine", "relay"].map((n) => readFileSync(join(root, `openapi/${n}.openapi.yaml`), "utf8"));

function listed(key: string): Set<string> {
  const out = new Set<string>();
  for (const doc of openapi) {
    for (const m of doc.matchAll(new RegExp(`${key}: \\[([^\\]]*)\\]`, "g"))) {
      for (const code of m[1]!.split(",")) out.add(code.trim());
    }
  }
  return out;
}

type Entry = (typeof errors.codes)[number] & { local?: boolean; reserved?: boolean };
const entries = errors.codes as Entry[];

describe("error registry", () => {
  it("has unique snake_case codes with a valid status", () => {
    const codes = entries.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const e of entries) {
      expect(e.code).toMatch(/^[a-z][a-z0-9_]*$/);
      if (e.local) expect(e.status).toBeNull();
      else if (e.status === null) expect(e.code).toBe("handoff_declined");
      else expect(e.status).toBeGreaterThanOrEqual(400);
      for (const by of e.emitted_by) expect(["any", "worker", "yaran", "relay", "local"]).toContain(by);
    }
  });

  it("names only registry codes in the OpenAPI documents, never local or reserved ones", () => {
    const byCode = new Map(entries.map((e) => [e.code, e]));
    for (const code of listed("x-error-codes")) {
      const e = byCode.get(code);
      expect(e, `OpenAPI names unknown code ${code}`).toBeDefined();
      expect(e!.local || e!.reserved, `OpenAPI names ${code}, which is never sent`).toBeFalsy();
    }
  });

  it("references every HTTP-emittable code from some operation", () => {
    const used = listed("x-error-codes");
    const missing = entries.filter((e) => !e.local && !e.reserved && !used.has(e.code)).map((e) => e.code);
    expect(missing).toEqual([]);
  });

  it("carries the D24 handoff codes", () => {
    const codes = new Set(entries.map((e) => e.code));
    for (const c of ["handoff_device_key_invalid", "handoff_signature_malformed", "handoff_timestamp_skewed"]) expect(codes.has(c)).toBe(true);
  });
});

describe("refusal registry", () => {
  it("has unique kebab-case access-/host- codes, all named by the machine document", () => {
    const codes = refusals.refusals.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of refusals.refusals) {
      expect(r.code).toMatch(/^(?:access|host)-[a-z]+(?:-[a-z]+)*$/);
      expect([401, 403, 503]).toContain(r.status);
    }
    const used = listed("x-refusal-codes");
    for (const code of used) expect(codes).toContain(code);
    expect(codes.filter((c) => !used.has(c))).toEqual([]);
  });
});

describe("other registries", () => {
  it("audit actions are unique <subject>.<verb>", () => {
    expect(new Set(audit.actions).size).toBe(audit.actions.length);
    for (const a of audit.actions) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it("capabilities are unique and dotted", () => {
    expect(new Set(capabilities.capabilities).size).toBe(capabilities.capabilities.length);
    for (const c of capabilities.capabilities) expect(c).toMatch(/^[a-z_]+(?:\.[a-z0-9_]+)*$/);
  });

  it("close codes keep 4001 and add 4401", () => {
    expect(closeCodes.close_codes.map((c) => c.code)).toEqual([4001, 4401]);
    expect(closeCodes.close_codes[1]!.reason).toBe("access session expired");
  });
});
