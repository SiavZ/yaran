/**
 * A link held for the lock is retired by any newer link the moment it arrives (round 22): a
 * newer link opened after native unlocked, before the unlock reached the shell, is the only one
 * that opens; with both still locked, only the newer opens, once. Ported from the round 22 review.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/heldLinks.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * └── src/lib/orgStore.ts
 * External: @capacitor/app, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { App as CapApp } from '@capacitor/app';
import { AppLock } from '@yaran/secure-store';
import { agentLinkUrl } from '@yaran/protocol';
import { installDeepLinks, type DeepLinks } from './deepLinks.ts';
import { resetBuildInfoForTests } from './buildInfo.ts';
import { orgStore } from './orgStore.ts';
import { machinesStore, resetMachines } from './machinesStore.ts';
import { MachineView, Session } from './native/machineView.ts';
import { toast } from 'sonner';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));
const ORG='https://cp.example.com';
const M='3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const url=(agentId:string)=>agentLinkUrl('apps.example.org',{target:{kind:'org',orgUrl:ORG,machineId:M},agentId});
let links:DeepLinks|null=null;
let locked=true;
let send:(url:string)=>void;
beforeEach(async()=>{
 resetBuildInfoForTests();resetMachines();orgStore.set({loaded:true,orgs:[{id:ORG,name:'Ada',teamDomain:null,addedAt:'x'}]});
 machinesStore.set({[ORG]:{state:'ready',machines:[{id:M,hostname:'box.example.com',name:'box'}] as never,fetchedAt:0}});
 vi.mocked(AppLock.status).mockImplementation(async()=>({enabled:true,allowPasscode:false,grace:'1min',locked,biometry:'available'}));
 locked=true;
 links=await installDeepLinks();
 const listener=(vi.mocked(CapApp.addListener).mock.calls as unknown as [string,(e:{url:string})=>void][]).filter(c=>c[0]==='appUrlOpen').at(-1)![1];
 send=u=>listener({url:u});
});
afterEach(()=>{links?.remove();links=null;orgStore.set({loaded:true,orgs:[]});resetMachines();});
it('a newer link opened after native unlock supersedes the older held link before the unlock event is delivered',async()=>{
 send(url('A'));await links!.settled();expect(MachineView.open).not.toHaveBeenCalled();
 locked=false;
 send(url('B'));await links!.settled();expect(vi.mocked(MachineView.open).mock.calls.map(c=>c[0].route)).toEqual(['#/agent/B']);
 links!.release();await links!.settled();
 expect(vi.mocked(MachineView.open).mock.calls.map(c=>c[0].route)).toEqual(['#/agent/B']);
});
it('control: with both links still locked only the newer held link opens once after unlock',async()=>{
 send(url('A'));await links!.settled();send(url('B'));await links!.settled();
 locked=false;links!.release();await links!.settled();links!.release();await links!.settled();
 expect(vi.mocked(MachineView.open).mock.calls.map(c=>c[0].route)).toEqual(['#/agent/B']);
});

// Round 23: an older attempt that was still out when a newer link arrived never holds or opens after it.
function deferred<T>() { let resolve!:(v:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; }
it('a delayed old lock reply cannot resurrect A after newer B was taken in and opened',async()=>{
 const gate=deferred<Awaited<ReturnType<typeof AppLock.status>>>();
 vi.mocked(AppLock.status).mockImplementationOnce(()=>gate.promise);
 send(url('A'));
 await vi.waitFor(()=>expect(AppLock.status).toHaveBeenCalledOnce());
 locked=false;
 send(url('B'));
 gate.resolve({enabled:true,allowPasscode:false,grace:'1min',locked:true,biometry:'available'});
 await links!.settled();
 expect(vi.mocked(MachineView.open).mock.calls.map(c=>c[0].route)).toEqual(['#/agent/B']);
 links!.release();await links!.settled();
 expect(vi.mocked(MachineView.open).mock.calls.map(c=>c[0].route)).toEqual(['#/agent/B']);
});
it('a delayed old lock reply cannot resurrect A after newer Settings intent',async()=>{
 const gate=deferred<Awaited<ReturnType<typeof AppLock.status>>>();
 vi.mocked(AppLock.status).mockImplementationOnce(()=>gate.promise);
 send(url('A'));
 await vi.waitFor(()=>expect(AppLock.status).toHaveBeenCalledOnce());
 send('yaranapp://settings');
 gate.resolve({enabled:true,allowPasscode:false,grace:'1min',locked:true,biometry:'available'});
 await links!.settled();
 expect(window.location.hash).toBe('#/settings');
 locked=false;links!.release();await links!.settled();
 expect(MachineView.open).not.toHaveBeenCalled();
});

it('a native vault_locked reply cannot re-hold A after newer B has arrived',async()=>{
 let reject!:(v:unknown)=>void;
 const gate=new Promise<void>((_,r)=>reject=r);
 locked=false;
 vi.mocked(MachineView.open).mockImplementationOnce(()=>gate);
 send(url('A'));
 await vi.waitFor(()=>expect(MachineView.open).toHaveBeenCalledOnce());
 send(url('B'));
 reject(Object.assign(new Error('locked'),{code:'vault_locked'}));
 await links!.settled();
 links!.release();await links!.settled();
 expect(vi.mocked(MachineView.open).mock.calls.map(c=>c[0].route)).toEqual(['#/agent/A','#/agent/B']);
});
for(const newUrl of ['yaranapp://broken','file:///storage/emulated/0/test.png','content://media/test']) it(`new intent handling stays consistent for ${newUrl}`,async()=>{
 send(url('A'));await links!.settled();
 send(newUrl);await links!.settled();
 locked=false;links!.release();await links!.settled();
 expect(vi.mocked(MachineView.open).mock.calls.map(c=>c[0].route)).toEqual(newUrl.startsWith('yaranapp:')?[]:['#/agent/A']);
});

// Each layer on its own: a link that is no longer the newest never holds (so never asks for an
// unlock) and never opens, even before its release would be refused.
const holdToasts = () => vi.mocked(toast.info).mock.calls.filter((c) => String(c[0]).includes('Unlock yaran to open that link')).length;

it('the older link whose lock reply lands after B arrived is never held: no unlock prompt for it', async () => {
  const gate = deferred<Awaited<ReturnType<typeof AppLock.status>>>();
  vi.mocked(AppLock.status).mockImplementationOnce(() => gate.promise);
  vi.mocked(toast.info).mockClear();
  send(url('A'));
  await vi.waitFor(() => expect(AppLock.status).toHaveBeenCalledOnce());
  locked = false;
  send(url('B'));
  gate.resolve({ enabled: true, allowPasscode: false, grace: '1min', locked: true, biometry: 'available' });
  await links!.settled();
  expect(holdToasts()).toBe(0);
});

it('the older link whose native open answers vault_locked after B arrived is never held: no unlock prompt for it', async () => {
  let reject!: (v: unknown) => void;
  locked = false;
  vi.mocked(MachineView.open).mockImplementationOnce(() => new Promise<void>((_, r) => (reject = r)));
  vi.mocked(toast.info).mockClear();
  send(url('A'));
  await vi.waitFor(() => expect(MachineView.open).toHaveBeenCalledOnce());
  send(url('B'));
  reject(Object.assign(new Error('locked'), { code: 'vault_locked' }));
  await links!.settled();
  expect(holdToasts()).toBe(0);
});

it('the older link still loading its machine list when B arrives never opens; only B does', async () => {
  locked = false;
  // A's machine is not in the loaded list, so its open waits on a refresh that answers late.
  const OTHER = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c';
  let answer!: () => void;
  vi.mocked(Session.request).mockImplementationOnce(
    () => new Promise((r) => (answer = () => r({ kind: 'ok', status: 200, body: { items: [M, OTHER].map((id) => ({ id, name: id === M ? 'box' : 'other', hostname: id === M ? 'box.example.com' : 'other.example.com', url: 'https://x.example.com', status: 'online', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' })), next_cursor: null } }))),
  );
  send(agentLinkUrl('apps.example.org', { target: { kind: 'org', orgUrl: ORG, machineId: OTHER }, agentId: 'A' }));
  await vi.waitFor(() => expect(Session.request).toHaveBeenCalled());
  send(url('B'));
  answer();
  await links!.settled();
  expect(vi.mocked(MachineView.open).mock.calls.map((c) => c[0].route)).toEqual(['#/agent/B']);
});

it('a queued Settings link gives way to a newer agent link', async () => {
  const gate = deferred<Awaited<ReturnType<typeof AppLock.status>>>();
  vi.mocked(AppLock.status).mockImplementationOnce(() => gate.promise);
  send(url('A'));
  await vi.waitFor(() => expect(AppLock.status).toHaveBeenCalledOnce());
  send('yaranapp://settings');
  send(url('B'));
  locked = false;
  gate.resolve(await AppLock.status());
  await links!.settled();
  expect(vi.mocked(MachineView.open).mock.calls.map((c) => c[0].route)).toEqual(['#/agent/B']);
});

it('a queued add-org link gives way to later manual navigation', async () => {
  const gate = deferred<Awaited<ReturnType<typeof AppLock.status>>>();
  vi.mocked(AppLock.status).mockImplementationOnce(() => gate.promise);
  send(url('A'));
  await vi.waitFor(() => expect(AppLock.status).toHaveBeenCalledOnce());
  send('yaranapp://add-org?u=https%3A%2F%2Fother.example.com');
  window.location.hash = '#/settings';
  locked = false;
  gate.resolve(await AppLock.status());
  await links!.settled();
  expect(window.location.hash).toBe('#/settings');
  expect(MachineView.open).not.toHaveBeenCalled();
});
