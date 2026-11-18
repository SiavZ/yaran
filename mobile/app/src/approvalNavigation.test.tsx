/**
 * An approval or sign-in whose reply lands after a link moved the address, but before React
 * cleaned the screen up, acts as abandoned (round 22): no direct machine is saved and the
 * approval's own sign-in is ended, the org sign-in leaves Settings in place while the org
 * itself settles, and a `closed` event reaching a listener still registering when the App went
 * away does nothing. Ported from the round 22 review probes, with controls.
 *
 * <module-headers:begin>
 * Uses:
 * src/approvalNavigation.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/push/pushTestKit.ts
 * └── src/test/render.tsx
 * External: @capacitor/app, @testing-library/react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { App as CapApp } from '@capacitor/app';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { agentLinkUrl } from '@yaran/protocol';
import { AppLock, SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import { App } from './App.tsx';
import { renderShell } from './test/render.tsx';
import { eraseEverything, orgStore } from './lib/orgStore.ts';
import { addDirect, directStore } from './lib/directStore.ts';
import { machinesStore, resetMachines } from './lib/machinesStore.ts';
import { Session, MachineView } from './lib/native/machineView.ts';
import { DEFAULT_SETTINGS, settingsStore } from './lib/settingsStore.ts';
import { resetBuildInfoForTests } from './lib/buildInfo.ts';
import { meta } from './push/pushTestKit.ts';

vi.mock('sonner', async orig=>({...await orig<typeof import('sonner')>(), toast:{info:vi.fn(),success:vi.fn(),warning:vi.fn(),error:vi.fn(),loading:vi.fn()}}));
const HOST='box.example.com';
const ORG='https://cp.example.com';
const writeStore = vi.mocked(SecureStore.set).getMockImplementation()!;
const pause=()=>new Promise(r=>setTimeout(r,20));
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const appUrl=(url:string)=>(vi.mocked(CapApp.addListener).mock.calls as unknown as [string,(e:{url:string})=>void][]).filter(c=>c[0]==='appUrlOpen').at(-1)![1]({url});
async function settings(){
 appUrl('yaranapp://settings');
 for(let i=0;i<40&&window.location.hash!=='#/settings';i++) await Promise.resolve();
 expect(window.location.hash).toBe('#/settings');
}
beforeEach(()=>{
 vi.mocked(SecureStore.set).mockReset().mockImplementation(writeStore);
 orgStore.set({loaded:true,orgs:[]});resetMachines();resetBuildInfoForTests();settingsStore.set({...DEFAULT_SETTINGS});
 vi.mocked(Session.directStatus).mockReset().mockResolvedValue({kind:'yaran',instance:'inst-1',passwordSet:true,requiredHere:true,signedIn:false,transportEncrypted:true});
 vi.mocked(Session.signIn).mockReset().mockResolvedValue({kind:'signed_in',host:'cp.example.com',email:'ada@example.com',expiresAt:2000000000} as never);
 vi.mocked(Session.meta).mockReset().mockResolvedValue({kind:'ok',status:200,body:meta({org:{name:'Ada',url:ORG},access:{team_domain:'ada.cloudflareaccess.com'}} as never)});
});
it.each(['Settings', 'teardown', 'previous org'])('an org staged after abandonment starts no sign-in: %s', async (mode) => {
  if (mode === 'previous org') orgStore.set({ loaded: true, orgs: [{ id: ORG, name: 'Previous', teamDomain: null, addedAt: 'old' }] });
  window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
  const view = renderShell(<App />);
  const button = await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'resume')).toBe(true));
  const staging = deferred<void>();
  const write = vi.mocked(SecureStore.set).getMockImplementation()!;
  vi.mocked(SecureStore.set).mockImplementationOnce(async (options) => { await staging.promise; return write(options); });
  fireEvent.click(button);
  await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
  if (mode === 'teardown') view.unmount();
  else await settings();
  await act(async () => { staging.resolve(); await pause(); });
  expect(Session.signIn).not.toHaveBeenCalled();
  expect(orgStore.get().orgs.map((o) => o.name)).toEqual(mode === 'previous org' ? ['Previous'] : []);
  const saved = await SecureStore.get({ namespace: 'orgs', key: 'list' });
  expect(saved.value === null ? [] : JSON.parse(saved.value).map((o: { name: string }) => o.name)).toEqual(mode === 'previous org' ? ['Previous'] : []);
  view.unmount();
});

it.each(['Settings', 'teardown', 'previous org'])('failed abandoned-org cleanup is reported globally: %s', async (mode) => {
  if (mode === 'previous org') orgStore.set({ loaded: true, orgs: [{ id: ORG, name: 'Previous', teamDomain: null, addedAt: 'old' }] });
  window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
  const view = renderShell(<App />);
  const button = await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'resume')).toBe(true));
  const gate = deferred<void>();
  vi.mocked(SecureStore.set).mockImplementationOnce(async (options) => { await gate.promise; return writeStore(options); }).mockRejectedValueOnce({ code: 'unavailable' });
  fireEvent.click(button);
  await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
  if (mode === 'teardown') view.unmount();
  else await settings();
  await act(async () => { gate.resolve(); await pause(); });
  expect(Session.signIn).not.toHaveBeenCalled();
  expect(orgStore.get().orgs[0]?.name).toBe('Ada');
  const saved = await SecureStore.get({ namespace: 'orgs', key: 'list' });
  expect(JSON.parse(saved.value!)[0].name).toBe('Ada');
  expect(toast.error).toHaveBeenCalledOnce();
  renderShell(<>{vi.mocked(toast.error).mock.calls[0]![0]}</>);
  expect(screen.getByText('unavailable')).toBeTruthy();
  expect(screen.getByText(/temporary org details/)).toBeTruthy();
  view.unmount();
});

it('an erase overtaking a failed staging cleanup remains quiet and clears the staged org', async () => {
  window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
  const view = renderShell(<App />);
  const button = await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'resume')).toBe(true));
  const stage = deferred<void>();
  let failCleanup!: () => void;
  vi.mocked(SecureStore.set)
    .mockImplementationOnce(async (options) => { await stage.promise; return writeStore(options); })
    .mockImplementationOnce(() => new Promise((_, reject) => { failCleanup = () => reject({ code: 'unavailable' }); }));
  fireEvent.click(button);
  await settings();
  await act(async () => { stage.resolve(); });
  await waitFor(() => expect(failCleanup).toBeTypeOf('function'));
  const erasing = eraseEverything();
  await act(async () => { failCleanup(); await erasing; });
  expect(Session.signIn).not.toHaveBeenCalled();
  expect(orgStore.get().orgs).toEqual([]);
  expect(toast.error).not.toHaveBeenCalled();
  view.unmount();
});

const ROUTE_MACHINE = { id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', name: 'laptop', hostname: 'laptop.example.com', status: 'online' };
const ROUTE_STATUS = { kind: 'yaran', instance: 'inst-1', passwordSet: true, requiredHere: false, signedIn: true, transportEncrypted: true } as const;
async function routeScreen() {
  orgStore.set({ loaded: true, orgs: [{ id: ORG, name: 'Ada', teamDomain: null, addedAt: 'x' }] });
  machinesStore.set({ [ORG]: { state: 'ready', machines: [ROUTE_MACHINE] as never, fetchedAt: Date.now() } });
  const record = await addDirect({ host: HOST, instance: 'inst-1' });
  window.location.hash = `#/machine-routes?id=${record.id}`;
  const view = renderShell(<App />);
  const button = await screen.findByRole('button', { name: 'Add laptop through Ada' });
  await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'resume')).toBe(true));
  return { ...view, button, record };
}

for (const step of ['sign-in', 'save']) it.each(['Settings', 'teardown', 'machine choice'])(`org route ${step} yields to %s during its probe`, async (ending) => {
  const gate = deferred<unknown>();
  vi.mocked(Session.routeStatus).mockReset().mockImplementationOnce(() => gate.promise as never).mockResolvedValue(ROUTE_STATUS);
  const view = await routeScreen();
  fireEvent.click(view.button);
  await waitFor(() => expect(Session.routeStatus).toHaveBeenCalledOnce());
  if (ending === 'teardown') view.unmount();
  else if (ending === 'Settings') await settings();
  else {
    appUrl(agentLinkUrl('apps.example.org', { target: { kind: 'direct', host: HOST }, agentId: 'newer' }));
    await waitFor(() => expect(MachineView.open).toHaveBeenCalledOnce());
  }
  await act(async () => { gate.resolve(step === 'sign-in' ? { kind: 'sign_in_required' } : ROUTE_STATUS); await pause(); });
  expect(Session.signIn).not.toHaveBeenCalled();
  expect(directStore.get().machines.find((r) => r.id === view.record.id)?.routes).toHaveLength(1);
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  view.unmount();
});

it.each(['Settings', 'teardown', 'rollback failure'])('an org route written across %s is undone or retained with truthful feedback', async (ending) => {
  vi.mocked(Session.routeStatus).mockReset().mockResolvedValue(ROUTE_STATUS);
  const view = await routeScreen();
  const gate = deferred<void>();
  const write = vi.mocked(SecureStore.set).getMockImplementation()!;
  let writing = false;
  vi.mocked(SecureStore.set).mockImplementationOnce(async (options) => { writing = true; await gate.promise; return write(options); });
  if (ending === 'rollback failure') vi.mocked(SecureStore.set).mockRejectedValueOnce({ code: 'unavailable' });
  fireEvent.click(view.button);
  await waitFor(() => expect(writing).toBe(true));
  if (ending === 'teardown') view.unmount();
  else await settings();
  await act(async () => { gate.resolve(); await pause(); });
  const expected = ending === 'rollback failure' ? 2 : 1;
  expect(directStore.get().machines.find((r) => r.id === view.record.id)?.routes).toHaveLength(expected);
  const saved = await SecureStore.get({ namespace: 'direct', key: 'list' });
  expect(JSON.parse(saved.value!)[0].routes).toHaveLength(expected);
  expect(toast.success).not.toHaveBeenCalled();
  if (ending === 'rollback failure') {
    expect(toast.error).toHaveBeenCalledOnce();
    renderShell(<>{vi.mocked(toast.error).mock.calls[0]![0]}</>);
    expect(screen.getByText(/couldn't undo the route change/)).toBeTruthy();
  } else expect(toast.error).not.toHaveBeenCalled();
  view.unmount();
});

it('org staging yields to a newer machine choice without a hash change', async () => {
  await addDirect({ host: 'other.example.com', instance: 'inst-2' });
  window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
  const view = renderShell(<App />);
  const button = await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'resume')).toBe(true));
  const gate = deferred<void>();
  const write = vi.mocked(SecureStore.set).getMockImplementation()!;
  vi.mocked(SecureStore.set).mockImplementationOnce(async (options) => { await gate.promise; return write(options); });
  fireEvent.click(button);
  appUrl(agentLinkUrl('apps.example.org', { target: { kind: 'direct', host: 'other.example.com' }, agentId: 'newer' }));
  await waitFor(() => expect(MachineView.open).toHaveBeenCalledOnce());
  expect(window.location.hash).toBe(`#/confirm?u=${encodeURIComponent(ORG)}`);
  await act(async () => { gate.resolve(); await pause(); });
  expect(Session.signIn).not.toHaveBeenCalled();
  expect(orgStore.get().orgs).toEqual([]);
  view.unmount();
});

it('direct approval yields to a newer machine choice and ends only its own sign-in', async () => {
  const other = await addDirect({ host: 'other.example.com', instance: 'inst-2' });
  window.location.hash = `#/confirm-machine?h=${HOST}`;
  const view = renderShell(<App />);
  const gate = deferred<unknown>();
  vi.mocked(Session.directSignIn).mockImplementationOnce(() => gate.promise as never);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
  await waitFor(() => expect(Session.directSignIn).toHaveBeenCalledOnce());
  appUrl(agentLinkUrl('apps.example.org', { target: { kind: 'direct', host: 'other.example.com' }, agentId: 'newer' }));
  await waitFor(() => expect(MachineView.open).toHaveBeenCalledOnce());
  await act(async () => { gate.resolve({ kind: 'signed_in', host: HOST, instance: 'inst-1', signInId: 'AAAAAAAAAAAAAAAAAAAAAA' }); await pause(); });
  expect(directStore.get().machines).toEqual([other]);
  expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'AAAAAAAAAAAAAAAAAAAAAA' });
  expect(toast.success).not.toHaveBeenCalled();
  view.unmount();
});
it('direct approval must not save or replace Settings after its hash changed before React cleanup',async()=>{
 window.location.hash=`#/confirm-machine?h=${HOST}`;
 renderShell(<App/>);
 const gate=deferred<unknown>();
 vi.mocked(Session.directSignIn).mockImplementationOnce(()=>gate.promise as never);
 fireEvent.click(await screen.findByRole('button',{name:'Sign in and continue'}));
 await waitFor(()=>expect(Session.directSignIn).toHaveBeenCalledOnce());
 await settings();
 gate.resolve({kind:'signed_in',host:HOST,instance:'inst-1',signInId:'AAAAAAAAAAAAAAAAAAAAAA'});
 await pause();
 expect.soft(window.location.hash).toBe('#/settings');
 expect.soft(directStore.get().machines).toEqual([]);
 expect.soft(toast.success).not.toHaveBeenCalled();
});
it('org sign-in completion must not replace Settings after its hash changed before React cleanup',async()=>{
 window.location.hash=`#/confirm?u=${encodeURIComponent(ORG)}`;
 renderShell(<App/>);
 const gate=deferred<unknown>();
 vi.mocked(Session.signIn).mockImplementationOnce(()=>gate.promise as never);
 fireEvent.click(await screen.findByRole('button',{name:'Sign in'}));
 await waitFor(()=>expect(Session.signIn).toHaveBeenCalledOnce());
 await settings();
 gate.resolve({kind:'signed_in',host:'cp.example.com',email:'ada@example.com',expiresAt:2000000000});
 await pause();
 expect(window.location.hash).toBe('#/settings');
});

it('a closed listener still registering when App unmounts must not navigate or toast',async()=>{
 const gate=deferred<{remove:()=>Promise<void>}>();
 let closed!:(e:unknown)=>void;
 const remove=vi.fn(async()=>{});
 vi.mocked(MachineView.addListener).mockImplementation((async(name:string,cb:(e:unknown)=>void)=>{
  if(name==='closed'){closed=cb;return gate.promise;}
  return {remove:async()=>{}};
 }) as never);
 window.location.hash='#/settings/security';
 const shell=renderShell(<App/>);
 await waitFor(()=>expect(closed).toBeTypeOf('function'));
 shell.unmount();
 closed({reason:'error',code:'upgrade_required',host:HOST});
 gate.resolve({remove});
 await pause();
 expect.soft(window.location.hash).toBe('#/settings/security');
 expect.soft(toast.warning).not.toHaveBeenCalled();
 expect(remove).toHaveBeenCalledOnce();
});

it('the direct approval ends only its own sign-in, by its id', async () => {
 window.location.hash=`#/confirm-machine?h=${HOST}`;
 renderShell(<App/>);
 const gate=deferred<unknown>();
 vi.mocked(Session.directSignIn).mockImplementationOnce(()=>gate.promise as never);
 vi.mocked(Session.directSignOut).mockClear();
 fireEvent.click(await screen.findByRole('button',{name:'Sign in and continue'}));
 await waitFor(()=>expect(Session.directSignIn).toHaveBeenCalledOnce());
 await settings();
 gate.resolve({kind:'signed_in',host:HOST,instance:'inst-1',signInId:'AAAAAAAAAAAAAAAAAAAAAA'});
 await waitFor(()=>expect(Session.directSignOut).toHaveBeenCalledWith({host:HOST,signInId:'AAAAAAAAAAAAAAAAAAAAAA'}));
});
it('control: an undisturbed direct approval saves and goes to Machines', async () => {
 window.location.hash=`#/confirm-machine?h=${HOST}`;
 renderShell(<App/>);
 vi.mocked(Session.directSignIn).mockResolvedValueOnce({kind:'signed_in',host:HOST,instance:'inst-1',signInId:'AAAAAAAAAAAAAAAAAAAAAA'});
 fireEvent.click(await screen.findByRole('button',{name:'Sign in and continue'}));
 await waitFor(()=>expect(window.location.hash).toBe('#/machines'));
 expect(directStore.get().machines.map((m)=>m.host)).toEqual([HOST]);
 directStore.set({loaded:true,machines:[]});
});
it('the org sign-in that lost the screen still settles the org it staged', async () => {
 window.location.hash=`#/confirm?u=${encodeURIComponent(ORG)}`;
 renderShell(<App/>);
 const gate=deferred<unknown>();
 vi.mocked(Session.signIn).mockImplementationOnce(()=>gate.promise as never);
 fireEvent.click(await screen.findByRole('button',{name:'Sign in'}));
 await waitFor(()=>expect(Session.signIn).toHaveBeenCalledOnce());
 await settings();
 gate.resolve({kind:'signed_in',host:'cp.example.com',email:'ada@example.com',expiresAt:2000000000});
 await pause();
 expect(orgStore.get().orgs.map((o)=>o.id)).toEqual([ORG]);
 expect(window.location.hash).toBe('#/settings');
});
it('control: an undisturbed org sign-in goes to Machines', async () => {
 window.location.hash=`#/confirm?u=${encodeURIComponent(ORG)}`;
 renderShell(<App/>);
 fireEvent.click(await screen.findByRole('button',{name:'Sign in'}));
 await waitFor(()=>expect(window.location.hash).toBe('#/machines'));
});
it('control: a closed event after the listener is in place still navigates and warns', async () => {
 window.location.hash='#/settings/security';
 renderShell(<App/>);
 const calls=()=>vi.mocked(MachineView.addListener).mock.calls as unknown as [string,(e:unknown)=>void][];
 await waitFor(()=>expect(calls().some((c)=>c[0]==='closed')).toBe(true));
 await pause();
 calls().filter((c)=>c[0]==='closed').at(-1)![1]({reason:'error',code:'upgrade_required',host:HOST});
 await waitFor(()=>expect(toast.warning).toHaveBeenCalled());
 expect(window.location.hash).toBe('#/machines');
});

// Round 23: a launch that started locked keeps its own eligibility for the startup share after the unlock.

for (const signal of ['screen','native-event','no-newer-link'] as const) it(`locked startup share routing: ${signal}`,async()=>{
 const LOCKED={enabled:true,allowPasscode:false,grace:'1min',locked:true,biometry:'available'} as const;
 const launch=deferred<{url:string}|undefined>();
 vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
 vi.mocked(CapApp.getLaunchUrl).mockReturnValueOnce(launch.promise);
 vi.mocked(MachineView.shareStatus).mockResolvedValue({kind:'pending',count:1,batch:'00000000-0000-4000-8000-000000000001'});
 renderShell(<App/>);
 const unlock=await screen.findByRole('button',{name:'Unlock'});
 await waitFor(()=>expect((vi.mocked(CapApp.addListener).mock.calls as unknown[][]).some(c=>c[0]==='appUrlOpen')).toBe(true));
 vi.mocked(AppLock.status).mockResolvedValue({...LOCKED,locked:false});
 if(signal==='native-event') {
  const cb=(vi.mocked(AppLock.addListener).mock.calls as unknown as [string,(e:{locked:boolean})=>void][]).filter(c=>c[0]==='lockStateChanged').at(-1)![1];
  cb({locked:false});
 } else fireEvent.click(unlock);
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Unlock'})).toBe(null));
 await pause();
 if(signal!=='no-newer-link') await settings();
 launch.resolve(undefined);
 await pause();await pause();
 expect(window.location.hash).toBe(signal==='no-newer-link'?'#/share':'#/settings');
});

it('locked startup: a link held for the lock is still released once after the unlock, even though Settings vetoes the share', async () => {
 const LOCKED={enabled:true,allowPasscode:false,grace:'1min',locked:true,biometry:'available'} as const;
 const MID='3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
 orgStore.set({loaded:true,orgs:[{id:ORG,name:'Ada',teamDomain:null,addedAt:'x'}]});
 machinesStore.set({[ORG]:{state:'ready',machines:[{id:MID,name:'box',hostname:'box.example.com'}] as never,fetchedAt:Date.now()}});
 vi.mocked(Session.callbackMode).mockResolvedValue({mode:'https',domain:'apps.example.org'});
 vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
 vi.mocked(MachineView.shareStatus).mockResolvedValue({kind:'pending',count:1,batch:'00000000-0000-4000-8000-000000000001'});
 vi.mocked(MachineView.open).mockClear();
 const link=agentLinkUrl('apps.example.org',{target:{kind:'org',orgUrl:ORG,machineId:MID},agentId:'a1'});
 vi.mocked(CapApp.getLaunchUrl).mockResolvedValueOnce({url:link});
 renderShell(<App/>);
 await screen.findByRole('button',{name:'Unlock'});
 await waitFor(()=>expect(toast.info).toHaveBeenCalled());
 expect(MachineView.open).not.toHaveBeenCalled();
 vi.mocked(AppLock.status).mockResolvedValue({...LOCKED,locked:false});
 fireEvent.click(screen.getByRole('button',{name:'Unlock'}));
 await waitFor(()=>expect(MachineView.open).toHaveBeenCalledTimes(1));
 await pause();
 expect(vi.mocked(MachineView.open).mock.calls.map((c)=>(c[0] as {route?:string}).route)).toEqual(['#/agent/a1']);
});
