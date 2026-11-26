'use strict';
const $=id=>document.getElementById(id), ui={landing:$('landing'),room:$('room'),status:$('status'),notice:$('notice'),movie:$('movie'),screen:$('screenVideo')};
const MAX=6, prefix='frame-v1-', tokenRE=/^(?:[a-f0-9]{32}|[0-9a-hjkmnp-tv-z]{16})$/;let permissions={playback:false,browse:false},browserState='',browserSelected=false,activeShareKind='screen';let peer,roomKey='',roomSlug='',me='',name='',host=false,up=null,roster=new Map(),clients=new Map(),out=new Map(),incoming=new Map(),streams=new Map(),volumes=new Map(),localAV=new MediaStream(),localScreen=null,activeScreen='',movieState=null,applying=false,applyTimer,toastTimer,localURL='',localPlayback=false,pendingLocal=false,joined=false,leaving=false;
let voiceMode=false,voiceContext=null,voiceInput=null,voiceProcessor=null,voiceSilent=null,voiceTrack=null,voiceNeedsTap=false;const voiceQueue=new Map(),voiceGains=new Map(),voiceSources=new Set(),voiceRate=new Map(),voiceLast=new Map(),voiceRequestAt=new Map();const retryAttempts=new Map(), retryTimers=new Map(), lastMediaRequest=new Map();let networkWatch=null, screenRequestAt=0, autoplayBlocked=false, screenWaitAt=0;
const DEFAULT_ICE = [
  {urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']},
  {urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp'}
];
const relayScheme = /^turns?:/i;
const networkStorage = 'frame-turn';
const relayTestStorage = 'frame-relay-test';
let activeNetwork;

function parseRelay(raw) {
  if (!raw.trim()) return [];
  let entries;
  try { entries = JSON.parse(raw); } catch { throw Error('Paste a valid ICE server JSON array.'); }
  if (!Array.isArray(entries) || entries.length > 8) throw Error('Expected an array of up to 8 ICE servers.');
  return entries.map(entry => {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' ||
      url.length > 250 || !/^(stun|stuns|turn|turns):[^\s]+$/i.test(url))) throw Error('Invalid ICE server URL.');
    if (!urls.some(url => relayScheme.test(url))) return {urls};
    const {username, credential} = entry;
    if (typeof username !== 'string' || !username || typeof credential !== 'string' || !credential) {
      throw Error('TURN requires a username and a relay credential.');
    }
    return {urls, username, credential};
  });
}

function savedNetwork() {
  let servers = [];
  let testRequested = false;
  try {
    servers = parseRelay(sessionStorage.getItem(networkStorage) || '');
    testRequested = sessionStorage.getItem(relayTestStorage) === '1';
  } catch {}
  const turnUrls = servers.flatMap(server => server.urls.filter(url => relayScheme.test(url)));
  return {servers, turnUrls, relayOnly: testRequested && !!turnUrls.length};
}

function iceConfig() {
  activeNetwork = savedNetwork();
  const {servers, turnUrls, relayOnly} = activeNetwork;
  const publicServers = turnUrls.length ? [] : DEFAULT_ICE;
  return {
    iceServers: [...servers, ...publicServers],
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
    sdpSemantics: 'unified-plan',
    iceCandidatePoolSize: 0
  };
}

function networkText(text) { $('networkInfo').textContent = text; }

function networkLabel(network) {
  if (network.relayOnly) return 'Relay test mode. Only the configured TURN service can connect.';
  if (network.turnUrls.length) return 'Private TURN configured. Direct connections are still preferred.';
  return 'Automatic connection with public relay fallback.';
}

function updateNetworkSettings() {
  const settings = savedNetwork();
  $('relayConfig').value = settings.servers.length ? JSON.stringify(settings.servers, null, 2) : '';
  $('relayOnly').checked = settings.relayOnly;
  if (!joined) networkText(networkLabel(settings));
}

