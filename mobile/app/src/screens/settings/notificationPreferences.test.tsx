/**
 * Notification preferences against native/Worker doubles: queued mute duration changes and
 * confirmed distributor selection. No real notifications or device registration are exercised.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/notificationPreferences.test.tsx
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushTestKit.ts
 * ├── src/screens/settings/NotificationSettings.tsx
 * └── src/test/render.tsx
 * External: @capacitor/core, @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { Capacitor } from '@capacitor/core';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Push } from '@yaran/push';
import { beforeEach, expect, it, vi } from 'vitest';
import { orgStore } from '../../lib/orgStore.ts';
import { Session } from '../../lib/native/machineView.ts';
import { muteSync, pushStore } from '../../push/pushDeps.ts';
import { device, meta, VAPID } from '../../push/pushTestKit.ts';
import { NotificationSettings } from './NotificationSettings.tsx';
import { renderShell } from '../../test/render.tsx';
vi.mock('@yaran/push', async(orig)=>({...await orig<typeof import('@yaran/push')>(), Push:{
 listDistributors:vi.fn(async()=>({distributors:[],selected:null,embedded:null})),selectDistributor:vi.fn(async()=>{}),
 cacheMachineNames:vi.fn(async()=>{}),checkPermission:vi.fn(async()=>({notifications:'granted'})),
 setLocalMutes:vi.fn(async()=>{}),forgetOrg:vi.fn(async()=>{}),
 localState:vi.fn(async()=>({subscribed:true,channel:'unifiedpush',endpointHost:'ntfy.example.com',vapidPublicKey:VAPID,relayKeyId:null,relayKeyCurrent:null})),
 registerDevice:vi.fn(),
}}));
const ORG='https://cp.example.com';
let server:ReturnType<typeof device>;
let hold:Promise<void>|null=null;
let release:()=>void;
const patches:unknown[]=[];
beforeEach(async()=>{
 vi.spyOn(Capacitor,'getPlatform').mockReturnValue('android');
 muteSync.forget();pushStore.set({});patches.length=0;hold=null;
 server=device();orgStore.set({loaded:true,orgs:[{id:ORG,name:'Ada',teamDomain:null,addedAt:'x'}]});
 vi.mocked(Session.meta).mockResolvedValue({kind:'ok',status:200,body:meta({org:{name:'Ada',url:ORG},access:{team_domain:'ada.cloudflareaccess.com'}} as never)});
 vi.mocked(Session.request).mockImplementation(async({method,body})=>{
  if(method==='GET')return {kind:'ok',status:200,body:{items:[server],next_cursor:null}};
  patches.push(body);const was=hold;hold=null;if(was)await was;
  server={...server,...body as object};return {kind:'ok',status:200,body:server};
 });
});
async function showSettings() {
 renderShell(<NotificationSettings/>);
 await screen.findByRole('button',{name:'Mute until I unmute'});
}
it('a later Hour choice replaces a pending Forever choice',async()=>{
 await showSettings();
 hold=new Promise<void>(r=>release=r);
 fireEvent.click(screen.getByRole('button',{name:'Mute until I unmute'}));
 await waitFor(()=>expect(patches).toHaveLength(1));
 fireEvent.click(screen.getByRole('button',{name:'Mute for an hour'}));
 await act(async()=>release());
 await waitFor(()=>expect(patches).toHaveLength(2));
 await act(async()=>new Promise(r=>setTimeout(r,20)));
 expect(server.muted_until).not.toBeNull();
 expect.soft(server.mute_all).toBe(false);
 expect.soft(vi.mocked(Push.setLocalMutes).mock.calls.at(-1)?.[0].mutes.mute_all).toBe(false);
 expect.soft(pushStore.get()[ORG]).toMatchObject({kind:'row',state:{kind:'muted',until:server.muted_until}});
});
it('control: Hour alone sets a finite mute',async()=>{
 await showSettings();
 fireEvent.click(screen.getByRole('button',{name:'Mute for an hour'}));
 await waitFor(()=>expect(patches).toHaveLength(1));
 await act(async()=>new Promise(r=>setTimeout(r,20)));
 expect(server.mute_all).toBe(false);expect(server.muted_until).not.toBeNull();
});
it('control: Forever alone stays indefinite',async()=>{
 await showSettings();
 fireEvent.click(screen.getByRole('button',{name:'Mute until I unmute'}));
 await waitFor(()=>expect(patches).toHaveLength(1));
 await act(async()=>new Promise(r=>setTimeout(r,20)));
 expect(server.mute_all).toBe(true);expect(server.muted_until).toBeNull();
});

it('after selecting distributor B successfully, the picker shows B',async()=>{
 vi.spyOn(Capacitor,'getPlatform').mockReturnValue('android');
 const ORG='https://cp.example.com';
 orgStore.set({loaded:true,orgs:[{id:ORG,name:'Ada',teamDomain:null,addedAt:'x'}]});
 pushStore.set({[ORG]:{kind:'row',state:{kind:'active'},device:null}});
 vi.mocked(Session.meta).mockResolvedValue({kind:'offline'});
 let selected='org.example.push.a';
 vi.mocked(Push.listDistributors).mockImplementation(async()=>({distributors:['org.example.push.a','org.example.push.b'],selected,embedded:null}));
 vi.mocked(Push.selectDistributor).mockImplementation(async({distributor})=>{selected=distributor;});
 renderShell(<NotificationSettings/>);
 const picker=await screen.findByRole('combobox') as HTMLSelectElement;
 expect(picker.value).toBe('org.example.push.a');
 fireEvent.change(picker,{target:{value:'org.example.push.b'}});
 await waitFor(()=>expect(Push.selectDistributor).toHaveBeenCalledWith({distributor:'org.example.push.b'}));
 expect(selected).toBe('org.example.push.b');
 await waitFor(()=>expect(picker.value).toBe('org.example.push.b'));
});

it('control: mounting the picker reads the current native selection',async()=>{
 vi.spyOn(Capacitor,'getPlatform').mockReturnValue('android');
 const ORG='https://cp.example.com';
 orgStore.set({loaded:true,orgs:[{id:ORG,name:'Ada',teamDomain:null,addedAt:'x'}]});
 pushStore.set({[ORG]:{kind:'row',state:{kind:'active'},device:null}});
 vi.mocked(Session.meta).mockResolvedValue({kind:'offline'});
 vi.mocked(Push.listDistributors).mockResolvedValue({distributors:['org.example.push.a','org.example.push.b'],selected:'org.example.push.b',embedded:null});
 renderShell(<NotificationSettings/>);
 const picker=await screen.findByRole('combobox') as HTMLSelectElement;
 expect(picker.value).toBe('org.example.push.b');
});
