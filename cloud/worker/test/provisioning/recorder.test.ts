/**
 * The fixture recorder's redaction: ids become stable placeholders, secrets and emails go.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/recorder.test.ts
 * └── scripts/record-cf-fixtures.mjs
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { redact } from "../../scripts/record-cf-fixtures.mjs";

describe("record-cf-fixtures redact", () => {
  it("redacts a sample capture", () => {
    const id = "6f5a3c1e-9b2d-4e8f-a1c0-7d6e5f4a3b2c";
    const capture = {
      result: {
        id,
        token: "eyJhIjoiMTIzIiwidCI6IjQ1NiIsInMiOiJzZWNyZXQifQ==",
        aud: "737646a56ab1df6ec9bddc7e5ca84eaf3b0768850f3ffb5d74f1534911fe3893",
        account_tag: "023e105f4ecef8ad9ca31a8372d0c353",
        content: `${id}.cfargotunnel.com`,
        include: [{ email: { email: "Jane.Doe@corp.example" } }],
        tunnel_secret: "c2VjcmV0",
        note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-looking-token",
      },
    };
    const out = redact(capture) as { result: Record<string, unknown> };
    const text = JSON.stringify(out);
    expect(text).not.toContain(id);
    expect(text).not.toContain("Jane.Doe");
    expect(text).not.toContain("c2VjcmV0");
    expect(text).not.toContain("737646a56ab1");
    expect(text).not.toContain("023e105f4ecef8ad");
    expect(out.result["token"]).toBe("[redacted]");
    expect(out.result["note"]).toBe("[redacted]");
    expect(out.result["id"]).toBe("00000000-0000-4000-8000-000000000001");
    expect(out.result["content"]).toBe("00000000-0000-4000-8000-000000000001.cfargotunnel.com");
    expect(String(out.result["aud"])).toMatch(/^0+\d+$/);
    expect(String(out.result["aud"])).toHaveLength(64);
  });
});