updateNetworkSettings();
$('networkToggle').onclick = () => {
  const panel = $('networkPanel');
  panel.hidden = !panel.hidden;
  $('networkToggle').setAttribute('aria-expanded', String(!panel.hidden));
};
$('relaySave').onclick = () => {
  try {
    const servers = parseRelay($('relayConfig').value);
    const relayOnly = $('relayOnly').checked;
    if (relayOnly && !servers.some(server => server.urls.some(url => relayScheme.test(url)))) {
      throw Error('Add a TURN server before enabling relay test mode.');
    }
    if (servers.length) sessionStorage.setItem(networkStorage, JSON.stringify(servers));
    else sessionStorage.removeItem(networkStorage);
    if (relayOnly) sessionStorage.setItem(relayTestStorage, '1');
    else sessionStorage.removeItem(relayTestStorage);
    updateNetworkSettings();
    toast(joined ? 'Saved. Leave and rejoin to apply.' : 'Network settings saved.');
  } catch (error) {
    toast('Could not save network settings. ' + error.message);
  }
};
$('relayClear').onclick = () => {
  try {
    sessionStorage.removeItem(networkStorage);
    sessionStorage.removeItem(relayTestStorage);
    updateNetworkSettings();
    toast(joined ? 'Default saved. Leave and rejoin to apply.' : 'Default network settings restored.');
  } catch {
    toast('Could not clear the saved network settings in this browser.');
  }
};
const safeName=v=>String(v||'Guest').trim().slice(0,28)||'Guest';
function status(s){ui.status.textContent=s;}function notice(s){ui.notice.textContent=s;toast(s);}function toast(s){$('toast').textContent=s;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}function id(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');}
const ROOM_ALPHABET='0123456789abcdefghjkmnpqrstvwxyz';
function newRoomCode(){const bytes=crypto.getRandomValues(new Uint8Array(10));let bits=0,buffer=0,code='';for(const byte of bytes){buffer=(buffer<<8)|byte;bits+=8;while(bits>=5){bits-=5;code+=ROOM_ALPHABET[(buffer>>>bits)&31];}buffer&=(1<<bits)-1;}return code;}
function slugify(s){return String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24).replace(/-+$/,'');}
function parseInvite(s){s=String(s||'').trim();if(!s)return {key:'',slug:''};try{const u=new URL(s);s=u.hash.slice(1)||u.searchParams.get('room')||'';}catch{}s=s.replace(/^#/,'').toLowerCase();const dot=s.lastIndexOf('.');return {key:dot<0?s:s.slice(dot+1),slug:dot<0?'':slugify(s.slice(0,dot))};}
function parseRoom(s){return parseInvite(s).key;}
function inviteLink(){const u=new URL('./',location.href);u.search='';u.hash=(roomSlug?roomSlug+'.':'')+roomKey;return u.href;}
function roomTitle(){return roomSlug?roomSlug.split('-').map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(' '):'Movie night';}
function theme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('frame-theme',t);}catch{}$('theme').setAttribute('aria-label',t==='dark'?'Switch to light mode':'Switch to night mode');document.querySelector('meta[name=theme-color]').content=t==='dark'?'#141515':'#f5f5f2';}try{theme(localStorage.getItem('frame-theme')||'dark');$('nickname').value=localStorage.getItem('frame-name')||'';}catch{}$('theme').onclick=()=>theme(document.documentElement.dataset.theme==='dark'?'light':'dark');
const initial=parseInvite(location.hash||new URL(location.href).searchParams.get('room')||'');if(tokenRE.test(initial.key))$('roomInput').value=(initial.slug?initial.slug+'.':'')+initial.key;function startLabel(){const joining=!!$('roomInput').value.trim();$('start').firstChild.textContent=joining?'Join room ':'Create room ';$('roomNameWrap').hidden=joining;}$('roomInput').oninput=startLabel;startLabel();
function send(c,m){if(c?.open)try{c.send(m);}catch{}}function broadcast(m){for(const c of clients.values())send(c,m);}function toHost(m){if(host)handleHost(me,m);else send(up,m);}
function enter(){joined=true;ui.landing.hidden=true;ui.room.hidden=false;status('Connected');networkText(networkLabel(activeNetwork));history.replaceState(null,'',inviteLink());$('roomTitle').textContent=roomTitle();renderPeople();$('mediaRetry').hidden=false;$('voiceCompat').hidden=!host;startNetworkWatch();updateVoiceStatus();$('mediaURL').disabled=!host;$('loadMovie').disabled=!host;$('permissionsToggle').hidden=!host;refreshAccess();if(!host)ui.notice.textContent='The host manages guest permissions. Calls and screen sharing remain available.';}
$('joinForm').onsubmit=e=>{e.preventDefault();if(peer)return;const requested=parseRoom($('roomInput').value);if($('roomInput').value.trim()&&!tokenRE.test(requested)){toast('Invalid room link or code.');return;}if(!window.Peer){toast('Signaling library unavailable. Check your internet and reload.');return;}if(!window.isSecureContext){toast('Open Frame over HTTPS or localhost.');return;}name=safeName($('nickname').value);try{localStorage.setItem('frame-name',name);}catch{}host=!requested;roomKey=requested||newRoomCode();roomSlug=host?slugify($('roomName').value):parseInvite($('roomInput').value).slug;status('Connecting…');$('start').disabled=true;peer=new Peer(host?prefix+roomKey:prefix+id(),{debug:0,config:iceConfig()});const timeout=setTimeout(()=>{if(!joined)fail('Connection timed out. Check the room link and Network settings; a TURN relay may be required.');},30000);peer.on('open',p=>{me=p;if(host){roster.set(me,{id:me,name});clearTimeout(timeout);enter();}else{up=peer.connect(prefix+roomKey,{reliable:true,serialization:'json',metadata:{room:roomKey}});up.on('open',()=>send(up,{type:'hello',name}));up.on('data',m=>{if(m?.type==='welcome'){clearTimeout(timeout);applyRoster(m.roster);enter();applyShared(m.shared,m.shareKind);applyPermissions(m.permissions);setVoiceMode(m.voiceMode===true);if(m.movie)applyMovie(m.movie);if(m.browser)applyBrowser(m.browser);}else if(m?.type==='reject'){clearTimeout(timeout);fail(String(m.reason||'Room unavailable'));}else if(joined)handleGuest(m);});up.on('close',()=>{if(!leaving){status('Host disconnected');refreshAccess();notice('The host left or the connection was lost. Rejoin using the invite link.');}});up.on('error',()=>{if(!joined)fail('Could not connect to host. Try Network settings or a dedicated TURN relay.');});}});peer.on('connection',c=>{if(!host||c.metadata?.room!==roomKey){c.close();return;}let accepted=false;const timer=setTimeout(()=>{if(!accepted)c.close();},10000);c.on('data',m=>{if(!accepted){if(m?.type!=='hello')return;if(roster.size>=MAX||clients.has(c.peer)){send(c,{type:'reject',reason:'Room is full or already connected.'});setTimeout(()=>c.close(),500);return;}accepted=true;clearTimeout(timer);clients.set(c.peer,c);roster.set(c.peer,{id:c.peer,name:safeName(m.name)});send(c,{type:'welcome',roster:[...roster.values()],shared:activeScreen,shareKind:activeShareKind,movie:currentMovie(),permissions,browser:browserState,voiceMode});publishRoster();return;}handleHost(c.peer,m);});c.on('close',()=>{clearTimeout(timer);if(accepted&&clients.get(c.peer)===c){clients.delete(c.peer);roster.delete(c.peer);if(activeScreen===c.peer)setShared('');publishRoster();}});c.on('error',()=>c.close());});peer.on('call',acceptCall);peer.on('disconnected',()=>{status('Signaling interrupted');if(!leaving&&!peer.destroyed)try{peer.reconnect();}catch{}});peer.on('error',e=>{if(!joined){clearTimeout(timeout);fail(e.type==='peer-unavailable'?'Room not found. Ask the host to keep it open.':'Connection failed: '+(e.type||'unknown'));}else notice('Connection issue: '+(e.type||'unknown')+'. Some media may not connect.');});};
function fail(s){if(peer){leaving=true;peer.destroy();peer=null;leaving=false;}$('start').disabled=false;status('Ready');toast(s);}
function publishRoster(){const arr=[...roster.values()];broadcast({type:'roster',roster:arr});applyRoster(arr);}
function applyRoster(arr){if(!Array.isArray(arr)||arr.length>MAX)return;roster=new Map(arr.filter(x=>typeof x?.id==='string').map(x=>[x.id,{id:x.id,name:safeName(x.name),mic:x.mic===true}]));for(const [k,c] of out)if(!roster.has(c.peer)){c.close();out.delete(k);}for(const [k,c] of incoming)if(!roster.has(c.peer)){c.close();incoming.delete(k);streams.delete(k);}if(activeScreen&&!roster.has(activeScreen))applyShared('');renderPeople();publishMedia();}
function handleHost(who,m){if(!m||!roster.has(who))return;if(handleVoiceHost(who,m))return;if(handleRoomRequest(who,m))return;if(m.type==='chat'&&typeof m.text==='string'&&m.text.trim()){const msg={type:'chat',from:who,name:roster.get(who).name,text:m.text.trim().slice(0,1000)};displayChat(msg);broadcast(msg);}else if(m.type==='share'){if(m.on===true){if(activeScreen&&activeScreen!==who){if(who===me){stopShare(false);notice('Someone is already sharing.');}else send(clients.get(who),{type:'shareDenied'});return;}setShared(who,m.kind==='local'?'local':'screen');}else if(activeScreen===who)setShared('');}}
function handleGuest(m){if(!m)return;switch(m.type){case 'voiceMode':setVoiceMode(m.enabled===true);break;case 'voicePCM':if(voiceMode&&roster.has(m.from)&&m.from!==me)receivePCM(m.from,m.data);break;case 'retryVoiceFor':if(roster.has(m.target)&&m.target!==me)retryPeerMedia(m.target,'av');break;case 'roster':applyRoster(m.roster);break;case 'chat':displayChat(m);break;case 'shared':applyShared(m.id,m.kind);break;case 'retryScreenFor':if(activeScreen===me&&roster.has(m.target))retryPeerMedia(m.target,'screen');break;case 'permissions':applyPermissions(m.permissions);break;case 'browser':applyBrowser(m.url);break;case 'localPlaybackCommand':if(localPlayback&&activeScreen===me)executePlayback($('localMovie'),m.action);break;case 'shareDenied':stopShare(false);notice('Someone is already sharing.');break;case 'movie':applyMovie(m.state);break;}}
function displayChat(m){const item=document.createElement('div');item.className='msg'+(m.from===me?' self':'');const b=document.createElement('b'),d=document.createElement('div');b.textContent=m.from===me?'You':safeName(m.name);d.textContent=String(m.text||'').slice(0,1000);item.append(b,d);$('messages').append(item);while($('messages').children.length>250)$('messages').firstChild.remove();$('messages').scrollTop=$('messages').scrollHeight;}
$('chatForm').onsubmit=e=>{e.preventDefault();const input=$('message');if(input.value.trim()&&joined){toHost({type:'chat',text:input.value});input.value='';}};$('chatToggle').onclick=()=>{const closed=!$('chat').hidden;$('chat').hidden=closed;document.querySelector('.workspace').classList.toggle('no-chat',closed);$('chatToggle').setAttribute('aria-pressed',String(!closed));};
$('invite').onclick=async()=>{const link=inviteLink();try{await navigator.clipboard.writeText(link);toast('Invitation copied.');}catch{prompt('Share this private invitation:',link);}};
function key(p,t){return p+'|'+t;}
function sourceFor(kind){return kind==='screen'?localScreen:localAV;}
function hasSource(kind){return !!sourceFor(kind)?.getTracks().some(t=>t.readyState==='live');}
function clearRetry(k){const timer=retryTimers.get(k);if(timer)clearTimeout(timer);retryTimers.delete(k);}
function scheduleRetry(p,kind){const k=key(p,kind);if(leaving||!roster.has(p)||!hasSource(kind)||retryTimers.has(k))return;const attempts=retryAttempts.get(k)||0;if(attempts>=3){networkText('A media connection failed after retries. A dedicated TURN relay may be required.');return;}retryAttempts.set(k,attempts+1);retryTimers.set(k,setTimeout(()=>{retryTimers.delete(k);if(!out.has(k)&&roster.has(p)&&hasSource(kind))publishMedia();},1000*Math.pow(2,attempts)));}
function watchConnection(c,onFailure,onConnected){const pc=c.peerConnection;if(!pc)return;let failed=false,disconnectTimer,deadline;const good=()=>['connected','completed'].includes(pc.iceConnectionState)||pc.connectionState==='connected';const stop=()=>{clearTimeout(disconnectTimer);clearTimeout(deadline);pc.removeEventListener('iceconnectionstatechange',check);pc.removeEventListener('connectionstatechange',check);};function fail(){if(failed)return;failed=true;stop();onFailure();}function check(){if(good()){clearTimeout(disconnectTimer);clearTimeout(deadline);onConnected?.();return;}if(pc.iceConnectionState==='failed'||pc.connectionState==='failed'){fail();return;}if(pc.iceConnectionState==='disconnected'||pc.connectionState==='disconnected'){if(!disconnectTimer)disconnectTimer=setTimeout(()=>{if(!good())fail();},7000);}else{clearTimeout(disconnectTimer);disconnectTimer=null;}}deadline=setTimeout(()=>{if(!good())fail();},22000);pc.addEventListener('iceconnectionstatechange',check);pc.addEventListener('connectionstatechange',check);c.on('close',stop);c.on('error',stop);check();}
function publishMedia(){if(!peer?.open)return;for(const p of roster.keys()){if(p===me)continue;for(const kind of ['av','screen']){const k=key(p,kind),s=sourceFor(kind);if(!hasSource(kind)||out.has(k)||retryTimers.has(k))continue;try{const c=peer.call(p,s,{metadata:{room:roomKey,kind}});if(!c){scheduleRetry(p,kind);continue;}out.set(k,c);const failed=()=>{if(out.get(k)!==c)return;out.delete(k);try{c.close();}catch{}scheduleRetry(p,kind);};c.on('close',failed);c.on('error',failed);watchConnection(c,failed,()=>{retryAttempts.delete(k);clearRetry(k);});}catch{scheduleRetry(p,kind);}}}}
function retryPeerMedia(p,kind){if(!roster.has(p)||p===me||!hasSource(kind))return;const k=key(p,kind),c=out.get(k);clearRetry(k);retryAttempts.delete(k);if(c){out.delete(k);c.close();}publishMedia();}
function republish(kind){for(const k of [...retryTimers.keys()])if(k.endsWith('|'+kind))clearRetry(k);for(const k of [...retryAttempts.keys()])if(k.endsWith('|'+kind))retryAttempts.delete(k);for(const [k,c] of [...out])if(k.endsWith('|'+kind)){out.delete(k);c.close();}publishMedia();}
function acceptCall(c){const kind=c.metadata?.kind;if(c.metadata?.room!==roomKey||!['av','screen'].includes(kind)||!c.peer.startsWith(prefix)||!me){c.close();return;}const k=key(c.peer,kind),old=incoming.get(k);incoming.set(k,c);streams.delete(k);old?.close();c.on('stream',s=>{if(incoming.get(k)!==c)return;streams.set(k,s);if(kind==='screen'){autoplayBlocked=false;screenWaitAt=Date.now();}renderPeople();renderStage();});const clean=()=>{if(incoming.get(k)===c){incoming.delete(k);streams.delete(k);if(kind==='screen'&&activeScreen===c.peer){screenWaitAt=Date.now();autoplayBlocked=false;}renderPeople();renderStage();}};c.on('close',clean);c.on('error',clean);try{c.answer();watchConnection(c,()=>{clean();c.close();},()=>{});}catch{clean();c.close();}}
function play(v){try{const promise=v.play();if(promise)promise.then(()=>{if(v===ui.screen){autoplayBlocked=false;updateMediaOverlay();}}).catch(e=>{if(v===ui.screen&&v.srcObject&&e.name==='NotAllowedError'){autoplayBlocked=true;updateMediaOverlay();}});}catch{}}
function requestScreenRetry(){if(!joined)return;if(activeScreen&&activeScreen!==me){screenWaitAt=Date.now();screenRequestAt=Date.now();toHost({type:'mediaRetry'});}else if(activeScreen===me)republish('screen');republish('av');requestVoiceRetry();updateMediaOverlay();}
function updateMediaOverlay(){const remote=joined&&!!activeScreen&&activeScreen!==me;const overlay=$('mediaOverlay'),action=$('mediaOverlayAction'),label=$('mediaOverlayText');if(!remote){overlay.hidden=true;return;}const stream=streams.get(key(activeScreen,'screen'));const ready=!!stream&&ui.screen.readyState>=2&&!ui.screen.paused;overlay.hidden=ready&&!autoplayBlocked;if(overlay.hidden)return;if(autoplayBlocked){label.textContent='Video ready. Tap to start playback and sound.';action.textContent='Start playback';}else if(Date.now()-screenWaitAt>18000){label.textContent='Still waiting for video. Retry or configure a TURN relay in Network.';action.textContent='Retry connection';}else{label.textContent='Connecting to shared video…';action.textContent='Retry connection';}}
$('mediaOverlayAction').onclick=()=>{if(autoplayBlocked){play(ui.screen);return;}requestScreenRetry();};$('mediaRetry').onclick=requestScreenRetry;
ui.screen.addEventListener('playing',()=>{autoplayBlocked=false;updateMediaOverlay();});ui.screen.addEventListener('loadeddata',updateMediaOverlay);
async function selectedRoute(connection) {
  const pc = connection.peerConnection;
  if (!pc || !['connected', 'completed'].includes(pc.iceConnectionState)) return null;
  try {
    const stats = await pc.getStats();
    let pair;
    stats.forEach(stat => {
      if (stat.type === 'transport' && stat.selectedCandidatePairId) {
        pair = stats.get(stat.selectedCandidatePairId);
      }
    });
    if (!pair) stats.forEach(stat => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) pair = stat;
    });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return {
      relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
      configured: local?.candidateType === 'relay' && (
        activeNetwork.relayOnly || activeNetwork.turnUrls.includes(local.url)
      )
    };
  } catch {
    return null;
  }
}

