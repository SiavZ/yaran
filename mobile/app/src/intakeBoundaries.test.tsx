/**
 * Work that began for one org or one push installation ends with it (round 22): an org-route
 * check spanning a sign-out or an erase and a re-add never signs in to, or saves for, the new
 * org; a push drain whose installation was torn down registers and publishes nothing; and Turn
 * on whose permission check spans an erase asks the system nothing. Ported from the round 22
 * review probes, with live controls.
 *
 * <module-headers:begin>
 * Uses:
 * src/intakeBoundaries.test.tsx
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushTestKit.ts
 * ├── src/push/pushWiring.ts
 * └── src/screens/machines/MachineRoutes.tsx
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Push } from '@yaran/push';
import { Session } from './lib/native/machineView.ts';
import { addDirect, findDirect } from './lib/directStore.ts';
import { addOrg, eraseEverything, signOutOrg, orgStore } from './lib/orgStore.ts';
import { machinesStore, resetMachines } from './lib/machinesStore.ts';
import { addCheckedOrgRoute } from './screens/machines/MachineRoutes.tsx';
import { installPush, pushAction } from './push/pushWiring.ts';
import { pushStore, muteSync } from './push/pushDeps.ts';
import { device, meta, VAPID } from './push/pushTestKit.ts';

vi.mock('@yaran/push', async (orig) => ({
 ...(await orig<typeof import('@yaran/push')>()),
 Push: {
  addListener: vi.fn(async () => ({remove:async()=>{}})),
  drainPendingRegistrations: vi.fn(async () => ({orgIds:[]})),
  forgetOrg: vi.fn(async()=>{}), clearDelivered:vi.fn(async()=>{}),
  cacheMachineNames:vi.fn(async()=>{}), setLocalMutes:vi.fn(async()=>{}),
  checkPermission:vi.fn(async()=>({notifications:'granted'})),
  requestPermission:vi.fn(async()=>({notifications:'granted'})),
  localState:vi.fn(async()=>({subscribed:false,vapidPublicKey:VAPID,relayKeyCurrent:null,endpointHost:null})),
  registerDevice:vi.fn(async()=>({outcome:'ok',device:device()})),
 }
}));
const ORG={id:'https://cp.example.com',name:'Ada',teamDomain:null,addedAt:'x'};
const M={id:'3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',name:'laptop',hostname:'laptop.example.com',status:'online'};
const yaran={kind:'yaran',instance:'inst-1',passwordSet:true,requiredHere:false,signedIn:true,transportEncrypted:true} as const;
function deferred<T>() {let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const pause=()=>new Promise(r=>setTimeout(r,20));
let stop:(()=>void)|null=null;
beforeEach(async()=>{
 resetMachines(); pushStore.set({}); muteSync.forget(); orgStore.set({loaded:true,orgs:[]});
 await addOrg(ORG);
 machinesStore.set({[ORG.id]:{state:'ready',machines:[M] as never,fetchedAt:0}});
 vi.mocked(Session.request).mockReset().mockResolvedValue({kind:'offline'});
 vi.mocked(Session.meta).mockReset().mockResolvedValue({kind:'ok',status:200,body:meta({org:{name:'Ada',url:ORG.id},access:{team_domain:'ada.cloudflareaccess.com'}} as never)});
 vi.mocked(Session.routeStatus).mockReset().mockResolvedValue(yaran);
 vi.mocked(Session.signIn).mockReset().mockResolvedValue({kind:'signed_in',host:'cp.example.com',email:'ada@example.com',expiresAt:2000000000} as never);
 vi.mocked(Session.installId).mockReset().mockResolvedValue({installId:'9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'});
 vi.mocked(Push.drainPendingRegistrations).mockReset().mockResolvedValue({orgIds:[]});
 vi.mocked(Push.registerDevice).mockClear();
});
afterEach(()=>{stop?.();stop=null;muteSync.forget();orgStore.set({loaded:true,orgs:[]});resetMachines();});

it('control: a current org-route check signs in and saves the checked route',async()=>{
 const d=await addDirect({host:'box.example.com',instance:'inst-1'});
 vi.mocked(Session.routeStatus).mockResolvedValueOnce({kind:'sign_in_required'}).mockResolvedValueOnce(yaran);
 const result=await addCheckedOrgRoute(d.id,ORG.id,M as never);
 expect(result.tone).toBe('success');
 expect(Session.signIn).toHaveBeenCalledOnce();
 expect(findDirect(d.id)?.routes).toHaveLength(2);
});
for(const ending of ['erase','sign-out'] as const) it(`an org-route probe spanning ${ending} and re-add must not start a new sign-in`,async()=>{
 const d=await addDirect({host:'box.example.com',instance:'inst-1'});
 const first=deferred<unknown>();
 vi.mocked(Session.routeStatus).mockImplementationOnce(()=>first.promise as never).mockResolvedValueOnce(yaran);
 const pending=addCheckedOrgRoute(d.id,ORG.id,M as never);
 await vi.waitFor(()=>expect(Session.routeStatus).toHaveBeenCalledOnce());
 if(ending==='erase') await eraseEverything(); else await signOutOrg(ORG.id);
 await addOrg(ORG);
 machinesStore.set({[ORG.id]:{state:'ready',machines:[M] as never,fetchedAt:0}});
 first.resolve({kind:'sign_in_required'});
 const result=await pending;
 expect.soft(Session.signIn).not.toHaveBeenCalled();
 if(ending==='sign-out') expect.soft(findDirect(d.id)?.routes).toHaveLength(1);
 expect.soft(result.tone).toBe('error');
});

for(const phase of ['install-id','pending-drain'] as const) it(`a push install torn down during ${phase} must start no later registration`,async()=>{
 const gate=deferred<unknown>();
 vi.mocked(Push.drainPendingRegistrations).mockResolvedValue({orgIds:[ORG.id]});
 if(phase==='install-id') vi.mocked(Session.installId).mockImplementationOnce(()=>gate.promise as never);
 else vi.mocked(Push.drainPendingRegistrations).mockImplementationOnce(()=>gate.promise as never);
 vi.mocked(Session.request).mockResolvedValue({kind:'ok',status:200,body:{items:[],next_cursor:null}});
 stop=await installPush();
 if(phase==='install-id') await vi.waitFor(()=>expect(Session.installId).toHaveBeenCalled());
 else await vi.waitFor(()=>expect(Push.drainPendingRegistrations).toHaveBeenCalled());
 stop(); stop=null;
 gate.resolve(phase==='install-id'?{installId:'9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'}:{orgIds:[ORG.id]});
 await pause();
 expect(Push.registerDevice).not.toHaveBeenCalled();
 expect(pushStore.get()).toEqual({});
});


it('control: a live push install completes its pending registration',async()=>{
 vi.mocked(Push.drainPendingRegistrations).mockResolvedValue({orgIds:[ORG.id]});
 vi.mocked(Session.request).mockResolvedValue({kind:'ok',status:200,body:{items:[],next_cursor:null}});
 stop=await installPush();
 await vi.waitFor(()=>expect(Push.registerDevice).toHaveBeenCalledOnce());
 expect(pushStore.get()[ORG.id]).toMatchObject({kind:'row',state:{kind:'active'}});
});

it('Turn on whose permission check spans an erase must not request a new permission afterwards',async()=>{
 const permission=deferred<unknown>();
 vi.mocked(Push.checkPermission).mockImplementationOnce(()=>permission.promise as never);
 const pending=pushAction(ORG.id,'turn_on');
 await vi.waitFor(()=>expect(Push.checkPermission).toHaveBeenCalled());
 await eraseEverything();
 vi.mocked(Push.requestPermission).mockClear();
 permission.resolve({notifications:'prompt'});
 await pending;
 expect(Push.requestPermission).not.toHaveBeenCalled();
});
