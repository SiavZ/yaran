/**
 * The destructive-action pattern: a server-rendered confirm page, upgraded to a dialog.
 *
 * Every destructive action is a link to `GET …/:id/<verb>`, which renders this page: the
 * target as a chip, the consequence in words, Cancel first and autofocused, then (after
 * misclick-safe spacing) a destructive-styled confirm button that POSTs to the same URL.
 * `enhance.js` lifts the `[data-confirm-form]` into a native `<dialog>`; Esc there cancels.
 * A target that has vanished renders "already removed" instead of a button.
 *
 * <module-headers:begin>
 * Uses:
 * src/console/ui/confirm.tsx
 * ├── src/console/ui/components.tsx
 * └── src/console/ui/strings.ts
 * External: hono
 *
 * Used by:
 * src/console/ui/confirm.tsx
 * ├── src/console/admin-pages-2.tsx
 * ├── src/console/admin-pages.tsx
 * ├── src/console/user-pages.tsx
 * └── test/node/ui-kit.test.tsx
 * <module-headers:end>
 */
import type { Child } from "hono/jsx";
import { Chip, LinkButton, Notice, PostForm } from "./components.tsx";
import { S } from "./strings.ts";

export interface ConfirmProps {
  /** Lead sentence before the chip, e.g. "Revoke the machine". */
  lead: string;
  target: string;
  consequence: Child;
  action: string;
  cancelHref: string;
  confirmLabel: string;
  /** Extra controls (a checkbox) placed above the buttons. */
  extra?: Child;
}

export function ConfirmBody(p: ConfirmProps) {
  return (
    <div class="confirm">
      <p>
        {p.lead} <Chip>{p.target}</Chip>?
      </p>
      <p>{p.consequence}</p>
      <PostForm action={p.action} class="stack">
        <div data-confirm-form="">
          {p.extra}
          <div class="confirm-actions">
            <LinkButton href={p.cancelHref} variant="outline" autofocus>
              {S.cancel}
            </LinkButton>
            <span class="confirm-gap" aria-hidden="true" />
            <button type="submit" class="btn btn-destructive">
              {p.confirmLabel}
            </button>
          </div>
        </div>
      </PostForm>
    </div>
  );
}

/** What a confirm URL shows when its target no longer exists. */
export function AlreadyRemoved(props: { what: string; target: string; backHref: string }) {
  return (
    <div class="confirm">
      <Notice tone="info">
        {props.what} <Chip>{props.target}</Chip> {S.alreadyRemoved}
      </Notice>
      <LinkButton href={props.backHref} variant="outline" autofocus>
        {S.back}
      </LinkButton>
    </div>
  );
}