function startNetworkWatch() {
  if (networkWatch) return;
  networkWatch = setInterval(async () => {
    if (!joined || leaving) return;
    updateMediaOverlay();
    updateVoiceStatus();
    checkVoiceRetry();
    if (activeScreen && activeScreen !== me && !streams.has(key(activeScreen, 'screen')) &&
      Date.now() - screenWaitAt > 12000 && Date.now() - screenRequestAt > 20000) {
      screenRequestAt = Date.now();
      toHost({type: 'mediaRetry'});
    }
    const media = [...out.values(), ...incoming.values()];
    const groups = [
      ['Room connection', up ? [up] : [...clients.values()]],
      ['Voice/camera', media.filter(connection => connection.metadata?.kind === 'av')],
      ['Shared video', media.filter(connection => connection.metadata?.kind === 'screen')]
    ];
    const summary = [];
    for (const [label, connections] of groups) {
      const routes = (await Promise.all(connections.map(selectedRoute))).filter(Boolean);
      if (!routes.length) continue;
      const relayed = routes.filter(route => route.relayed).length;
      const configured = routes.filter(route => route.configured).length;
      const counts = [];
      if (routes.length > relayed) counts.push((routes.length - relayed) + ' direct');
      if (configured) counts.push(configured + ' via configured TURN');
      if (relayed > configured) counts.push((relayed - configured) + ' relayed');
      summary.push(label + ': ' + counts.join(', '));
    }
    if (!leaving) networkText(summary.length ? summary.join(' · ') : networkLabel(activeNetwork));
  }, 3000);
}
function voiceElement(p){return [...$('voiceAudio').children].find(el=>el.dataset.id===p);}
function syncVoiceElement(p,s){let a=voiceElement(p);const tracks=s?.getAudioTracks().filter(t=>t.readyState==='live')||[];if(!tracks.length){if(a){a.srcObject=null;a.remove();}return;}if(!a){a=document.createElement('audio');a.autoplay=true;a.playsInline=true;a.dataset.id=p;a.addEventListener('playing',()=>{updateVoiceStatus();});$('voiceAudio').append(a);}if(!a.srcObject||a.srcObject.getAudioTracks().map(t=>t.id).join()!==tracks.map(t=>t.id).join())a.srcObject=new MediaStream(tracks);a.muted=voiceMode;a.volume=volumes.get(p)??1;if(!voiceMode&&a.paused)playVoice(a);}
function playVoice(a){if(voiceMode||!a?.srcObject)return;try{a.play().then(updateVoiceStatus).catch(e=>{if(e.name==='NotAllowedError'){voiceNeedsTap=true;updateVoiceStatus();}});}catch{}}
function renderPeople(){const root=$('people'),existing=new Map([...root.children].map(el=>[el.dataset.id,el]));for(const [p,person] of roster){let tile=existing.get(p);if(!tile){tile=document.createElement('div');tile.className='person';tile.dataset.id=p;const avatar=document.createElement('div');avatar.className='avatar';const v=document.createElement('video');v.autoplay=true;v.playsInline=true;v.muted=true;const n=document.createElement('span');n.className='name';const mic=document.createElement('span');mic.className='voice-indicator';tile.append(avatar,v,n,mic);if(p!==me){const range=document.createElement('input');range.type='range';range.min='0';range.max='1';range.step='.05';range.value=volumes.get(p)??1;range.className='vol';range.setAttribute('aria-label','Volume for '+person.name);range.oninput=()=>{const value=Number(range.value);volumes.set(p,value);const a=voiceElement(p);if(a)a.volume=value;const g=voiceGains.get(p);if(g)g.gain.value=value;};tile.append(range);}root.append(tile);}existing.delete(p);tile.querySelector('.avatar').textContent=person.name.charAt(0).toUpperCase();tile.querySelector('.name').textContent=p===me?name+' (you)':person.name;const s=p===me?localAV:streams.get(key(p,'av')),v=tile.querySelector('video'),tracks=s?.getVideoTracks().filter(t=>t.readyState==='live')||[];if(!tracks.length){if(v.srcObject)v.srcObject=null;}else if(!v.srcObject||v.srcObject.getVideoTracks().map(t=>t.id).join()!==tracks.map(t=>t.id).join()){v.srcObject=new MediaStream(tracks);play(v);}v.style.opacity=tracks.some(t=>t.enabled)?'1':'0';tile.querySelector('.voice-indicator').textContent=(p===me?localAV.getAudioTracks().some(t=>t.readyState==='live'):person.mic)?'MIC ON':'MIC OFF';if(p!==me)syncVoiceElement(p,s);}for(const el of existing.values())el.remove();for(const a of [...$('voiceAudio').children])if(!roster.has(a.dataset.id)){a.srcObject=null;a.remove();}for(const [p,g] of voiceGains)if(!roster.has(p)){g.disconnect();voiceGains.delete(p);voiceQueue.delete(p);voiceLast.delete(p);} $('count').textContent=roster.size+' / '+MAX;updateVoiceStatus();}
function localMic(){return localAV.getAudioTracks().some(t=>t.readyState==='live'&&t.enabled);}
function announceMic(){if(joined)toHost({type:'micState',on:localMic()});}
function handleVoiceHost(who,m){if(m.type==='micState'){const p=roster.get(who);if(p.mic!==(m.on===true)){p.mic=m.on===true;publishRoster();}return true;}if(m.type==='voicePCM'){if(!voiceMode||!roster.get(who)?.mic||!validPCM(m.data)||!allowVoicePacket(who))return true;if(who!==me)receivePCM(who,m.data);for(const [p,c] of clients)if(p!==who)sendVoice(c,{type:'voicePCM',from:who,data:m.data});return true;}if(m.type==='voiceRetry'){const p=m.target;if(typeof p!=='string'||p===who||!roster.has(p)||!roster.get(p).mic)return true;const k=who+'|'+p,now=Date.now();if(now-(voiceRequestAt.get(k)||0)<10000)return true;voiceRequestAt.set(k,now);if(p===me)retryPeerMedia(who,'av');else send(clients.get(p),{type:'retryVoiceFor',target:who});return true;}return false;}
function requestVoiceRetry(){if(!joined||voiceMode)return;for(const [p,person] of roster)if(p!==me&&person.mic)toHost({type:'voiceRetry',target:p});}
function checkVoiceRetry(){if(voiceMode)return;const now=Date.now();for(const [p,person] of roster){if(p===me||!person.mic)continue;const s=streams.get(key(p,'av'));if(s?.getAudioTracks().some(t=>t.readyState==='live'&&!t.muted))continue;const k='local|'+p;if(now-(voiceRequestAt.get(k)||0)>15000){voiceRequestAt.set(k,now);toHost({type:'voiceRetry',target:p});}}}
function updateVoiceStatus(){if(!joined)return;const expected=[...roster.values()].filter(p=>p.id!==me&&p.mic);const count=voiceMode?expected.filter(p=>Date.now()-(voiceLast.get(p.id)||0)<2500).length:expected.filter(p=>{const a=voiceElement(p.id);return a?.srcObject?.getAudioTracks().some(t=>t.readyState==='live'&&!t.muted)&&!a.paused&&!a.muted;}).length;const needs=voiceMode?(voiceContext?.state!=='running'):expected.some(p=>{const a=voiceElement(p.id);return a?.srcObject&&a.paused;});$('enableSound').hidden=!(needs||voiceNeedsTap);$('voiceStatus').textContent=(voiceMode?'Compatibility voice · ':'WebRTC voice · ')+(localMic()?'Mic on':'Mic off')+' · '+(expected.length?count+'/'+expected.length+' remote audio streams':'No remote mics on')+(needs?' · Tap Enable sound':'');}
function validPCM(s){return typeof s==='string'&&s.length>=4&&s.length<=5500&&s.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(s);}
function allowVoicePacket(p){const now=Date.now(),old=voiceRate.get(p);if(!old||now-old.at>=1000){voiceRate.set(p,{at:now,count:1});return true;}return ++old.count<=45;}
function sendVoice(c,m){if(!c?.open)return;const channel=c.dataChannel;if(channel&&channel.bufferedAmount>24000)return;send(c,m);}
function getVoiceContext(){if(!voiceContext){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw Error('Web Audio is unavailable.');voiceContext=new AC();voiceContext.onstatechange=updateVoiceStatus;}return voiceContext;}
function stopVoiceCapture(){if(voiceProcessor){voiceProcessor.onaudioprocess=null;try{voiceProcessor.disconnect();}catch{}}try{voiceInput?.disconnect();voiceSilent?.disconnect();}catch{}voiceInput=voiceProcessor=voiceSilent=voiceTrack=null;}
function pcmEncode(samples,rate){const n=Math.floor(samples.length*16000/rate),bytes=new Uint8Array(n*2),dv=new DataView(bytes.buffer);for(let i=0;i<n;i++){const from=Math.floor(i*rate/16000),to=Math.min(samples.length,Math.max(from+1,Math.floor((i+1)*rate/16000)));let sum=0;for(let k=from;k<to;k++)sum+=samples[k];const v=Math.max(-1,Math.min(1,sum/(to-from)));dv.setInt16(i*2,Math.round(v*(v<0?32768:32767)),true);}let str='';for(const b of bytes)str+=String.fromCharCode(b);return btoa(str);}
function startVoiceCapture(){const t=localAV.getAudioTracks().find(x=>x.readyState==='live'&&x.enabled);if(!voiceMode||!t){stopVoiceCapture();return;}if(voiceTrack===t&&voiceProcessor)return;stopVoiceCapture();try{const ctx=getVoiceContext();if(ctx.state!=='running'){voiceNeedsTap=true;updateVoiceStatus();}voiceInput=ctx.createMediaStreamSource(new MediaStream([t]));voiceProcessor=ctx.createScriptProcessor(2048,1,1);voiceSilent=ctx.createGain();voiceSilent.gain.value=0;voiceInput.connect(voiceProcessor);voiceProcessor.connect(voiceSilent);voiceSilent.connect(ctx.destination);voiceTrack=t;voiceProcessor.onaudioprocess=e=>{if(!voiceMode||!localMic()||ctx.state!=='running'||leaving)return;const data=pcmEncode(e.inputBuffer.getChannelData(0),e.inputBuffer.sampleRate);if(!validPCM(data))return;const m={type:'voicePCM',data};if(host)handleVoiceHost(me,m);else sendVoice(up,m);};}catch(e){stopVoiceCapture();notice('Compatibility voice unavailable: '+e.message);}}
function clearVoicePlayback(){for(const src of voiceSources)try{src.stop();}catch{}voiceSources.clear();for(const g of voiceGains.values())g.disconnect();voiceGains.clear();voiceQueue.clear();voiceLast.clear();}
function receivePCM(p,data){if(!voiceMode||!validPCM(data)||p===me)return;try{const ctx=getVoiceContext();if(ctx.state!=='running'){voiceNeedsTap=true;updateVoiceStatus();return;}const raw=atob(data);if(raw.length%2||raw.length>4096)return;const buf=ctx.createBuffer(1,raw.length/2,16000),samples=buf.getChannelData(0);for(let i=0;i<samples.length;i++){let x=raw.charCodeAt(2*i)|(raw.charCodeAt(2*i+1)<<8);if(x&32768)x-=65536;samples[i]=x/32768;}let g=voiceGains.get(p);if(!g){g=ctx.createGain();g.gain.value=volumes.get(p)??1;g.connect(ctx.destination);voiceGains.set(p,g);}const now=ctx.currentTime,previous=voiceQueue.get(p)||0;if(previous>now+.35)return;const at=Math.max(now+.065,previous);const src=ctx.createBufferSource();src.buffer=buf;src.connect(g);voiceSources.add(src);src.onended=()=>{voiceSources.delete(src);src.disconnect();};src.start(at);voiceQueue.set(p,at+buf.duration);voiceLast.set(p,Date.now());}catch{}}
function setVoiceMode(on){voiceMode=!!on;voiceNeedsTap=false;clearVoicePlayback();$('voiceCompat').setAttribute('aria-pressed',String(voiceMode));$('voiceCompat').textContent='Voice compatibility: '+(voiceMode?'on':'off');for(const a of $('voiceAudio').children){a.muted=voiceMode;if(voiceMode)a.pause();else playVoice(a);}if(voiceMode){try{getVoiceContext();}catch(e){notice(e.message);}startVoiceCapture();}else stopVoiceCapture();updateVoiceStatus();}
function enableSound(){voiceNeedsTap=false;try{const ctx=voiceMode?getVoiceContext():voiceContext;if(ctx)ctx.resume().then(()=>{if(voiceMode)startVoiceCapture();updateVoiceStatus();}).catch(()=>{voiceNeedsTap=true;updateVoiceStatus();});}catch{}if(!voiceMode)for(const a of $('voiceAudio').children)playVoice(a);updateVoiceStatus();}
$('enableSound').onclick=enableSound;$('voiceCompat').onclick=()=>{if(!host||!joined)return;setVoiceMode(!voiceMode);broadcast({type:'voiceMode',enabled:voiceMode});if(voiceMode)enableSound();toast(voiceMode?'Compatibility voice enabled. Guests may need to tap Enable sound.':'Standard WebRTC voice restored.');};
async function toggleAV(kind){if(!joined)return;const btn=kind==='audio'?$('mic'):$('cam');btn.disabled=true;enableSound();try{const current=localAV.getTracks().find(t=>t.kind===kind);if(current){localAV.removeTrack(current);current.stop();}else{if(!navigator.mediaDevices?.getUserMedia)throw Error('Media devices unavailable');const s=await navigator.mediaDevices.getUserMedia(kind==='audio'?{audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}}:{video:{width:{ideal:640},height:{ideal:360},frameRate:{ideal:24}}});const t=s.getTracks()[0];localAV.addTrack(t);t.onended=()=>{localAV.removeTrack(t);updateAV();announceMic();startVoiceCapture();republish('av');renderPeople();};}updateAV();announceMic();startVoiceCapture();republish('av');renderPeople();}catch(e){notice('Could not access '+kind+': '+e.message);}finally{btn.disabled=false;}}
function updateAV(){for(const [kind,id,label] of [['audio','mic','Mic'],['video','cam','Camera']]){const on=localAV.getTracks().some(t=>t.kind===kind&&t.readyState==='live');$(id).textContent=label+(on?' on':' off');$(id).setAttribute('aria-pressed',String(on));}}$('mic').onclick=()=>toggleAV('audio');$('cam').onclick=()=>toggleAV('video');
function setShared(who,kind='screen'){activeScreen=who;activeShareKind=kind;broadcast({type:'shared',id:who,kind});applyShared(who,kind);}function applyShared(who,kind='screen'){if(who!==activeScreen||!screenWaitAt){screenWaitAt=Date.now();screenRequestAt=0;autoplayBlocked=false;}activeScreen=typeof who==='string'?who:'';activeShareKind=kind==='local'?'local':'screen';renderStage();refreshAccess();}
async function share(){if(pendingLocal){stopShare(false);return;}if(localScreen){stopShare();return;}if(activeScreen){toast('Someone is already sharing.');return;}if(!navigator.mediaDevices?.getDisplayMedia){notice('Screen sharing is unavailable on this browser. Use desktop Chrome or Edge.');return;}try{localScreen=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:true});localScreen.getVideoTracks()[0].onended=()=>stopShare();toHost({type:'share',on:true});if(!localScreen)return;$('share').textContent='Stop sharing';$('share').setAttribute('aria-pressed','true');publishMedia();renderStage();if(!localScreen.getAudioTracks().length)notice('Screen shared without audio. Choose a browser tab and enable share audio.');}catch(e){notice('Screen share not started: '+e.message);}}
function stopShare(notify=true){const s=localScreen;localScreen=null;const wasLocal=localPlayback||pendingLocal;localPlayback=false;pendingLocal=false;if(s)s.getTracks().forEach(t=>{t.onended=null;t.stop();});if(wasLocal){const v=$('localMovie');v.pause();v.removeAttribute('src');v.load();if(localURL){URL.revokeObjectURL(localURL);localURL='';}$('localLabel').textContent='Local video';$('localLabel').setAttribute('aria-pressed','false');}republish('screen');$('share').textContent='Share screen';$('share').setAttribute('aria-pressed','false');if(notify&&s)toHost({type:'share',on:false});renderStage();}$('share').onclick=share;$('emptyShare').onclick=share;
function renderStage(){const ownLocal=(localPlayback||pendingLocal)&&(!activeScreen||activeScreen===me);const s=activeScreen===me?localScreen:streams.get(key(activeScreen,'screen'));const sharing=!!activeScreen||ownLocal;const browsing=!sharing&&!!browserState;$('browserStage').hidden=!browsing;$('localMovie').hidden=!ownLocal;ui.screen.hidden=ownLocal||!sharing||!s;ui.movie.hidden=sharing||browsing||!movieState;$('empty').hidden=ownLocal||browsing||(sharing&&!!s)||(!sharing&&!!movieState);const displayStream=ownLocal?null:s||null;if(ui.screen.srcObject!==displayStream){ui.screen.srcObject=displayStream;ui.screen.muted=activeScreen===me;if(displayStream){ui.screen.playsInline=true;ui.screen.autoplay=true;play(ui.screen);}}if(sharing&&!s&&!ownLocal){$('empty').querySelector('h2').textContent='Connecting to shared screen…';}else $('empty').querySelector('h2').textContent='Make it movie night.';if((sharing||browsing)&&!ui.movie.paused)ui.movie.pause();refreshAccess();updateMediaOverlay();}

