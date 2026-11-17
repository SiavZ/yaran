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
 * ├── src/console/ui/components.tsx
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
import { breakable } from "./components.tsx";
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
  { href: "/console", label: S.nav.workspace },
];

/** The existing favicon's Y, using the shared product-identity token. */
function Mark() {
  return (
    <svg class="mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <path d="M120 104 256 240 392 104 432 144 284 292V432H228V292L80 144Z" fill="var(--yaran-brand)" />
    </svg>
  );
}

export interface ShellProps {
  title: string;
  orgName?: string;
  nav?: readonly NavLink[];
  current?: string;
  banner?: Child;
  /** The signed-in person's email, shown quietly in the bar; presentation only. */
  signedInAs?: string | undefined;
  /** A label after the org name saying which console this is (the admin console says Admin). */
  context?: string;
  /** True when the body carries its own `h1` (the pairing and handoff pages), so the shell prints none. */
  bodyHeading?: boolean;
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
          <span class="brand">
            <Mark />
            <span class="brand-name">yaran</span>
            {props.orgName && props.orgName !== "yaran" ? <span class="brand-org">{props.orgName}</span> : null}
            {props.context ? <span class="brand-context">{props.context}</span> : null}
          </span>
          {props.nav && (
            <nav aria-label={S.nav.label} class="nav-wrap">
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
          {props.signedInAs ? (
            <span class="signed-in">
              {S.signedInAs} <span class="name">{breakable(props.signedInAs)}</span>
            </span>
          ) : null}
        </header>
        {props.banner}
        <main id="main" tabindex={-1}>
          {props.bodyHeading ? null : <h1>{props.title}</h1>}
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
