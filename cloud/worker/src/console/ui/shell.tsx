/**
 * Console page shell: document skeleton, landmarks, skip link and navigation.
 *
 * Every setup, user-console and admin page renders inside this shell. It is dark-only like
 * the web UI (`class="dark"` selects ui-kit's dark token set), links only same-origin
 * assets, and carries no inline script or style, so the strict CSP holds.
 *
 * - `renderPage` returns the full document string; `htmlResponse` adds the headers.
 *
 * <module-headers:begin>
 * Uses:
 * src/console/ui/shell.tsx
 * └── src/console/ui/strings.ts
 * External: hono
 *
 * Used by:
 * src/console/ui/shell.tsx
 * ├── src/console/admin-pages.tsx
 * ├── src/console/routes.ts
 * ├── src/console/user-pages.tsx
 * ├── src/setup/pages-steps.tsx
 * ├── src/setup/pages.tsx
 * ├── src/setup/routes.ts
 * ├── src/ui/kit.ts
 * └── test/node/ui-kit.test.tsx
 * <module-headers:end>
 */
import type { Child } from "hono/jsx";
import { S } from "./strings.ts";

export interface NavLink {
  href: string;
  label: string;
}

export const USER_NAV: readonly NavLink[] = [
  { href: "/console", label: S.nav.machines },
  { href: "/console/phones", label: S.nav.phones },
  { href: "/console/connect", label: S.nav.connect },
];

export const ADMIN_NAV: readonly NavLink[] = [
  { href: "/admin/users", label: S.nav.users },
  { href: "/admin/machines", label: S.nav.adminMachines },
  { href: "/admin/devices", label: S.nav.devices },
  { href: "/admin/audit", label: S.nav.audit },
  { href: "/admin/settings", label: S.nav.settings },
  { href: "/admin/health", label: S.nav.health },
  { href: "/admin/updates", label: S.nav.updates },
];

export interface ShellProps {
  title: string;
  orgName?: string;
  nav?: readonly NavLink[];
  current?: string;
  banner?: Child;
  /** False leaves out the enhancement script (06's consent pages run no script at all). */
  script?: boolean;
  children?: Child;
}

export function Shell(props: ShellProps) {
  const fullTitle = props.orgName ? `${props.title} · ${props.orgName}` : props.title;
  return (
    <html lang="en" class="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on a
            form POST, which the Origin check refuses (Fetch, request origin serialization). */}
        <meta name="referrer" content="same-origin" />
        <title>{fullTitle}</title>
        <link rel="stylesheet" href="/console/tokens.css" />
        <link rel="stylesheet" href="/console/console.css" />
        {props.script !== false && <script type="module" src="/console/enhance.js" />}
      </head>
      <body>
        <a class="skip-link" href="#main">
          {S.skipLink}
        </a>
        <header class="topbar">
          <span class="brand">{props.orgName ?? "yaran"}</span>
          {props.nav && (
            <nav aria-label={S.nav.label}>
              <ul class="nav">
                {props.nav.map((l) => (
                  <li>
                    <a href={l.href} aria-current={l.href === props.current ? "page" : undefined}>
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </header>
        {props.banner}
        <main id="main" tabindex={-1}>
          <h1>{props.title}</h1>
          {props.children}
        </main>
      </body>
    </html>
  );
}

/** Renders a JSX tree to a full HTML document string. */
export async function renderPage(node: { toString(): string | Promise<string> }): Promise<string> {
  return `<!doctype html>${String(await node.toString())}`;
}