function chooseLocal(){if(!joined)return;if(localPlayback||pendingLocal){stopShare();return;}if(localScreen||activeScreen){toast('Stop the current share first.');return;}$('localFile').click();}
$('localLabel').onclick=chooseLocal;$('emptyLocal').onclick=chooseLocal;
$('localFile').onchange=async()=>{const file=$('localFile').files[0];$('localFile').value='';if(!file||!joined||localScreen||activeScreen||pendingLocal)return;const v=$('localMovie'),capture=v.captureStream||v.mozCaptureStream;if(!capture){notice('Local video streaming is unavailable in this browser. Use desktop Chrome or Edge.');return;}pendingLocal=true;const url=URL.createObjectURL(file);localURL=url;v.src=url;v.volume=Number($('movieVolume').value);renderStage();$('localLabel').textContent='Loading video…';try{await new Promise((resolve,reject)=>{if(v.readyState>=2){resolve();return;}const timer=setTimeout(()=>{cleanup();reject(Error('Video did not load'));},15000);function cleanup(){clearTimeout(timer);v.removeEventListener('loadeddata',ready);v.removeEventListener('error',bad);}function ready(){cleanup();resolve();}function bad(){cleanup();reject(Error('Unsupported format. Try MP4 (H.264/AAC) or WebM.'));}v.addEventListener('loadeddata',ready,{once:true});v.addEventListener('error',bad,{once:true});});if(!pendingLocal||localURL!==url)return;if(activeScreen){stopShare(false);notice('Another participant started sharing.');return;}const stream=capture.call(v);if(!stream.getVideoTracks().length){v.play().catch(()=>{});await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);stream.removeEventListener('addtrack',check);resolve();};const check=()=>{if(stream.getVideoTracks().length)done();};timer=setTimeout(done,2500);stream.addEventListener('addtrack',check);check();});}if(!pendingLocal||localURL!==url){stream.getTracks().forEach(t=>t.stop());return;}if(!stream.getVideoTracks().length){stream.getTracks().forEach(t=>t.stop());throw Error('Cannot capture video. Try desktop Chrome or Edge.');}if(activeScreen){stream.getTracks().forEach(t=>t.stop());stopShare(false);return;}localScreen=stream;localPlayback=true;pendingLocal=false;const changed=()=>{if(localScreen===stream)republish('screen');};stream.addEventListener('addtrack',changed);stream.addEventListener('removetrack',changed);toHost({type:'share',on:true,kind:'local'});if(!localScreen)return;$('share').textContent='Stop sharing';$('share').setAttribute('aria-pressed','true');$('localLabel').textContent='Stop local video';$('localLabel').setAttribute('aria-pressed','true');publishMedia();renderStage();v.play().catch(()=>toast('Press play on the movie.'));notice(stream.getAudioTracks().length?'Local video is streaming directly to the room. No upload.':'No audio track captured. Check the file or browser.');}catch(e){if(localURL===url){stopShare(false);notice(e.message||'Could not play video.');}}};

