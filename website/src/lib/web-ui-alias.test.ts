import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";

import { WEB_UI_MODULES, webUiAlias, webUiReactBridge } from "./web-ui-alias.mjs";

const kitFile = fileURLToPath(new URL("../../../packages/ui-kit/src/tooltip.tsx", import.meta.url));

// The figure's components import `@yaran/ui-kit`, whose peers must come from the
// app's node_modules: from anywhere else they are either missing (a fresh clone,
// the kit has no install of its own) or carry a second React (a developer who ran
// `npm ci` in the kit), and the figure renders neither way.
describe("web UI kit resolution", async () => {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    plugins: [webUiReactBridge()],
    resolve: { alias: webUiAlias() },
  });
  afterAll(() => server.close());

  it("resolves the kit's peers from the app's node_modules", async () => {
    for (const peer of ["@base-ui/react/tooltip", "clsx", "tailwind-merge"]) {
      const resolved = await server.environments.ssr.pluginContainer.resolveId(peer, kitFile);
      expect(resolved?.id, peer).toContain(WEB_UI_MODULES + "/");
    }
  });

  it("inlines the kit's peers so the SSR runner cannot resolve them around the plugin", () => {
    expect(server.config.ssr.noExternal).toEqual(
      expect.arrayContaining(["@base-ui/react", "clsx", "tailwind-merge"]),
    );
  });
});
