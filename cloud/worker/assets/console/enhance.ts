/**
 * Progressive enhancement for the console: the only script any console page loads.
 *
 * Every page works without it. With it: links marked `data-confirm` open their confirm
 * page's form in a native `<dialog>` (Esc and Cancel close it, nothing confirms by
 * default), copy buttons appear, absolute times gain a relative label, and the wiring
 * self-test runs where a page asks for it.
 *
 * - Loaded as a same-origin module, so the CSP's `script-src 'self'` holds; no inline handlers.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by: entry point (compiled by npm run build in cloud/worker, loaded by every console page as /console/enhance.js)
 * <module-headers:end>
 */

function upgradeConfirmLinks(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-confirm]")) {
    link.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const res = await fetch(link.href, { credentials: "same-origin" }).catch(() => null);
      if (!res || !res.ok) return void (location.href = link.href);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const body = doc.querySelector(".confirm");
      if (!body) return void (location.href = link.href);
      const dialog = document.createElement("dialog");
      dialog.setAttribute("aria-labelledby", "confirm-title");
      const title = document.createElement("h2");
      title.id = "confirm-title";
      title.textContent = doc.querySelector("h1")?.textContent ?? "";
      dialog.append(title, document.importNode(body, true));
      const cancel = dialog.querySelector<HTMLAnchorElement>(".confirm-actions a");
      cancel?.addEventListener("click", (e) => {
        e.preventDefault();
        dialog.close();
      });
      dialog.addEventListener("close", () => dialog.remove());
      document.body.append(dialog);
      dialog.showModal();
      cancel?.focus();
    });
  }
}

function enableCopyButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    const input = document.getElementById(btn.dataset.copy ?? "") as HTMLInputElement | null;
    if (!input || !navigator.clipboard) continue;
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(input.value);
      btn.textContent = "Copied";
    });
  }
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

function relativeTimes(): void {
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const el of document.querySelectorAll<HTMLTimeElement>("time[data-relative]")) {
    const secs = (Date.parse(el.dateTime) - Date.now()) / 1000;
    if (Number.isNaN(secs)) continue;
    const [unit, size] = UNITS.find(([, s]) => Math.abs(secs) >= s) ?? UNITS[3]!;
    el.title = el.textContent ?? "";
    el.textContent = fmt.format(Math.round(secs / size), unit);
  }
}

interface Check {
  id: string;
  run: () => Promise<boolean>;
}

/** The wiring self-test after setup closes: public meta, machine override, protected API. */
const CHECKS: Check[] = [
  {
    id: "meta",
    run: async () => {
      const r = await fetch("/v1/meta", { credentials: "omit" });
      const body = r.ok ? await r.json() : null;
      return body?.setup === "closed";
    },
  },
  {
    id: "machine",
    run: async () => {
      const r = await fetch("/v1/machine/config", { credentials: "omit" });
      const body = r.headers.get("Content-Type")?.includes("json") ? await r.json() : null;
      return body?.error?.code === "signature_missing";
    },
  },
  {
    id: "protected",
    run: async () => {
      const r = await fetch("/v1/me", { credentials: "omit", redirect: "manual" });
      return !r.headers.get("Content-Type")?.includes("json") || r.type === "opaqueredirect";
    },
  },
];

async function selfTest(): Promise<void> {
  for (const check of CHECKS) {
    const el = document.querySelector<HTMLElement>(`[data-selftest="${check.id}"]`);
    if (!el) continue;
    const ok = await check.run().catch(() => false);
    el.textContent = ok ? "passed" : "failed";
    el.dataset.result = ok ? "pass" : "fail";
  }
}

upgradeConfirmLinks();
enableCopyButtons();
relativeTimes();
if (document.querySelector("[data-selftest]")) void selfTest();
