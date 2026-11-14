/**
 * Rotation and token fetch: the token reaches the caller and never D1, the generation bumps,
 * and `evict` (W22 `kill_connections`) drops connectors.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/rotate.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/provisioning/index.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { fetchTunnelToken, rotateTunnelSecret, startProvision } from "../../src/provisioning/index.ts";
import { on } from "./fake-cloudflare/faults.ts";
import { expectNoSecretsInD1, machine, makeWorld, seedMachine, type World } from "./helpers/world.ts";

async function active(w: World): Promise<string> {
  const id = seedMachine(w);
  await startProvision(w.ctx, id);
  w.db.sqlite.prepare("UPDATE machines SET status = 'active' WHERE id = ?").run(id);
  w.cf.calls.length = 0;
  return id;
}

/** W22's body maps to the facade's option. */
const fromW22 = (body: { kill_connections: boolean }) => ({ evict: body.kill_connections });

describe("rotateTunnelSecret", () => {
  it.each([true, false])("returns TunnelCredentials with the new token (token in response: %s)", async (tokenInResponse) => {
    const w = makeWorld({ tokenInResponse });
    const id = await active(w);
    const tunnelId = machine(w, id)["tunnel_id"] as string;
    const creds = await rotateTunnelSecret(w.ctx, id, { evict: false });
    expect(validate("TunnelCredentials", creds).valid).toBe(true);
    expect(creds).toMatchObject({ id: tunnelId, token_version: 2 });
    expect(JSON.parse(atob(creds.token))).toMatchObject({ t: tunnelId, s: w.cf.state.tunnels.get(tunnelId)!.secret });
    expect(machine(w, id)["tunnel_secret_generation"]).toBe(2);
    expect(w.cf.calls.some((c) => c.path.endsWith("/connections"))).toBe(false);
    expect(w.audits.at(-1)?.action).toBe("machine.rotated");
    expectNoSecretsInD1(w);
  });

  it("evicts connectors when W22 asks to kill connections", async () => {
    const w = makeWorld();
    const id = await active(w);
    const tunnelId = machine(w, id)["tunnel_id"] as string;
    w.cf.state.tunnels.get(tunnelId)!.connectors = 3;
    await rotateTunnelSecret(w.ctx, id, fromW22({ kill_connections: true }));
    expect(w.cf.state.tunnels.get(tunnelId)!.connectors).toBe(0);
    expect(w.cf.calls.filter((c) => c.method === "DELETE" && c.path.endsWith("/connections"))).toHaveLength(1);
  });

  it("refuses machines that are not live, and a rotation that did not finish", async () => {
    const w = makeWorld();
    const pending = seedMachine(w);
    await expect(rotateTunnelSecret(w.ctx, pending, { evict: false })).rejects.toMatchObject({ code: "machine_not_ready" });
    const id = await active(w);
    w.cf.faults.push({ kind: "transient", when: on("PATCH", /cfd_tunnel\/[^/]+$/) });
    await expect(rotateTunnelSecret(w.ctx, id, { evict: false })).rejects.toMatchObject({ code: "cloudflare_unavailable" });
    expectNoSecretsInD1(w);
  });
});

describe("fetchTunnelToken", () => {
  it("returns the current token for claimable machines only", async () => {
    const w = makeWorld();
    const id = await active(w);
    const creds = await fetchTunnelToken(w.ctx, id);
    expect(creds.token_version).toBe(1);
    expect(w.cf.calls.map((c) => c.method)).toEqual(["GET"]);
    w.db.sqlite.prepare("UPDATE machines SET status = 'revoking' WHERE id = ?").run(id);
    await expect(fetchTunnelToken(w.ctx, id)).rejects.toMatchObject({ code: "machine_not_ready" });
    expectNoSecretsInD1(w);
  });
});
