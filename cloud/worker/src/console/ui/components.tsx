/**
 * The console's component kit: chip, buttons, fields, tables, notices, empty states, times.
 *
 * Mirrors the semantics of ui-kit's React components (InlineCode chip, one 40 px button
 * height per cluster, icon-plus-text notices) for a script-free, server-rendered page.
 * Every visual comes from classes in `assets/console/console.css`, which uses only
 * ui-kit token variables; nothing here writes a `style` attribute.
 *
 * - Names in prose are always a `Chip`, never a quotation.
 * - Fields wire label, hint and error through `for`/`id` and `aria-describedby`.
 *
 * <module-headers:begin>
 * Uses:
 * src/console/ui/components.tsx
 * └── src/console/ui/strings.ts
 * External: hono
 *
 * Used by:
 * src/console/ui/components.tsx
 * ├── src/console/admin-pages-2.tsx
 * ├── src/console/admin-pages.tsx
 * ├── src/console/flash-notice.tsx
 * ├── src/console/ui/confirm.tsx
 * ├── src/console/user-pages.tsx
 * ├── src/setup/pages-steps.tsx
 * ├── src/setup/pages.tsx
 * └── test/node/ui-kit.test.tsx
 * <module-headers:end>
 */
import type { Child } from "hono/jsx";
import { S } from "./strings.ts";

/** A name in prose (branch, host, email, machine): the console's `InlineCode`. */
export function Chip(props: { children: Child }) {
  return <code class="chip">{props.children}</code>;
}

export type ButtonVariant = "primary" | "outline" | "destructive";

export function Button(props: { variant?: ButtonVariant; name?: string; value?: string; children: Child }) {
  return (
    <button type="submit" class={`btn btn-${props.variant ?? "primary"}`} name={props.name} value={props.value}>
      {props.children}
    </button>
  );
}

export function LinkButton(props: { href: string; variant?: ButtonVariant; autofocus?: boolean; confirm?: boolean; children: Child }) {
  return (
    <a class={`btn btn-${props.variant ?? "outline"}`} href={props.href} autofocus={props.autofocus} data-confirm={props.confirm ? "" : undefined}>
      {props.children}
    </a>
  );
}

/** A same-origin POST form; the Worker checks Origin on every unsafe form post. */
export function PostForm(props: { action: string; class?: string; children: Child }) {
  return (
    <form method="post" action={props.action} class={props.class ?? "stack"}>
      {props.children}
    </form>
  );
}

export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  type?: "text" | "email" | "number" | "password" | "url";
  value?: string | number;
  required?: boolean;
  autocomplete?: string;
  multiline?: boolean;
  options?: readonly (string | { value: string; label: string })[];
}

/** One labelled input with optional hint and error, both announced via aria-describedby. */
export function Field(p: FieldProps) {
  const hintId = p.hint ? `${p.id}-hint` : undefined;
  const errId = p.error ? `${p.id}-error` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  const common = { id: p.id, name: p.id, "aria-describedby": describedBy, "aria-invalid": p.error ? "true" : undefined, required: p.required };
  let control: Child;
  if (p.options) {
    control = (
      <select {...common} class="input">
        {p.options.map((o) => {
          const { value, label } = typeof o === "string" ? { value: o, label: o } : o;
          return (
            <option value={value} selected={value === p.value}>
              {label}
            </option>
          );
        })}
      </select>
    );
  } else if (p.multiline) {
    control = (
      <textarea {...common} class="input" rows={4}>
        {p.value ?? ""}
      </textarea>
    );
  } else {
    control = <input {...common} class="input" type={p.type ?? "text"} value={p.value} autocomplete={p.autocomplete} />;
  }
  return (
    <div class="field">
      <label for={p.id}>{p.label}</label>
      {control}
      {p.hint && (
        <p id={hintId} class="hint">
          {p.hint}
        </p>
      )}
      {p.error && (
        <p id={errId} class="field-error">
          {p.error}
        </p>
      )}
    </div>
  );
}

export function Checkbox(p: { id: string; label: string; checked?: boolean; hint?: string }) {
  const hintId = p.hint ? `${p.id}-hint` : undefined;
  return (
    <div class="field checkbox">
      <input type="checkbox" id={p.id} name={p.id} checked={p.checked} aria-describedby={hintId} />
      <label for={p.id}>{p.label}</label>
      {p.hint && (
        <p id={hintId} class="hint">
          {p.hint}
        </p>
      )}
    </div>
  );
}

export function Table(props: { caption: string; headers: readonly string[]; children: Child }) {
  return (
    <div class="table-wrap">
      <table>
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.headers.map((h) => (
              <th scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

export type NoticeTone = "info" | "warn" | "error" | "success";

const NOTICE_ICON: Record<NoticeTone, string> = { info: "i", warn: "!", error: "×", success: "✓" };

/** A status message: an icon and a word for the tone, never colour alone. */
export function Notice(props: { tone: NoticeTone; children: Child }) {
  return (
    <div class={`notice notice-${props.tone}`} role={props.tone === "error" ? "alert" : "status"}>
      <span class="notice-icon" aria-hidden="true">
        {NOTICE_ICON[props.tone]}
      </span>
      <span class="sr-only">{S.tone[props.tone]}</span>
      <div class="notice-body">{props.children}</div>
    </div>
  );
}

export function EmptyState(props: { children: Child }) {
  return <p class="empty">{props.children}</p>;
}

/** An absolute, server-rendered time; enhance.js adds the relative wording. */
export function RelativeTime(props: { iso: string | null | undefined }) {
  if (!props.iso) return <span class="muted">{S.never}</span>;
  return (
    <time datetime={props.iso} data-relative="">
      {props.iso.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC")}
    </time>
  );
}

/** A read-only value with a copy button (the button works only with JS; the text is selectable without). */
export function CopyField(props: { id: string; label: string; value: string }) {
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      <div class="copy-row">
        <input id={props.id} class="input mono" readonly value={props.value} />
        <button type="button" class="btn btn-outline" data-copy={props.id} hidden>
          {S.copy}
        </button>
      </div>
    </div>
  );
}