function canPlayback(){return host||permissions.playback===true;}
function canBrowse(){return host||permissions.browse===true;}
function applyPermissions(p){permissions={playback:p?.playback===true,browse:p?.browse===true};refreshAccess();}
function refreshAccess(){const browse=canBrowse(), playback=canPlayback(), connected=joined&&(host||!!up?.open);$('permissionsToggle').hidden=!host;$('allowPlayback').checked=permissions.playback;$('allowBrowse').checked=permissions.browse;$('browserURL').disabled=!browse||!connected;$('browserGo').disabled=!browse||!connected;$('browserReload').disabled=!browse||!connected||!browserState;$('browserClose').disabled=!browse||!connected||!browserState;$('browserLock').hidden=browse;$('browserFrame').inert=!browse;$('browserFrame').tabIndex=browse?0:-1;$('browserFrame').style.pointerEvents=browse?'auto':'none';$('browserExternal').hidden=!browse||!browserState;$('permissionStatus').textContent=host?'Host':(permissions.playback?'Playback allowed':'Playback locked')+' · '+(permissions.browse?'Browser allowed':'Browser locked');const playable=activeScreen?activeShareKind==='local':!!movieState&&!browserState;const own=localPlayback&&activeScreen===me;$('sharedControls').hidden=!(playable&&(playback||own));$('roomPlay').disabled=!connected||!(playback||own);$('roomPause').disabled=!connected||!(playback||own);}
$('permissionsToggle').onclick=()=>{if(!host)return;const panel=$('permissionsPanel');panel.hidden=!panel.hidden;$('permissionsToggle').setAttribute('aria-expanded',String(!panel.hidden));};
function changePermissions(){if(!host||!joined)return;applyPermissions({playback:$('allowPlayback').checked,browse:$('allowBrowse').checked});broadcast({type:'permissions',permissions});toast('Guest permissions updated.');}
$('allowPlayback').onchange=changePermissions;$('allowBrowse').onchange=changePermissions;
function browserURL(v){const u=validURL(v);if(!u||u.length>2048)return '';try{if(new URL(u).origin===location.origin)return '';return u;}catch{return '';}}
function selectBrowser(on){browserSelected=on;$('browserBar').hidden=!on;$('videoBar').hidden=on;$('browserMode').setAttribute('aria-pressed',String(on));$('videoMode').setAttribute('aria-pressed',String(!on));refreshAccess();}
function applyBrowser(raw){const url=raw?browserURL(raw):'';const changed=browserState!==url;browserState=url;const frame=$('browserFrame');if(changed){if(url)frame.src=url;else frame.removeAttribute('src');}if(url){$('browserURL').value=url;$('browserExternal').href=url;selectBrowser(true);}else{if(changed)$('browserURL').value='';$('browserExternal').removeAttribute('href');}renderStage();}
function setBrowser(url){if(!host)return;if(url&&movieState){movieState=null;ui.movie.pause();ui.movie.removeAttribute('src');ui.movie.load();broadcast({type:'movie',state:null});}applyBrowser(url);broadcast({type:'browser',url});}
function executePlayback(v,action){if(action==='pause')v.pause();else if(action==='play')v.play().catch(()=>notice('Playback requires a tap on the video on the sender device.'));}
function handleRoomRequest(who,m){if(!host)return false;const owner=who===me;if(m.type==='mediaRetry'){if(!activeScreen||activeScreen===who)return true;const now=Date.now();if(now-(lastMediaRequest.get(who)||0)<5000)return true;lastMediaRequest.set(who,now);if(activeScreen===me)retryPeerMedia(who,'screen');else send(clients.get(activeScreen),{type:'retryScreenFor',target:who});return true;}
if(m.type==='browserRequest'){if(!(owner||permissions.browse)){if(!owner)send(clients.get(who),{type:'permissions',permissions});return true;}if(m.url===''){setBrowser('');return true;}const url=typeof m.url==='string'?browserURL(m.url):'';if(!url||activeScreen)return true;setBrowser(url);return true;}
if(m.type==='playbackRequest'){if(!['play','pause'].includes(m.action))return true;const sourceOwn=activeScreen===who&&activeShareKind==='local';if(!(owner||permissions.playback||sourceOwn))return true;if(activeScreen){if(activeShareKind!=='local')return true;if(activeScreen===me){if(localPlayback)executePlayback($('localMovie'),m.action);}else send(clients.get(activeScreen),{type:'localPlaybackCommand',action:m.action});}else if(movieState&&!browserState){executePlayback(ui.movie,m.action);syncMovie();}return true;}return false;}
$('browserMode').onclick=()=>selectBrowser(true);$('videoMode').onclick=()=>selectBrowser(false);$('browserLocal').onclick=()=>{selectBrowser(false);chooseLocal();};$('browserShare').onclick=share;
$('browserForm').onsubmit=e=>{e.preventDefault();if(!canBrowse())return;const url=browserURL($('browserURL').value);if(!url){toast('Enter a valid external HTTPS website address.');return;}if(activeScreen||pendingLocal){toast('Stop the current share before browsing.');return;}toHost({type:'browserRequest',url});};
$('browserReload').onclick=()=>{if(canBrowse()&&browserState)$('browserFrame').src=browserState;};
$('browserClose').onclick=()=>{if(canBrowse())toHost({type:'browserRequest',url:''});};
$('roomPlay').onclick=()=>toHost({type:'playbackRequest',action:'play'});$('roomPause').onclick=()=>toHost({type:'playbackRequest',action:'pause'});
function validURL(v){try{const u=new URL(v);return u.protocol==='https:'&& !u.username&&!u.password?u.href:'';}catch{return '';}}
function currentMovie(){if(!movieState?.url)return null;return {...movieState,time:ui.movie.currentTime||0,paused:ui.movie.paused,rate:ui.movie.playbackRate||1,at:Date.now()};}
function syncMovie(){if(host&&!applying&&movieState&&movieState.url){movieState=currentMovie();broadcast({type:'movie',state:movieState});}}function loadMovie(url){if(browserState)setBrowser('');selectBrowser(false);movieState={url,time:0,paused:true,rate:1,at:Date.now()};ui.movie.src=url;ui.movie.controls=true;renderStage();syncMovie();play(ui.movie);}
$('mediaForm').onsubmit=e=>{e.preventDefault();if(!host)return;const url=validURL($('mediaURL').value);if(!url){toast('Use a direct HTTPS video link.');return;}if(activeScreen){toast('Stop screen sharing before playing a video.');return;}if(localPlayback||pendingLocal){toast('Stop local playback first.');return;}loadMovie(url);};
function applyMovie(state){if(host)return;if(state?.url&&browserState)applyBrowser('');if(!state?.url||!validURL(state.url)){movieState=null;ui.movie.pause();ui.movie.removeAttribute('src');ui.movie.load();renderStage();return;}const changed=movieState?.url!==state.url;movieState=state;applying=true;clearTimeout(applyTimer);if(changed){ui.movie.src=state.url;ui.movie.controls=false;}const adjust=()=>{if(movieState!==state)return;const lag=state.paused?0:Math.min(5,Math.max(0,(Date.now()-Number(state.at||Date.now()))/1000));const target=Math.max(0,Number(state.time||0)+lag*Number(state.rate||1));if(Number.isFinite(target)&&Math.abs(ui.movie.currentTime-target)>.65)try{ui.movie.currentTime=target;}catch{}ui.movie.playbackRate=Math.min(2,Math.max(.5,Number(state.rate)||1));if(state.paused||activeScreen)ui.movie.pause();else ui.movie.play().catch(()=>notice('Tap the video to allow playback.'));};if(ui.movie.readyState>=1)adjust();else ui.movie.addEventListener('loadedmetadata',adjust,{once:true});applyTimer=setTimeout(()=>applying=false,800);renderStage();}
for(const event of ['play','pause','seeked','ratechange','ended'])ui.movie.addEventListener(event,syncMovie);setInterval(()=>{if(host&&joined&&movieState?.url&&!ui.movie.paused)syncMovie();},3000);ui.movie.onclick=()=>{if(!host&&movieState&&!movieState.paused)play(ui.movie);};ui.movie.onerror=()=>notice('Video could not load. Use a direct MP4/WebM link or screen sharing.');$('movieVolume').oninput=()=>{ui.movie.volume=Number($('movieVolume').value);ui.screen.volume=Number($('movieVolume').value);$('localMovie').volume=Number($('movieVolume').value);};$('fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen?.();else if($('stage').requestFullscreen)$('stage').requestFullscreen().catch(()=>toast('Fullscreen unavailable'));else if(!$('localMovie').hidden)$('localMovie').webkitEnterFullscreen?.();else if(!ui.movie.hidden)ui.movie.webkitEnterFullscreen?.();else if(!ui.screen.hidden)ui.screen.webkitEnterFullscreen?.();};
$('leave').onclick=()=>{leaving=true;stopShare(false);localAV.getTracks().forEach(t=>t.stop());clearInterval(networkWatch);stopVoiceCapture();clearVoicePlayback();peer?.destroy();location.href=new URL('./',location.href).href;};window.addEventListener('pagehide',()=>{leaving=true;stopVoiceCapture();clearVoicePlayback();localScreen?.getTracks().forEach(t=>t.stop());localAV.getTracks().forEach(t=>t.stop());peer?.destroy();});document.addEventListener('pointerdown',()=>{for(const v of document.querySelectorAll('video'))if(v.srcObject&&v.paused)play(v);});let installPrompt=null;const installButton=$('install'),installHelp=$('installHelp');const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;async function installFrame(){if(standalone()){toast('Frame is already installed.');return;}if(!installPrompt){toast(/Android/i.test(navigator.userAgent)?'Chrome menu ⋮ → Install app or Add to Home screen.':'Use Chrome or Edge browser menu to install Frame.');return;}try{const p=installPrompt;installPrompt=null;await p.prompt();const result=await p.userChoice;if(result.outcome==='accepted')installButton.hidden=true;}catch{toast('Use the browser menu to install Frame.');}}window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;installButton.hidden=false;});window.addEventListener('appinstalled',()=>{installButton.hidden=true;installHelp.hidden=true;installPrompt=null;});installButton.onclick=installFrame;installHelp.onclick=installFrame;installButton.hidden=standalone();installHelp.hidden=standalone();if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});
