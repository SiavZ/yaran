/**
 * Settings building blocks: a labelled switch row and a radio choice group.
 *
 * - Every control has an accessible name and a 40 px target.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/SettingRow.tsx
 * └── @yaran/ui-kit:src/switch.tsx
 * External: react
 *
 * Used by:
 * src/screens/settings/SettingRow.tsx
 * ├── src/screens/settings/LanguageSettings.tsx
 * ├── src/screens/settings/SecuritySettings.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { Switch } from '@yaran/ui-kit/switch';
import { useId, type ReactNode } from 'react';

export function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-12 items-center justify-between gap-3">
      <div className="flex flex-col">
        <label id={`${id}-label`} htmlFor={id} className="font-medium">
          {label}
        </label>
        {description && <span className="text-sm text-muted-foreground">{description}</span>}
      </div>
      <Switch id={id} aria-labelledby={`${id}-label`} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v)} />
    </div>
  );
}

export function RadioGroup<T extends string>({
  legend,
  value,
  options,
  disabled,
  onChange,
}: {
  legend: ReactNode;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  disabled?: boolean;
  onChange: (next: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1" disabled={disabled}>
      <legend className="mb-1 font-medium">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="flex min-h-10 items-center gap-3">
          <input type="radio" className="size-5 accent-primary" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}
