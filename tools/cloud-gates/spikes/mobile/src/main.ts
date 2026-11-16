/**
 * Gate spike shell: the one bridge-enabled page, a debug screen of paste fields and buttons.
 *
 * Renders three sections (machine-view, auth, push) whose buttons call the spike plugins, and
 * a copyable output log the operator reads results from and pastes into gate evidence (after
 * `lib/redact.sh`). This is a probe, not product UI: plain DOM, no framework.
 *
 * - The JWT is read only from its paste field; nothing reads it from a URL or deep link.
 * - The log never prints the JWT; push endpoint keys are shown because G5 needs them pasted
 *   into `web-push` (the gate scripts redact them in evidence).
 *
 * <module-headers:begin>
 * Uses:
 * src/main.ts
 * └── src/plugins.ts
 * External: @capacitor/core
 *
 * Used by: entry point (loaded by index.html inside the Capacitor WebView)
 * <module-headers:end>
 */
import { Capacitor } from '@capacitor/core';
import { AuthSpike, MachineViewSpike, PushSpike, type SameSite } from './plugins';

const app = document.getElementById('app')!;
app.style.cssText = 'font: 14px system-ui; padding: max(16px, env(safe-area-inset-top)) 16px 48px';

const log = document.createElement('textarea');
log.readOnly = true;
log.rows = 14;
log.style.cssText = 'width: 100%; font: 12px ui-monospace, monospace';

function out(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  log.value = `[${new Date().toISOString()}] ${label}: ${text}\n${log.value}`;
}

function section(title: string): HTMLElement {
  const box = document.createElement('fieldset');
  box.style.cssText = 'margin: 0 0 16px; display: grid; gap: 8px';
  const legend = document.createElement('legend');
  legend.textContent = title;
  box.append(legend);
  app.append(box);
  return box;
}

function field(box: HTMLElement, label: string, placeholder = '', secret = false): HTMLInputElement {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display: grid; gap: 2px';
  wrap.textContent = label;
  const input = document.createElement('input');
  input.type = secret ? 'password' : 'text';
  input.placeholder = placeholder;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText = 'min-height: 40px; font: inherit';
  wrap.append(input);
  box.append(wrap);
  return input;
}

function choice(box: HTMLElement, label: string, options: string[]): HTMLSelectElement {
  const wrap = document.createElement('label');
  wrap.textContent = `${label} `;
  const select = document.createElement('select');
  select.style.minHeight = '40px';
  for (const o of options) select.add(new Option(o, o));
  wrap.append(select);
  box.append(wrap);
  return select;
}

function check(box: HTMLElement, label: string): HTMLInputElement {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display: flex; gap: 8px; align-items: center; min-height: 40px';
  const input = document.createElement('input');
  input.type = 'checkbox';
  wrap.append(input, label);
  box.append(wrap);
  return input;
}

function button(box: HTMLElement, label: string, run: () => Promise<unknown>): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'min-height: 44px; font: inherit';
  b.addEventListener('click', () => {
    run().then((r) => out(label, r ?? 'ok'), (e: unknown) => out(`${label} FAILED`, String(e)));
  });
  box.append(b);
}

// G1 / G3 / G6 / G12: in-process machine-view with an injected CF_Authorization cookie.
const mv = section('machine-view (G1 G3 G6 G12)');
const mvUrl = field(mv, 'Machine URL', 'https://<machine-host>/');
const mvJwt = field(mv, 'Paste Cf-Access-Jwt-Assertion (never logged)', 'eyJ...', true);
const mvSameSite = choice(mv, 'SameSite', ['Lax', 'Strict', 'None']);
const mvNativeChooser = check(mv, 'Android: native file chooser (OpenMultipleDocuments)');
const mvImeApply = check(mv, 'Android: apply IME inset in the plugin');
const mvKbGuide = check(mv, 'iOS: constrain to keyboardLayoutGuide');
button(mv, 'Open machine-view', () =>
  MachineViewSpike.open({
    url: mvUrl.value.trim(),
    jwt: mvJwt.value.trim(),
    sameSite: mvSameSite.value as SameSite,
    fileChooser: mvNativeChooser.checked ? 'native' : 'default',
    imeInsets: mvImeApply.checked ? 'apply' : 'default',
    keyboardGuide: mvKbGuide.checked,
  }),
);

// G13: verified https callback (release-shaped) and custom scheme (dev-shaped).
const au = section('auth handoff (G13)');
const auHost = field(au, 'Consent host', '<cp-host>');
const auDevice = field(au, 'Device label', 'gate-device');
const auMode = choice(au, 'Build shape', ['release', 'dev']);
const auEphemeral = check(au, 'Ephemeral browsing session');
const auCustomTab = check(au, 'Android: force Custom Tab (skip Auth Tab)');
const startAuth = (nil: boolean) => () =>
  AuthSpike.start({
    consentHost: auHost.value.trim(),
    mode: auMode.value as 'release' | 'dev',
    ephemeral: auEphemeral.checked,
    deviceLabel: auDevice.value.trim() || 'gate-device',
    forceCustomTab: auCustomTab.checked,
    nilPresentationContext: nil,
  });
button(au, 'Browser / verification info', () => AuthSpike.info());
button(au, 'Start handoff', startAuth(false));
if (Capacitor.getPlatform() === 'ios') {
  button(au, 'Debug: start with nil presentation context', startAuth(true));
}
void AuthSpike.addListener('authResult', (r) => out('authResult', r));

// G4 / G5: APNs device token (iOS) or UnifiedPush endpoint (Android).
const pu = section('push (G4 G5)');
const puVapid = field(pu, 'VAPID public key (Android; from web-push generate-vapid-keys)', 'B...');
button(pu, 'Register for push', () => PushSpike.register({ vapidPublicKey: puVapid.value.trim() }));
void PushSpike.addListener('push', (e) => out(`push ${e.kind}`, e));

const logBox = section('output (copyable)');
logBox.append(log);
out('platform', Capacitor.getPlatform());
