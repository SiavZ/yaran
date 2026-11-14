/**
 * The push migration applies on an empty database and on one 06 has already populated, and
 * the settings accessor, mute rule and relay rule behave per 02.
 *
 * <module-headers:begin>
 * Uses:
 * test/push/migration.test.ts
 * ├── src/push/settings.ts
 * ├── test/helpers/deps.ts
 * └── test/push/helpers/fakes.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PUSH_SETTINGS, isMuted, isRelayChannel, pushSettings, relayVerdict } from "../../src/push/settings.ts";
import { wipe } from "../helpers/deps.ts";
import { NOW, OWNER, seedUser, settingsWith } from "./helpers/fakes.ts";

describe("0006 and 0008 device columns", () => {
  beforeEach(wipe);

  it("give the devices table every delivery column, and add the dedupe and stats tables", async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toEqual(expect.arrayContaining(["device_machine_mutes", "event_ids", "push_stats"]));
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('devices')").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["push_state", "last_push_ok_at", "consecutive_failures", "mute_all", "muted_until"]));
  });

  it("refuses an unknown push_state", async () => {
    await seedUser(env.DB, OWNER);
    const insert = env.DB.prepare(
      `INSERT INTO devices (id, user_id, install_id, platform, flavor, form_factor, push_kind, device_key, device_key_fingerprint, app_version, label, created_at, push_state)
       VALUES ('d', ?, 'i', 'ios', 'dev', 'phone', 'none', zeroblob(65), ?, '1', 'p', ?, 'ok')`,
    );
    await expect(insert.bind(OWNER, "x".repeat(29), NOW).run()).rejects.toThrow(/CHECK/);
  });
});

describe("push settings", () => {
  it("defaults when never written", () => {
    expect(pushSettings(undefined)).toEqual({ enabled: true, detail: "names", ttl_seconds: 3600, relay_allowed: true, allowed_relays: [] });
  });
  it.each([
    ["ttl below 60", { ttl_seconds: 59 }],
    ["ttl above 86400", { ttl_seconds: 86_401 }],
    ["fractional ttl", { ttl_seconds: 60.5 }],
    ["unknown detail", { detail: "full" }],
    ["relay origin with a path", { allowed_relays: ["https://relay.example.com/x"] }],
    ["http relay origin", { allowed_relays: ["http://relay.example.com"] }],
  ])("refuses %s loudly", (_, over) => {
    expect(() => pushSettings({ ...DEFAULT_PUSH_SETTINGS, ...over })).toThrow(/invalid/);
  });
  it("accepts the bounds", () => {
    expect(pushSettings(settingsWith({ ttl_seconds: 60 })).ttl_seconds).toBe(60);
    expect(pushSettings(settingsWith({ ttl_seconds: 86_400 })).ttl_seconds).toBe(86_400);
  });
});

describe("02's mute rule", () => {
  const free = { mute_all: false, muted_until: null };
  it.each([
    ["unmuted", free, false, false],
    ["mute_all", { mute_all: true, muted_until: null }, false, true],
    ["muted_until in the future", { mute_all: false, muted_until: NOW + 1 }, false, true],
    ["muted_until reached", { mute_all: false, muted_until: NOW }, false, false],
    ["muted machine", free, true, true],
  ])("%s", (_, device, machine, muted) => {
    expect(isMuted(device, machine, NOW)).toBe(muted);
  });
});

describe("relay rule", () => {
  it("passes direct channels whatever the relay settings", () => {
    expect(relayVerdict(settingsWith({ relay_allowed: false }), "unifiedpush", "https://up.example.com")).toBe("ok");
    expect(isRelayChannel("fcm_embedded")).toBe(false);
  });
  it("refuses relays when disabled or not allowlisted", () => {
    expect(relayVerdict(settingsWith({ relay_allowed: false }), "apns_relay", "https://relay.example.com")).toBe("disabled");
    expect(relayVerdict(settingsWith({ allowed_relays: ["https://other.example.com"] }), "fcm_relay", "https://relay.example.com")).toBe("not_allowlisted");
    expect(relayVerdict(settingsWith({ allowed_relays: ["https://relay.example.com"] }), "apns_relay", "https://relay.example.com")).toBe("ok");
  });
});
