import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useSettings} from '../../packages/app/src/hooks/use-settings';
import {ToastApiProvider} from '../../packages/app/src/contexts/toast-api-context';
import {AssistantFileLinkResolverProvider} from '../../packages/app/src/assistant-file-links/provider';
import {LiveUi as Before} from './source/before/client/live-ui';
import {LiveUi as After} from './source/after/client/live-ui';
import {compile} from './source/after/shared/core';
import {Link, ExternalLink} from './ui';

const listeners = new Set<(destination: string, url: string) => void>();
function record(destination: string, url: string) { for (const listener of listeners) listener(destination,url); }
window.paseoDesktop = {
  platform: 'linux',
  opener: {openUrl: async (url) => record('external',url)},
  invoke: async () => ({releaseChannel:'stable', notifications:{playSound:true}, daemon:{manageBuiltInDaemon:false, keepRunningAfterQuit:false}}),
};
const toast={show:()=>()=>{},copied:()=>{},error:(message:string)=>console.error(message)};
const theme={colors:{surface0:'#ffffff',surface1:'#ffffff',surface2:'#f3f5f9',border:'#dce2ed',foreground:'#172032',foregroundMuted:'#536076',accent:'#244fb1',accentForeground:'#fff',statusSuccess:'#15803d',statusWarning:'#b7790a',statusDanger:'#b91c1c'}};
const source='Card("Agent answer", [Text("Read [the documentation](https://example.com/docs)."), Button("Open generated link", OpenUrl("https://example.com/action")), Sources([{url: "https://example.com/source", title: "Source reference"}])])';
const compiled=compile(source);
if(compiled.diagnostics.length) throw new Error(JSON.stringify(compiled.diagnostics));
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
function App(){
 const {settings,updateSettings,isLoading}=useSettings();
 const [mode,setMode]=useState('after');
 const [workspace,setWorkspace]=useState(true);
 const [events,setEvents]=useState<{destination:string,url:string}[]>([]);
 React.useEffect(()=>{const listener=(destination:string,url:string)=>setEvents(e=>[...e,{destination,url}]);listeners.add(listener);return()=>{listeners.delete(listener)}},[]);
 const openInWorkspace=React.useCallback((url:string)=>record('in-app',url),[]);
 const last=events.at(-1);
 const Renderer=mode==='before'?Before:After;
 const Forge=mode==='before'?ExternalLink:Link;
 return <main>
 <div className="badge">Paseo × GenUI · source integration QA</div><h1>Links follow your preference</h1>
 <p>Real GenUI controls, Paseo settings persistence, and public link opener.</p>
 <div className="notice">Chromium integration fixture. Desktop bridge and workspace-tab boundary are instrumented; this is not a full Electron session.</div>
 <div className="toolbar">
 <label>Source revision<div><button aria-label="Before fix" className={mode==='before'?'active':''} onClick={()=>setMode('before')}>Before fix</button> <button aria-label="After fix" className={mode==='after'?'active':''} onClick={()=>setMode('after')}>After fix</button></div></label>
 <label>Agent links<select aria-label="Agent links" value={settings.agentLinkBehavior} onChange={e=>void updateSettings({agentLinkBehavior:e.target.value as 'in-app'|'external'})}><option value="in-app">Open in Paseo</option><option value="external">Open in browser</option></select></label>
 <label>Pull request links<select aria-label="Pull request links" value={settings.forgeLinkBehavior} onChange={e=>void updateSettings({forgeLinkBehavior:e.target.value as 'in-app'|'external'})}><option value="in-app">Open in Paseo</option><option value="external">Open in browser</option></select></label>
 <label>Workspace browser<select aria-label="Workspace browser" value={String(workspace)} onChange={e=>setWorkspace(e.target.value==='true')}><option value="true">Available</option><option value="false">Unavailable</option></select></label>
 </div>
 <div className="layout"><section className="panel"><h2>{mode==='before'?'Before: explicit external opening':'After: preference-aware opening'}</h2>
 {isLoading?<p>Loading settings…</p>:<AssistantFileLinkResolverProvider serverId="qa-host" workspaceRoot="/qa/workspace" onOpenUrlInBrowserTab={workspace?openInWorkspace:null}>
 <Renderer key={mode} program={compiled.program!} compileDiagnostics={[]} source={source} stateKey={'qa-'+mode} send={async()=>{}} openFile={null} loadImage={null} readText={null} loadAudio={null} playAudio={null} agentId={null} blockKey={null} theme={theme} compact={false} platform="web"/>
 <div className="gap"/><small>Forge link (public component used by PR and CI controls)</small><div className="gap"/>
 <Forge {...(mode==='after'?{kind:'forge' as const}:{})} href="https://github.com/getpaseo/paseo/pull/1">Open pull request</Forge>
 </AssistantFileLinkResolverProvider>}
 </section><section className="panel"><h2>Observed opening destination</h2>
 {last?<div className={'result '+(last.destination==='external'?'external':'')} data-testid="destination"><strong>{last.destination==='in-app'?'Paseo workspace browser':'External browser'}</strong><p>{last.url}</p></div>:<p>Click a link to observe where the real opener routes it.</p>}
 <div data-testid="events">{events.slice(-7).map((e,i)=><div className="event" key={events.length-7+i}>{e.destination==='in-app'?'IN PASEO':'EXTERNAL'} · {e.url}</div>)}</div>
 </section></div>
 <footer>Before = GenUI base revision. After = edited GenUI source + new public Paseo API. No main daemon, installed plugin, or live preference is changed.</footer>
 </main>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><ToastApiProvider api={toast}><App/></ToastApiProvider></QueryClientProvider>);
