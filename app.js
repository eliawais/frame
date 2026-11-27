'use strict';
const $=id=>document.getElementById(id), ui={landing:$('landing'),room:$('room'),status:$('status'),notice:$('notice'),movie:$('movie'),screen:$('screenVideo')};
const MAX=6, prefix='erev-beta-v2-', tokenRE=/^(?:[a-f0-9]{32}|[0-9a-hjkmnp-tv-z]{16})$/;let permissions={playback:false,browse:false,seek:false},browserState='',browserSelected=false,activeShareKind='screen';let peer,roomKey='',roomSlug='',signalingCode='',joining=false,me='',name='',host=false,up=null,roster=new Map(),clients=new Map(),out=new Map(),incoming=new Map(),streams=new Map(),volumes=new Map(),localAV=new MediaStream(),localScreen=null,activeScreen='',movieState=null,applying=false,applyTimer,toastTimer,localURL='',localPlayback=false,pendingLocal=false,joined=false,leaving=false;
let voiceMode=false,voiceContext=null,voiceInput=null,voiceProcessor=null,voiceSilent=null,voiceTrack=null,voiceNeedsTap=false;const voiceQueue = new Map(), voiceGains = new Map(), voiceSources = new Map();
const voiceRate = new Map(), voiceLast = new Map(), voiceRequestAt = new Map();
const voiceMissingSince = new Map(), voiceBackup = new Set(), voiceWarmUntil = new Map();
const voiceSubscribers = new Map(), voiceCaptureRequested = new Set();
let voiceSending = false, voicePreferBackup = false;const retryAttempts=new Map(), retryTimers=new Map(), lastMediaRequest=new Map();let networkWatch=null, screenRequestAt=0, autoplayBlocked=false, screenWaitAt=0;
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
const webPeerPattern = /^erev-beta-v2-[a-f0-9]{32}$/;
const proofNoncePattern = /^[a-f0-9]{32}$/;
const publicKeyPattern = /^B[A-Za-z0-9_-]{86}$/;
const proofPattern = /^[A-Za-z0-9_-]{86}$/;
const ecKey = {name:'ECDSA',namedCurve:'P-256'};
const ecSignature = {name:'ECDSA',hash:'SHA-256'};
let roomAccessState = null;

function roomProofBytes(purpose, from, to, nonce, time = 0) {
  return new TextEncoder().encode(JSON.stringify([purpose, signalingCode, from, to, nonce, time]));
}

function encodeRoomProof(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function decodeRoomProof(value, padding) {
  return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/') + padding), ch=>ch.charCodeAt(0));
}

async function signRoomProof(access, purpose, from, to, nonce, time) {
  return encodeRoomProof(await crypto.subtle.sign(ecSignature, access.privateKey, roomProofBytes(purpose, from, to, nonce, time)));
}

async function verifyRoomProof(access, purpose, from, to, nonce, proof, time) {
  if (access !== roomAccessState || Date.now() >= access.deadline || !webPeerPattern.test(from) ||
      !proofNoncePattern.test(nonce || '') || !proofPattern.test(proof || '')) return false;
  const member = access.members.get(from);
  if (!member) return false;
  try {
    member.verifier ??= crypto.subtle.importKey('raw', decodeRoomProof(member.publicKey, '='), ecKey, false, ['verify']);
    const valid = await crypto.subtle.verify(ecSignature, await member.verifier, decodeRoomProof(proof, '=='),
      roomProofBytes(purpose, from, to, nonce, time));
    return valid && access === roomAccessState && Date.now() < access.deadline && access.members.get(from)?.publicKey === member.publicKey;
  } catch {
    return false;
  }
}

function roomRequest(body, options = {}) {
  return fetch('./api/rooms', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),...options});
}

function releaseRoomAccess() {
  const access = roomAccessState;
  if (!access) return;
  roomAccessState = null;
  clearInterval(access.timer);
  roomRequest({action:'leave',code:access.code,peerId:access.peerId},{keepalive:true}).catch(()=>{});
}

function endRoomAccess(message) {
  if (!joined) { fail(message); return; }
  leaving = true;
  releaseRoomAccess();
  stopShare(false);
  localAV.getTracks().forEach(track=>track.stop());
  stopVoiceCapture();
  clearVoicePlayback();
  peer?.destroy();
  ui.room.hidden = true;
  status('Room ended');
  notice(message);
  toast(message);
  location.replace('/');
}

function syncRoomAccess(access) {
  if (!access || access !== roomAccessState) return Promise.resolve(false);
  if (access.pending) return access.pending;
  access.pending = (async()=>{
    const requestAt = Date.now();
    try {
      const response = await roomRequest({action:'sync',code:access.code,peerId:access.peerId},{signal:AbortSignal.timeout(8000)});
      if (access !== roomAccessState) return false;
      if (response.status === 401 || response.status === 403) {
        endRoomAccess('Your room access ended. Sign in or ask the host for a fresh invite.');
        return false;
      }
      if (!response.ok) return false;
      const result = await response.json();
      if (access !== roomAccessState || !Number.isFinite(result.leaseMs) || !Number.isFinite(result.serverTime) ||
          !Array.isArray(result.members)) return false;
      const members = new Map();
      for (const member of result.members) {
        if (!webPeerPattern.test(member?.peerId || '') || !publicKeyPattern.test(member?.publicKey || '')) return false;
        const cached = access.members.get(member.peerId);
        members.set(member.peerId, cached?.publicKey === member.publicKey ? cached : {publicKey:member.publicKey});
      }
      if (!members.has(access.peerId) || members.get(access.hostPeerId)?.publicKey !== access.hostKey) return false;
      access.members = members;
      access.deadline = requestAt + Math.min(60_000,result.leaseMs);
      access.clockOffset = result.serverTime - Date.now();
      for (const connection of [...clients.values(), ...out.values(), ...incoming.values()]) {
        if (!members.has(connection.peer)) connection.close();
      }
      if (joined) publishMedia();
      return true;
    } catch {
      return false;
    }
  })().finally(()=>{access.pending=null;});
  return access.pending;
}

function watchRoomAccess(access) {
  access.timer = setInterval(()=>{
    if (access !== roomAccessState) { clearInterval(access.timer); return; }
    if (Date.now() >= access.deadline) {
      endRoomAccess('Room access expired. Rejoin to continue.');
      return;
    }
    if (joined) syncRoomAccess(access);
  },15_000);
}

document.addEventListener('visibilitychange',()=>{
  if (!document.hidden && joined && roomAccessState) syncRoomAccess(roomAccessState);
});

function connectToHost(access, timeout) {
  const connection = peer.connect(access.hostPeerId, {reliable:true,serialization:'json',metadata:{room:signalingCode}});
  up = connection;
  const guestNonce = id();
  let challenged = false;
  let queue = Promise.resolve();
  connection.on('data', message=>{
    queue = queue.then(async()=>{
      if (access !== roomAccessState || !message || Date.now() >= access.deadline) return;
      if (joined) { handleGuest(message); return; }
      if (message.type === 'reject') { clearTimeout(timeout); fail('The host could not admit you to the room.'); return; }
      if (message.type === 'challenge' && !challenged && proofNoncePattern.test(message.nonce || '')) {
        challenged = true;
        const proof = await signRoomProof(access,'guest',me,connection.peer,message.nonce);
        if (access === roomAccessState) send(connection,{type:'hello',nonce:guestNonce,proof,name,roomScreen:true,roomVoice:true});
        return;
      }
      if (message.type !== 'welcome' || !challenged) return;
      if (!await verifyRoomProof(access,'host',connection.peer,me,guestNonce,message.proof) || !await syncRoomAccess(access)) {
        if (access === roomAccessState) fail('Could not verify the host. Rejoin with a new invite.');
        return;
      }
      if (message.roomScreen === true) roomScreenSupport.add(connection);
      if (message.roomVoice === true) roomVoiceSupport.add(connection);
      clearTimeout(timeout);
      applyRoster(message.roster);
      enter();
      applyShared(message.shared,message.shareKind);
      applyLocalTimeline(message.timeline);
      applyPermissions(message.permissions);
      setVoiceMode(message.voiceMode === true);
      if (message.movie) applyMovie(message.movie);
      if (message.browser) applyBrowser(message.browser);
    }).catch(()=>{if (access === roomAccessState && !joined) fail('Could not verify the host.');});
  });
  connection.on('close',()=>{
    if (leaving || access !== roomAccessState) return;
    if (!joined) { clearTimeout(timeout); fail('The host connection closed. Try joining again.'); return; }
    endRoomAccess('The host left or the connection was lost. Rejoin using a current invite.');
  });
  connection.on('error',()=>{if (!joined && access === roomAccessState) fail('Could not connect to host. Try Network settings or a dedicated TURN relay.');});
}

function admitGuest(connection, access) {
  if (!host || !joined || access !== roomAccessState || connection.metadata?.room !== signalingCode ||
      !webPeerPattern.test(connection.peer) || connection.peer === me) { connection.close(); return; }
  let accepted = false;
  let checking = false;
  const nonce = id();
  const timer = setTimeout(()=>{if(!accepted)connection.close();},10_000);
  connection.on('open',()=>send(connection,{type:'challenge',nonce}));
  connection.on('data',async message=>{
    if (access !== roomAccessState || Date.now() >= access.deadline) { connection.close(); return; }
    if (accepted) { if (access.members.has(connection.peer)) handleHost(connection.peer,message); return; }
    if (checking || message?.type !== 'hello' || !proofNoncePattern.test(message.nonce || '')) return;
    checking = true;
    try {
      const current = await syncRoomAccess(access);
      const valid = current && await verifyRoomProof(access,'guest',connection.peer,me,nonce,message.proof);
      if (!valid || !connection.open || roster.size >= MAX || clients.has(connection.peer)) {
        send(connection,{type:'reject'});
        setTimeout(()=>connection.close(),300);
        return;
      }
      const proof = await signRoomProof(access,'host',me,connection.peer,message.nonce);
      if (!connection.open || access !== roomAccessState || !access.members.has(connection.peer) ||
          roster.size >= MAX || clients.has(connection.peer)) { connection.close(); return; }
      accepted = true;
      clearTimeout(timer);
      if (message.roomScreen === true) roomScreenSupport.add(connection);
      if (message.roomVoice === true) roomVoiceSupport.add(connection);
      clients.set(connection.peer,connection);
      roster.set(connection.peer,{id:connection.peer,name:safeName(message.name)});
      send(connection,{type:'welcome',proof,roster:[...roster.values()],shared:activeScreen,shareKind:activeShareKind,movie:currentMovie(),
        permissions,browser:browserState,voiceMode,roomScreen:true,roomVoice:true,timeline:localTimeline});
      publishRoster();
      connectRoomVoice(connection.peer);
    }catch{connection.close();}
  });
  connection.on('close',()=>{
    clearTimeout(timer);
    if (!accepted || clients.get(connection.peer) !== connection) return;
    clients.delete(connection.peer);
    roster.delete(connection.peer);
    removeVoiceParticipant(connection.peer);
    if (activeScreen === connection.peer) setShared('');
    publishRoster();
  });
  connection.on('error',()=>connection.close());
}

$('joinForm').onsubmit=async event=>{
  event.preventDefault();
  if (peer || joining) return;
  const requested = parseRoom($('roomInput').value);
  if ($('roomInput').value.trim() && !tokenRE.test(requested)) { toast('Invalid room link or code.'); return; }
  if (!window.Peer) { toast('Signaling library unavailable. Check your internet and reload.'); return; }
  if (!window.isSecureContext || !crypto.subtle) { toast('Open Erev over HTTPS in a current browser.'); return; }
  enableSound();
  name=safeName($('nickname').value);
  try{localStorage.setItem('frame-name',name);}catch{}
  host=!requested;
  roomKey=requested||newRoomCode();
  roomSlug=host?slugify($('roomName').value):parseInvite($('roomInput').value).slug;
  status('Connecting…');
  $('start').disabled=true;
  joining=true;
  let access;
  try {
    const keys=await crypto.subtle.generateKey(ecKey,false,['sign','verify']);
    const publicKey=encodeRoomProof(await crypto.subtle.exportKey('raw',keys.publicKey));
    const requestAt=Date.now();
    const response=await roomRequest({action:host?'create':'join',code:roomKey,publicKey},{signal:AbortSignal.timeout(8000)});
    if(response.status===401||response.status===403){location.reload();return;}
    const result=await response.json();
    if(!response.ok||!/^[a-f0-9]{32}$/.test(result.signalingCode||'')||!webPeerPattern.test(result.peerId||'')||
       !webPeerPattern.test(result.hostPeerId||'')||!publicKeyPattern.test(result.hostKey||'')||
       !Number.isFinite(result.leaseMs)||!Number.isFinite(result.serverTime)){
      throw Error(result.error||'Could not start the room.');
    }
    signalingCode=result.signalingCode;
    access={code:roomKey,peerId:result.peerId,hostPeerId:result.hostPeerId,hostKey:result.hostKey,privateKey:keys.privateKey,
      deadline:requestAt+Math.min(60_000,result.leaseMs),clockOffset:result.serverTime-Date.now(),
      members:new Map([[result.hostPeerId,{publicKey:result.hostKey}],[result.peerId,{publicKey}]]),seenMedia:new Map()};
    roomAccessState=access;
    peer=new Peer(result.peerId,{debug:0,config:iceConfig()});
  }catch(error){fail(error.message||'Could not connect to Erev.');return;}
  finally{joining=false;}
  const timeout=setTimeout(()=>{if(!joined&&access===roomAccessState)fail('Connection timed out. Check the room link and Network settings.');},30_000);
  watchRoomAccess(access);
  peer.on('open',id=>{
    if (access !== roomAccessState) return;
    if (id !== access.peerId) { fail('The signaling service returned an invalid identity.'); return; }
    me=id;
    if(host){roster.set(me,{id:me,name});clearTimeout(timeout);enter();}
    else connectToHost(access,timeout);
  });
  peer.on('connection',connection=>admitGuest(connection,access));
  peer.on('call',acceptCall);
  peer.on('disconnected',()=>{if(access===roomAccessState&&!leaving&&!peer.destroyed){status('Signaling interrupted');try{peer.reconnect();}catch{}}});
  peer.on('error',error=>{
    if (access !== roomAccessState) return;
    if(!joined){clearTimeout(timeout);fail(error.type==='peer-unavailable'?'Room not found. Ask the host to keep it open.':'Connection failed: '+(error.type||'unknown'));}
    else notice('Connection issue: '+(error.type||'unknown')+'. Some media may not connect.');
  });
};

function fail(message) {
  leaving = true;
  releaseRoomAccess();
  peer?.destroy();
  peer = null;
  leaving = false;
  $('start').disabled = false;
  status('Ready');
  toast(message);
}
function publishRoster(){const arr=[...roster.values()];broadcast({type:'roster',roster:arr});applyRoster(arr);}
function applyRoster(arr){if(!Array.isArray(arr)||arr.length>MAX)return;roster=new Map(arr.filter(x=>typeof x?.id==='string').map(x=>[x.id,{id:x.id,name:safeName(x.name),mic:x.mic===true}]));for(const [k,c] of out)if(!roster.has(c.peer)){c.close();out.delete(k);}for(const [k,c] of incoming)if(!roster.has(c.peer)){c.close();incoming.delete(k);streams.delete(k);}if(activeScreen&&!roster.has(activeScreen))applyShared('');renderPeople();publishMedia();}
function handleHost(who,m){if(!m||!roster.has(who))return;if(handleVoiceHost(who,m))return;if(handleRoomRequest(who,m))return;if(m.type==='chat'&&typeof m.text==='string'&&m.text.trim()){const msg={type:'chat',from:who,name:roster.get(who).name,text:m.text.trim().slice(0,1000)};displayChat(msg);broadcast(msg);}else if(m.type==='share'){if(m.on===true){if(activeScreen&&activeScreen!==who){if(who===me){stopShare(false);notice('Someone is already sharing.');}else send(clients.get(who),{type:'shareDenied'});return;}setShared(who,m.kind==='local'?'local':'screen');}else if(activeScreen===who)setShared('');}}
function handleGuest(m){if(!m)return;switch(m.type){case 'voiceMode':setVoiceMode(m.enabled===true);break;case 'voicePCM':receiveVoicePacket(m.from,m.data);break;case 'voiceCapture':voiceSending=m.enabled===true;startVoiceCapture();break;case 'retryVoiceFor':if(roster.has(m.target)&&m.target!==me)retryPeerMedia(m.target,'av');break;case 'roster':applyRoster(m.roster);break;case 'chat':displayChat(m);break;case 'shared':applyShared(m.id,m.kind);break;case 'retryScreenFor':if(activeScreen===me&&roster.has(m.target))retryPeerMedia(m.target,'screen');break;case 'roomScreenOffer':receiveRoomScreenOffer(m);break;case 'permissions':applyPermissions(m.permissions);break;case 'browser':applyBrowser(m.url);break;case 'localPlaybackCommand':if(localPlayback&&activeScreen===me)executePlayback($('localMovie'),m.action);break;case 'localTimeline':applyLocalTimeline(m.timeline);break;case 'localSeek':if(localPlayback&&activeScreen===me&&m.source===localSeekId)seekLocal(m.time);break;case 'shareDenied':stopShare(false);notice('Someone is already sharing.');break;case 'movie':applyMovie(m.state);break;}}
function displayChat(m){const item=document.createElement('div');item.className='msg'+(m.from===me?' self':'');const b=document.createElement('b'),d=document.createElement('div');b.textContent=m.from===me?'You':safeName(m.name);d.textContent=String(m.text||'').slice(0,1000);item.append(b,d);$('messages').append(item);while($('messages').children.length>250)$('messages').firstChild.remove();$('messages').scrollTop=$('messages').scrollHeight;}
$('chatForm').onsubmit=e=>{e.preventDefault();const input=$('message');if(input.value.trim()&&joined){toHost({type:'chat',text:input.value});input.value='';}};$('chatToggle').onclick=()=>{const closed=!$('chat').hidden;$('chat').hidden=closed;document.querySelector('.workspace').classList.toggle('no-chat',closed);$('chatToggle').setAttribute('aria-pressed',String(!closed));};
$('invite').onclick=async()=>{const link=inviteLink();try{await navigator.clipboard.writeText(link);toast('Invitation copied.');}catch{prompt('Share this private invitation:',link);}};
function key(p,t){return p+'|'+t;}
const roomScreenSupport = new WeakSet();
const roomVoiceSupport = new WeakSet();
const roomScreenLinks = new WeakMap();

function roomScreenConnection(id) {
  return host ? clients.get(id) : (up?.peer === id ? up : null);
}

function canUseRoomScreen(connection) {
  return !!connection?.open && roomScreenSupport.has(connection) &&
    typeof RoomScreenLink === 'function' && !!connection.peerConnection?.addTransceiver;
}

function roomScreenLink(connection) {
  if (!canUseRoomScreen(connection)) return null;
  let link = roomScreenLinks.get(connection);
  if (!link) {
    link = new RoomScreenLink(connection, message => send(connection, message), () => {
      if (joined && !leaving) { renderStage(); renderPeople(); }
    }, roomVoiceSupport.has(connection));
    roomScreenLinks.set(connection, link);
  }
  link.setSource(activeScreen === me ? localScreen : null, roomMicTrack());
  return link;
}

function validRoomScreenSignal(message) {
  return typeof message.token === 'string' && /^[a-f0-9]{32}$/.test(message.token) &&
    typeof message.sdp === 'string' && message.sdp.length <= 64000 && message.sdp.startsWith('v=0');
}

function tryRoomScreen(peerId) {
  const link = roomScreenLink(roomScreenConnection(peerId));
  if (!link || link.failed) return false;
  link.offer(id());
  return true;
}

function receiveRoomScreenOffer(message) {
  if (!host && validRoomScreenSignal(message)) roomScreenLink(up)?.answerOffer(message);
}

function syncRoomScreenSenders() {
  const source = activeScreen === me ? localScreen : null;
  for (const connection of host ? clients.values() : (up ? [up] : [])) {
    roomScreenLinks.get(connection)?.setSource(source, roomMicTrack());
  }
}

function connectRoomVoice(participant) {
  const connection = clients.get(participant);
  if (connection && roomVoiceSupport.has(connection) &&
    (localMic() || roster.get(participant)?.mic)) tryRoomScreen(participant);
}

function roomMicTrack() {
  return localAV.getAudioTracks().find(track => track.readyState === 'live' && track.enabled) || null;
}

function currentScreenStream() {
  if (activeScreen === me) return localScreen;
  const connection = roomScreenConnection(activeScreen);
  const roomLink = connection ? roomScreenLinks.get(connection) : null;
  return roomLink?.playable ? roomLink.received : streams.get(key(activeScreen, 'screen'));
}

function sourceFor(kind){return kind==='screen'?localScreen:localAV;}
function hasSource(kind){return !!sourceFor(kind)?.getTracks().some(t=>t.readyState==='live');}
function clearRetry(k){const timer=retryTimers.get(k);if(timer)clearTimeout(timer);retryTimers.delete(k);}
function scheduleRetry(p,kind){const k=key(p,kind);if(leaving||!roster.has(p)||!hasSource(kind)||retryTimers.has(k))return;const attempts=retryAttempts.get(k)||0;if(attempts>=3){networkText('A media connection failed after retries. A dedicated TURN relay may be required.');return;}retryAttempts.set(k,attempts+1);retryTimers.set(k,setTimeout(()=>{retryTimers.delete(k);if(!out.has(k)&&roster.has(p)&&hasSource(kind))publishMedia();},1000*Math.pow(2,attempts)));}
function watchConnection(c,onFailure,onConnected){const pc=c.peerConnection;if(!pc)return;let failed=false,disconnectTimer,deadline;const good=()=>['connected','completed'].includes(pc.iceConnectionState)||pc.connectionState==='connected';const stop=()=>{clearTimeout(disconnectTimer);clearTimeout(deadline);pc.removeEventListener('iceconnectionstatechange',check);pc.removeEventListener('connectionstatechange',check);};function fail(){if(failed)return;failed=true;stop();onFailure();}function check(){if(good()){clearTimeout(disconnectTimer);clearTimeout(deadline);onConnected?.();return;}if(pc.iceConnectionState==='failed'||pc.connectionState==='failed'){fail();return;}if(pc.iceConnectionState==='disconnected'||pc.connectionState==='disconnected'){if(!disconnectTimer)disconnectTimer=setTimeout(()=>{if(!good())fail();},7000);}else{clearTimeout(disconnectTimer);disconnectTimer=null;}}deadline=setTimeout(()=>{if(!good())fail();},22000);pc.addEventListener('iceconnectionstatechange',check);pc.addEventListener('connectionstatechange',check);c.on('close',stop);c.on('error',stop);check();}
const pendingMedia = new Set();

async function sendRoomMedia(access, target, kind, stream) {
  const key = target + '|' + kind;
  if (pendingMedia.has(key)) return;
  pendingMedia.add(key);
  try {
    const nonce = id();
    const time = Math.round(Date.now() + access.clockOffset);
    const proof = await signRoomProof(access,'media:'+kind,me,target,nonce,time);
    if (access !== roomAccessState || !peer?.open || !roster.has(target) || !access.members.has(target) ||
        sourceFor(kind) !== stream || !hasSource(kind) || out.has(key) || Date.now() >= access.deadline) return;
    const connection = peer.call(target,stream,{metadata:{room:signalingCode,kind,nonce,time,proof}});
    if (!connection) { scheduleRetry(target,kind); return; }
    out.set(key,connection);
    const failed=()=>{
      if(out.get(key)!==connection)return;
      out.delete(key);
      try{connection.close();}catch{}
      scheduleRetry(target,kind);
    };
    connection.on('close',failed);
    connection.on('error',failed);
    watchConnection(connection,failed,()=>{retryAttempts.delete(key);clearRetry(key);});
  }catch{
    if (access === roomAccessState) scheduleRetry(target,kind);
  }finally{
    pendingMedia.delete(key);
  }
}

function publishMedia() {
  const access = roomAccessState;
  if (!joined || !peer?.open || !access || Date.now() >= access.deadline) return;
  for (const target of roster.keys()) {
    if (target === me || !access.members.has(target)) continue;
    for (const kind of ['av','screen']) {
      const k=key(target,kind);
      if (!hasSource(kind) || out.has(k) || retryTimers.has(k)) continue;
      const link = kind === 'screen' && roomScreenConnection(target);
      if (link && roomScreenLinks.get(link)?.sending) continue;
      sendRoomMedia(access,target,kind,sourceFor(kind));
    }
  }
}
function retryPeerMedia(p,kind){if(!roster.has(p)||p===me||!hasSource(kind))return;const k=key(p,kind),c=out.get(k);clearRetry(k);retryAttempts.delete(k);if(c){out.delete(k);c.close();}publishMedia();}
function republish(kind){if(kind==='screen')syncRoomScreenSenders();for(const k of [...retryTimers.keys()])if(k.endsWith('|'+kind))clearRetry(k);for(const k of [...retryAttempts.keys()])if(k.endsWith('|'+kind))retryAttempts.delete(k);for(const [k,c] of [...out])if(k.endsWith('|'+kind)){out.delete(k);c.close();}publishMedia();}
async function acceptCall(c) {
  const access = roomAccessState;
  const {room,kind,nonce,time,proof}=c.metadata ?? {};
  const seenKey=c.peer+'|'+nonce;
  if (!access || !joined || room !== signalingCode || !['av','screen'].includes(kind) ||
      !roster.has(c.peer) || !Number.isSafeInteger(time) ||
      Math.abs(Date.now()+access.clockOffset-time)>35_000 || access.seenMedia.has(seenKey)) {
    c.close(); return;
  }
  if (!access.members.has(c.peer)) await syncRoomAccess(access);
  if (!roster.has(c.peer) || !await verifyRoomProof(access,'media:'+kind,c.peer,me,nonce,proof,time) ||
      access.seenMedia.has(seenKey) || !roster.has(c.peer)) {
    c.close(); return;
  }
  const now=Date.now();
  for(const [seen,until] of access.seenMedia)if(until<=now)access.seenMedia.delete(seen);
  access.seenMedia.set(seenKey,now+70_000);
  const k=key(c.peer,kind),old=incoming.get(k);incoming.set(k,c);streams.delete(k);old?.close();c.on('stream',s=>{if(incoming.get(k)!==c)return;streams.set(k,s);if(kind==='screen'&&ui.screen.srcObject!==s)autoplayBlocked=false;renderPeople();renderStage();});const clean=()=>{if(incoming.get(k)===c){incoming.delete(k);streams.delete(k);if(kind==='screen'&&activeScreen===c.peer){screenWaitAt=Date.now();autoplayBlocked=false;}renderPeople();renderStage();}};c.on('close',clean);c.on('error',clean);try{c.answer();watchConnection(c,()=>{clean();c.close();},()=>{});}catch{clean();c.close();}}
function play(v){try{const promise=v.play();if(promise)promise.then(()=>{if(v===ui.screen){autoplayBlocked=false;updateMediaOverlay();}}).catch(e=>{if(v===ui.screen&&v.srcObject&&e.name==='NotAllowedError'){autoplayBlocked=true;updateMediaOverlay();}});}catch{}}
function requestScreenRetry(){if(!joined)return;if(activeScreen&&activeScreen!==me){screenRequestAt=Date.now();toHost({type:'mediaRetry'});}else if(activeScreen===me){if(host){for(const participant of clients.keys())if(!tryRoomScreen(participant))retryPeerMedia(participant,'screen');}else republish('screen');}republish('av');requestVoiceRetry();updateMediaOverlay();}
function updateMediaOverlay(){const remote=joined&&!!activeScreen&&activeScreen!==me;const overlay=$('mediaOverlay'),action=$('mediaOverlayAction'),label=$('mediaOverlayText');if(!remote){overlay.hidden=true;return;}const ready=screenIsPlaying();overlay.hidden=ready&&!autoplayBlocked;if(overlay.hidden)return;if(autoplayBlocked){label.textContent='Video ready. Tap to start playback and sound.';action.textContent='Start playback';}else if(Date.now()-screenWaitAt>26000){label.textContent='Video still hasn’t arrived. Retry, or ask the sender to restart the share.';action.textContent='Retry connection';}else{label.textContent=screenRequestAt?'Trying another connection for shared video…':'Connecting to shared video…';action.textContent='Retry connection';}}
function screenIsPlaying(){return !!ui.screen.srcObject&&ui.screen.readyState>=2&&!ui.screen.paused;}
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
    if (activeScreen && activeScreen !== me && !autoplayBlocked && !screenIsPlaying() &&
      Date.now() - screenWaitAt > 6500 && Date.now() - screenRequestAt > 14000) {
      screenRequestAt = Date.now();
      toHost({type: 'mediaRetry'});
    }
    const media = [...out.values(), ...incoming.values()];
    const roomConnections = host ? [...clients.values()] : (up ? [up] : []);
    const roomScreenConnections = roomConnections.filter(connection => {
      const link = roomScreenLinks.get(connection);
      return activeScreen === me ? link?.sending : (activeScreen === connection.peer && link?.playable);
    });
    const groups = [
      ['Room connection', roomConnections],
      ['Shared video via room', roomScreenConnections],
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
function voiceElement(id) {
  return [...$('voiceAudio').children].find(audio => audio.dataset.id === id);
}

function syncVoiceElement(id, stream) {
  let audio = voiceElement(id);
  const tracks = stream?.getAudioTracks().filter(track => track.readyState === 'live') || [];
  if (!tracks.length) {
    if (audio) { audio.srcObject = null; audio.remove(); }
    return;
  }
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.id = id;
    audio.addEventListener('playing', updateVoiceStatus);
    $('voiceAudio').append(audio);
  }
  const current = audio.srcObject?.getAudioTracks() || [];
  if (tracks.length !== current.length || tracks.some((track, index) => track !== current[index])) {
    audio.srcObject = new MediaStream(tracks);
    for (const track of tracks) {
      track.addEventListener('unmute', () => {
        if (audio.srcObject?.getAudioTracks().includes(track) && !audio.muted) playVoice(audio);
        checkVoiceRetry();
        updateVoiceStatus();
      }, {once: true});
    }
  }
  audio.volume = volumes.get(id) ?? 1;
  updateVoiceRoute(id);
}

function playVoice(audio) {
  if (!audio?.srcObject || audio.muted) return;
  audio.play().then(() => { voiceNeedsTap = false; updateVoiceStatus(); }).catch(error => {
    if (error.name === 'NotAllowedError') { voiceNeedsTap = true; updateVoiceStatus(); }
  });
}

function renderPeople(){const root=$('people'),existing=new Map([...root.children].map(el=>[el.dataset.id,el]));for(const [p,person] of roster){let tile=existing.get(p);if(!tile){tile=document.createElement('div');tile.className='person';tile.dataset.id=p;const avatar=document.createElement('div');avatar.className='avatar';const v=document.createElement('video');v.autoplay=true;v.playsInline=true;v.muted=true;const n=document.createElement('span');n.className='name';const mic=document.createElement('span');mic.className='voice-indicator';tile.append(avatar,v,n,mic);if(p!==me){const range=document.createElement('input');range.type='range';range.min='0';range.max='1';range.step='.05';range.value=volumes.get(p)??1;range.className='vol';range.setAttribute('aria-label','Volume for '+person.name);range.oninput=()=>{const value=Number(range.value);volumes.set(p,value);const a=voiceElement(p);if(a)a.volume=value;const g=voiceGains.get(p);if(g)g.gain.value=value;};tile.append(range);}root.append(tile);}existing.delete(p);tile.querySelector('.avatar').textContent=person.name.charAt(0).toUpperCase();tile.querySelector('.name').textContent=p===me?name+' (you)':person.name;const s=p===me?localAV:streams.get(key(p,'av')),v=tile.querySelector('video'),tracks=s?.getVideoTracks().filter(t=>t.readyState==='live')||[];if(!tracks.length){if(v.srcObject)v.srcObject=null;}else if(!v.srcObject||v.srcObject.getVideoTracks().map(t=>t.id).join()!==tracks.map(t=>t.id).join()){v.srcObject=new MediaStream(tracks);play(v);}v.style.opacity=tracks.some(t=>t.enabled)?'1':'0';tile.querySelector('.voice-indicator').textContent=(p===me?localAV.getAudioTracks().some(t=>t.readyState==='live'):person.mic)?'MIC ON':'MIC OFF';if(p!==me){const connection=roomScreenConnection(p);const link=connection&&roomScreenLinks.get(connection);syncVoiceElement(p,link?.voicePlayable?link.voice:s);}}for(const el of existing.values())el.remove();for(const a of [...$('voiceAudio').children])if(!roster.has(a.dataset.id)){a.srcObject=null;a.remove();}for(const id of voiceGains.keys())if(!roster.has(id))clearVoicePlayback(id); $('count').textContent=roster.size+' / '+MAX;updateVoiceStatus();}
function localMic() {
  return !!roomMicTrack();
}

function announceMic() {
  if (joined) toHost({type: 'micState', on: localMic()});
  syncRoomScreenSenders();
  updateMicMonitor();
}

function syncVoiceSender(id) {
  const enabled = !!voiceSubscribers.get(id)?.size;
  const previous = voiceCaptureRequested.has(id);
  if (previous === enabled) return;
  if (enabled) voiceCaptureRequested.add(id);
  else voiceCaptureRequested.delete(id);
  if (id === me) {
    voiceSending = enabled;
    startVoiceCapture();
  } else {
    send(clients.get(id), {type: 'voiceCapture', enabled});
  }
}

function removeVoiceParticipant(id) {
  voiceSubscribers.delete(id);
  voiceCaptureRequested.delete(id);
  voiceRate.delete(id);
  for (const [speaker, listeners] of voiceSubscribers) {
    if (listeners.delete(id)) syncVoiceSender(speaker);
    if (!listeners.size) voiceSubscribers.delete(speaker);
  }
  for (const key of voiceRequestAt.keys()) {
    if (key.startsWith(id + '|') || key.endsWith('|' + id)) voiceRequestAt.delete(key);
  }
}

function handleVoiceHost(who, message) {
  if (message.type === 'micState') {
    const person = roster.get(who);
    if (person.mic !== (message.on === true)) {
      person.mic = message.on === true;
      publishRoster();
    }
    if (who === me) for (const id of clients.keys()) connectRoomVoice(id);
    else connectRoomVoice(who);
    return true;
  }
  if (message.type === 'voiceBackup') {
    const speaker = message.target;
    if (speaker === who || !roster.has(speaker)) return true;
    const listeners = voiceSubscribers.get(speaker) || new Set();
    if (message.enabled === true && roster.get(speaker).mic) listeners.add(who);
    else listeners.delete(who);
    if (listeners.size) voiceSubscribers.set(speaker, listeners);
    else voiceSubscribers.delete(speaker);
    syncVoiceSender(speaker);
    return true;
  }
  if (message.type === 'voicePCM') {
    const listeners = voiceSubscribers.get(who);
    if ((!voiceMode && !listeners?.size) || !roster.get(who)?.mic ||
      !validPCM(message.data) || !allowVoicePacket(who)) return true;
    if (who !== me && (voiceMode || listeners?.has(me))) receiveVoicePacket(who, message.data);
    for (const [id, connection] of clients) {
      if (id !== who && (voiceMode || listeners?.has(id))) {
        sendVoice(connection, {type: 'voicePCM', from: who, data: message.data});
      }
    }
    return true;
  }
  if (message.type === 'voiceRetry') {
    const speaker = message.target;
    if (typeof speaker !== 'string' || speaker === who || !roster.get(speaker)?.mic) return true;
    const key = who + '|' + speaker;
    const now = Date.now();
    if (now - (voiceRequestAt.get(key) || 0) < 10000) return true;
    voiceRequestAt.set(key, now);
    if (speaker === me) retryPeerMedia(who, 'av');
    else send(clients.get(speaker), {type: 'retryVoiceFor', target: who});
    return true;
  }
  return false;
}

function directVoiceReady(id) {
  return !!voiceElement(id)?.srcObject?.getAudioTracks().some(track => track.readyState === 'live' && !track.muted);
}

function backupPlaying(id) {
  return voiceContext?.state === 'running' && voiceLast.has(id) && Date.now() - voiceLast.get(id) < 2500;
}

function updateVoiceRoute(id) {
  const audio = voiceElement(id);
  if (!audio) return;
  const muted = voiceMode || (voiceBackup.has(id) && (voicePreferBackup || backupPlaying(id)));
  if (muted) {
    audio.muted = true;
    if (!audio.paused) audio.pause();
  } else {
    audio.muted = false;
    if (audio.paused && !voiceNeedsTap && directVoiceReady(id)) playVoice(audio);
  }
}

function setBackupSubscription(id, enabled) {
  if (voiceBackup.has(id) === enabled) return;
  if (enabled) voiceBackup.add(id);
  else {
    voiceBackup.delete(id);
    clearVoicePlayback(id);
  }
  toHost({type: 'voiceBackup', target: id, enabled});
  updateVoiceRoute(id);
}

function requestVoiceRetry() {
  if (!joined || voiceMode || voicePreferBackup) return;
  for (const [id, person] of roster) {
    if (id !== me && person.mic && !directVoiceReady(id)) {
      toHost({type: 'voiceRetry', target: id});
    }
  }
}

function checkVoiceRetry() {
  if (!joined || leaving || (!host && !up?.open)) return;
  const now = Date.now();
  const expected = new Set();
  for (const [id, person] of roster) {
    if (id === me || !person.mic) continue;
    expected.add(id);
    if (voiceMode) continue;
    if (voicePreferBackup) {
      setBackupSubscription(id, true);
      continue;
    }
    if (directVoiceReady(id)) {
      voiceWarmUntil.delete(id);
      voiceMissingSince.delete(id);
      setBackupSubscription(id, false);
      updateVoiceRoute(id);
      continue;
    }
    if (!voiceMissingSince.has(id)) voiceMissingSince.set(id, now);
    if (now - voiceMissingSince.get(id) >= 6500 && now >= (voiceWarmUntil.get(id) || 0)) {
      setBackupSubscription(id, true);
      updateVoiceRoute(id);
    }
    const key = 'local|' + id;
    if (!voiceBackup.has(id) && now - (voiceRequestAt.get(key) || 0) >= 15000 &&
      now - voiceMissingSince.get(id) >= 3500) {
      voiceRequestAt.set(key, now);
      toHost({type: 'voiceRetry', target: id});
    }
  }
  for (const id of voiceBackup) if (!expected.has(id)) setBackupSubscription(id, false);
  for (const id of voiceMissingSince.keys()) if (!expected.has(id)) voiceMissingSince.delete(id);
  for (const id of voiceWarmUntil.keys()) if (!expected.has(id)) voiceWarmUntil.delete(id);
}

function updateVoiceStatus() {
  if (!joined) return;
  const expected = [...roster.values()].filter(person => person.id !== me && person.mic);
  const backupCount = expected.filter(person => backupPlaying(person.id)).length;
  const roomCount = expected.filter(({id}) => {
    const connection = roomScreenConnection(id);
    const audio = voiceElement(id);
    return audio && connection && roomScreenLinks.get(connection)?.voicePlayable && !backupPlaying(id) && !audio.paused && !audio.muted;
  }).length;
  const directCount = expected.filter(({id}) => {
    const audio = voiceElement(id);
    return !backupPlaying(id) && directVoiceReady(id) && !audio.paused && !audio.muted;
  }).length;
  const backupInUse = voiceMode || voicePreferBackup || !!voiceBackup.size || voiceSending;
  const directBlocked = expected.some(({id}) => {
    const audio = voiceElement(id);
    return directVoiceReady(id) && audio.paused && !audio.muted;
  });
  const needs = directBlocked || (backupInUse && !!voiceContext && voiceContext.state !== 'running');
  $('enableSound').hidden = !(needs || voiceNeedsTap);
  const label = voiceMode ? 'Room backup voice' : (backupInUse ? 'Backup voice' : 'Voice');
  const remote = expected.length ? (directCount + backupCount) + '/' + expected.length +
    ' remote audio connected' + (backupCount ? ' (' + backupCount + ' on backup)' :
      roomCount ? ' (' + roomCount + ' via room)' : '') : 'No remote mics on';
  $('voiceStatus').textContent = label + ' · ' + (localMic() ? 'Mic on' : 'Mic off') + ' · ' +
    ((!host && !up?.open) ? 'Room disconnected' : remote) + (needs ? ' · Tap Enable sound' : '');
}

function validPCM(samples) {
  return typeof samples === 'string' && samples.length >= 4 && samples.length <= 5500 &&
    samples.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(samples);
}

function allowVoicePacket(id) {
  const now = Date.now();
  const rate = voiceRate.get(id);
  if (!rate || now - rate.at >= 1000) {
    voiceRate.set(id, {at: now, count: 1});
    return true;
  }
  return ++rate.count <= 60;
}

function sendVoice(connection, message) {
  if (!connection?.open || connection.dataChannel?.bufferedAmount > 12000) return;
  send(connection, message);
}

function getVoiceContext() {
  if (!voiceContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw Error('This browser does not support backup voice.');
    voiceContext = new Context();
    voiceContext.onstatechange = () => {
      if (voiceContext.state === 'running') voiceNeedsTap = false;
      updateVoiceStatus();
    };
  }
  return voiceContext;
}

function stopVoiceCapture() {
  if (voiceProcessor) {
    voiceProcessor.onaudioprocess = null;
    voiceProcessor.disconnect();
  }
  voiceInput?.disconnect();
  voiceSilent?.disconnect();
  voiceInput = voiceProcessor = voiceSilent = voiceTrack = null;
}

function pcmEncode(samples, rate) {
  const targetRate = 16000;
  const count = Math.floor(samples.length * targetRate / rate);
  const bytes = new Uint8Array(count * 2);
  const pcm = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    const from = Math.floor(index * rate / targetRate);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((index + 1) * rate / targetRate)));
    let sum = 0;
    for (let sample = from; sample < to; sample++) sum += samples[sample];
    const value = Math.max(-1, Math.min(1, sum / (to - from)));
    pcm.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return btoa(String.fromCharCode(...bytes));
}

function startVoiceCapture() {
  const track = localAV.getAudioTracks().find(item => item.readyState === 'live' && item.enabled);
  if ((!voiceMode && !voiceSending) || !track || leaving) {
    stopVoiceCapture();
    return;
  }
  if (voiceTrack === track && voiceProcessor) return;
  stopVoiceCapture();
  try {
    const context = getVoiceContext();
    if (context.state !== 'running') voiceNeedsTap = true;
    voiceInput = context.createMediaStreamSource(new MediaStream([track]));
    voiceProcessor = context.createScriptProcessor(2048, 1, 1);
    voiceSilent = context.createGain();
    voiceSilent.gain.value = 0;
    voiceInput.connect(voiceProcessor);
    voiceProcessor.connect(voiceSilent);
    voiceSilent.connect(context.destination);
    voiceTrack = track;
    voiceProcessor.onaudioprocess = event => {
      if ((!voiceMode && !voiceSending) || !localMic() || context.state !== 'running' || leaving) return;
      const data = pcmEncode(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate);
      if (!validPCM(data)) return;
      const message = {type: 'voicePCM', data};
      if (host) handleVoiceHost(me, message);
      else sendVoice(up, message);
    };
    updateVoiceStatus();
  } catch {
    stopVoiceCapture();
    notice('Backup voice could not start on this browser. Standard voice is still available.');
  }
}

function clearVoicePlayback(id) {
  if (id === undefined) {
    for (const speaker of voiceGains.keys()) clearVoicePlayback(speaker);
    return;
  }
  for (const [source, speaker] of voiceSources) {
    if (speaker !== id) continue;
    try { source.stop(); } catch {}
    voiceSources.delete(source);
  }
  voiceGains.get(id)?.disconnect();
  voiceGains.delete(id);
  voiceQueue.delete(id);
  voiceLast.delete(id);
}

function receiveVoicePacket(id, data) {
  if (id === me || !roster.get(id)?.mic ||
    (!voiceMode && !voiceBackup.has(id)) || !validPCM(data)) return;
  try {
    const context = getVoiceContext();
    if (context.state !== 'running') {
      if (!voiceNeedsTap) { voiceNeedsTap = true; updateVoiceStatus(); }
      return;
    }
    const now = context.currentTime;
    const previous = voiceQueue.get(id) || 0;
    if (previous > now + .28) return;
    const raw = atob(data);
    if (!raw.length || raw.length % 2 || raw.length > 4096) return;
    const buffer = context.createBuffer(1, raw.length / 2, 16000);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) {
      const value = raw.charCodeAt(2 * index) | (raw.charCodeAt(2 * index + 1) << 8);
      samples[index] = (value << 16 >> 16) / 32768;
    }
    let gain = voiceGains.get(id);
    if (!gain) {
      gain = context.createGain();
      gain.gain.value = volumes.get(id) ?? 1;
      gain.connect(context.destination);
      voiceGains.set(id, gain);
    }
    const at = Math.max(now + .065, previous);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    voiceSources.set(source, id);
    source.onended = () => { voiceSources.delete(source); source.disconnect(); };
    source.start(at);
    voiceQueue.set(id, at + buffer.duration);
    const first = !backupPlaying(id);
    voiceLast.set(id, Date.now());
    if (first) {
      updateVoiceRoute(id);
      updateVoiceStatus();
    }
  } catch {}
}

function setVoiceMode(on) {
  if (voiceMode === on) return;
  voiceMode = on;
  voiceNeedsTap = false;
  clearVoicePlayback();
  for (const id of voiceBackup) setBackupSubscription(id, false);
  voiceMissingSince.clear();
  $('voiceCompat').setAttribute('aria-pressed', String(on));
  $('voiceCompat').textContent = on ? 'Room backup on' : 'Use backup for everyone';
  $('voiceRoute').hidden = on;
  for (const [id] of roster) updateVoiceRoute(id);
  startVoiceCapture();
  checkVoiceRetry();
  updateVoiceStatus();
}

function enableSound() {
  voiceNeedsTap = false;
  try {
    const context = getVoiceContext();
    if (context.state !== 'running') context.resume().then(() => {
      startVoiceCapture();
      updateVoiceStatus();
    }).catch(updateVoiceStatus);
  } catch {}
  for (const audio of $('voiceAudio').children) playVoice(audio);
  updateVoiceStatus();
}

let micMonitor = null;
let micMonitorTimer = null;

function updateMicMonitor() {
  const track = roomMicTrack();
  if (micMonitor?.track === track) return;
  clearInterval(micMonitorTimer);
  micMonitor?.source.disconnect();
  micMonitor?.analyser.disconnect();
  micMonitor = null;
  $('micLevel').value = 0;
  $('micMeter').hidden = !track;
  if (!track) return;
  try {
    const context = getVoiceContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    micMonitor = {track, source, analyser};
    micMonitorTimer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
      $('micLevel').value = track.muted ? 0 : peak;
    }, 150);
  } catch {}
}

$('testSpeakers').onclick = () => {
  enableSound();
  try {
    const context = getVoiceContext();
    const tone = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    tone.frequency.value = 520;
    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + .32);
    tone.connect(gain).connect(context.destination);
    tone.onended = () => { tone.disconnect(); gain.disconnect(); };
    tone.start(now);
    tone.stop(now + .33);
    toast('Playing a test tone on this device.');
  } catch { toast('Could not play the test tone.'); }
};

$('enableSound').onclick = enableSound;
$('voiceRoute').onclick = () => {
  if (!joined || voiceMode) return;
  voicePreferBackup = !voicePreferBackup;
  $('voiceRoute').setAttribute('aria-pressed', String(voicePreferBackup));
  $('voiceRoute').textContent = voicePreferBackup ? 'Use automatic voice' : 'Try backup voice';
  for (const [id, person] of roster) {
    if (id === me || !person.mic) continue;
    if (!voicePreferBackup) {
      voiceMissingSince.delete(id);
      voiceWarmUntil.set(id, Date.now() + 7500);
      setBackupSubscription(id, false);
    }
  }
  enableSound();
  checkVoiceRetry();
  updateVoiceStatus();
};
$('voiceCompat').onclick = () => {
  if (!host || !joined) return;
  setVoiceMode(!voiceMode);
  broadcast({type: 'voiceMode', enabled: voiceMode});
  enableSound();
};

async function toggleAV(kind){if(!joined)return;const btn=kind==='audio'?$('mic'):$('cam');btn.disabled=true;enableSound();try{const current=localAV.getTracks().find(t=>t.kind===kind);if(current){localAV.removeTrack(current);current.stop();}else{if(!navigator.mediaDevices?.getUserMedia)throw Error('Media devices unavailable');const s=await navigator.mediaDevices.getUserMedia(kind==='audio'?{audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}}:{video:{width:{ideal:640},height:{ideal:360},frameRate:{ideal:24}}});const t=s.getTracks()[0];if(leaving||!joined){s.getTracks().forEach(track=>track.stop());return;}if(!t)throw Error('No matching device was found.');localAV.addTrack(t);t.onended=()=>{localAV.removeTrack(t);updateAV();announceMic();startVoiceCapture();republish('av');renderPeople();};}updateAV();announceMic();startVoiceCapture();republish('av');renderPeople();}catch(e){notice('Could not access '+kind+': '+e.message);}finally{btn.disabled=false;}}
function updateAV(){for(const [kind,id,label] of [['audio','mic','Mic'],['video','cam','Camera']]){const on=localAV.getTracks().some(t=>t.kind===kind&&t.readyState==='live');$(id).textContent=label+(on?' on':' off');$(id).setAttribute('aria-pressed',String(on));}}$('mic').onclick=()=>toggleAV('audio');$('cam').onclick=()=>toggleAV('video');
let localTimeline = null, localSeekId = '';
function setShared(who,kind='screen'){broadcast({type:'shared',id:who,kind});applyShared(who,kind);}function applyShared(who,kind='screen'){if(who!==activeScreen||kind!==activeShareKind||!screenWaitAt){localTimeline=null;screenWaitAt=Date.now();screenRequestAt=0;autoplayBlocked=false;}activeScreen=typeof who==='string'?who:'';activeShareKind=kind==='local'?'local':'screen';syncRoomScreenSenders();renderStage();refreshAccess();}
const handheldShare = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const appleHandheld = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const androidBridge = window.ErevAndroid;
const androidCaptureAvailable = () => typeof androidBridge?.postMessage === 'function' &&
  typeof HTMLCanvasElement.prototype.captureStream === 'function';
let androidShare = null;

function stopAndroidCapture() {
  if (!androidShare) return;
  const capture = androidShare;
  androidShare = null;
  clearTimeout(capture.timeout);
  androidBridge.onmessage = null;
  androidBridge.postMessage(JSON.stringify({action:'stop', id:capture.id}));
  if (!capture.stream) capture.reject(new DOMException('Screen sharing ended.', 'NotAllowedError'));
}

function captureAndroidScreen() {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', {alpha:false});
    if (!context) { reject(new Error('Screen canvas unavailable.')); return; }
    const capture = {id:id(), reject, stream:null, timeout:setTimeout(stopAndroidCapture, 90_000)};
    androidShare = capture;
    androidBridge.onmessage = ({data}) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.id !== capture.id || androidShare !== capture) return;
      if (message.kind === 'ended') {
        if (capture.stream) stopShare();
        else {
          stopAndroidCapture();
        }
        return;
      }
      if (message.kind !== 'frame' || typeof message.jpeg !== 'string') return;
      const frame = new Image();
      const next = () => androidBridge.postMessage(JSON.stringify({action:'next', id:capture.id}));
      frame.onerror = () => { if (androidShare === capture) next(); };
      frame.onload = () => {
        if (androidShare !== capture) return;
        try {
          if (canvas.width !== frame.width) canvas.width = frame.width;
          if (canvas.height !== frame.height) canvas.height = frame.height;
          context.drawImage(frame, 0, 0);
          if (!capture.stream) {
            capture.stream = canvas.captureStream();
            clearTimeout(capture.timeout);
            resolve(capture.stream);
          }
          next();
        } catch {
          if (capture.stream) stopShare();
          else stopAndroidCapture();
        }
      };
      frame.src = 'data:image/jpeg;base64,' + message.jpeg;
    };
    androidBridge.postMessage(JSON.stringify({action:'start', id:capture.id}));
  });
}

const displayCaptureAvailable = () => androidCaptureAvailable() || typeof navigator.mediaDevices?.getDisplayMedia === 'function';
const screenShareSupport = $('screenShareSupport');

function screenShareHelp() {
  if (appleHandheld) return 'Open Erev in Safari on iOS or iPadOS 27 or later to share your screen.';
  if (handheldShare) return 'This mobile browser can watch a shared screen. To share your own screen, use a supported device.';
  return 'This browser can watch a shared screen. To share your screen, open Erev in a supported browser.';
}

function updateScreenShareHelp() {
  const available = displayCaptureAvailable();
  screenShareSupport.hidden = available;
  if (!available) screenShareSupport.textContent = screenShareHelp();
  if (handheldShare) {
    $('browserShareTab').textContent = 'Share screen';
    $('youtubeShareTab').textContent = 'Share screen';
  }
}

function setScreenShareControls(sharing) {
  const label = sharing ? 'Stop sharing' : 'Share screen';
  for (const button of [$('share'), $('browserShare'), $('emptyShare')]) {
    button.textContent = label;
    button.setAttribute('aria-pressed', String(sharing));
  }
}

updateScreenShareHelp();

let choosingShare = false;
async function share(preferTab = false) {
  if (!joined || leaving || choosingShare) return;
  if (pendingLocal) { stopShare(false); return; }
  if (localScreen) { stopShare(); return; }
  if (activeScreen) { toast('Someone is already sharing.'); return; }
  if (!displayCaptureAvailable()) {
    notice(screenShareHelp());
    return;
  }
  choosingShare = true;
  const video = {width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 30}};
  const options = handheldShare ? {video:true} : preferTab ? {
    video: {...video, displaySurface: 'browser'}, audio: true,
    selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'exclude', surfaceSwitching: 'include'
  } : {video, audio: true};
  try {
    const stream = androidCaptureAvailable() ? await captureAndroidScreen() : await navigator.mediaDevices.getDisplayMedia(options);
    const track = stream.getVideoTracks()[0];
    if (!track || leaving || !joined || (!host && !up?.open) || activeScreen || localScreen || pendingLocal) {
      stream.getTracks().forEach(item => item.stop());
      stopAndroidCapture();
      if (!leaving) toast('The room or share changed while the picker was open.');
      return;
    }
    localScreen = stream;
    track.onended = () => stopShare();
    toHost({type: 'share', on: true});
    if (!localScreen) return;
    setScreenShareControls(true);
    publishMedia();
    renderStage();
    if (!stream.getAudioTracks().length) {
      notice(handheldShare
        ? 'Sharing your screen. Use the room microphone if you want to talk.'
        : 'Sharing without sound. To include sound, share a browser tab and turn on tab audio in the picker.');
    }
  } catch (error) {
    if (error.name === 'NotAllowedError') notice('Screen sharing was canceled or blocked. Tap Share screen and approve the prompt to try again.');
    else if (appleHandheld) notice('Screen sharing could not start. Open the same room in Safari on iOS or iPadOS 27 or later.');
    else notice('Screen sharing could not start. Try sharing again in a supported browser.');
  } finally {
    choosingShare = false;
  }
}
function stopShare(notify=true){stopAndroidCapture();const s=localScreen;localScreen=null;const wasLocal=localPlayback||pendingLocal;localPlayback=false;pendingLocal=false;localSeekId='';if(s)s.getTracks().forEach(t=>{t.onended=null;t.stop();});if(wasLocal){const v=$('localMovie');v.pause();v.removeAttribute('src');v.load();if(localURL){URL.revokeObjectURL(localURL);localURL='';}$('localLabel').textContent='Local video';$('localLabel').setAttribute('aria-pressed','false');}republish('screen');setScreenShareControls(false);if(notify&&s)toHost({type:'share',on:false});renderStage();}$('share').onclick=()=>share();$('emptyShare').onclick=()=>share();
function renderStage(){const ownLocal=(localPlayback||pendingLocal)&&(!activeScreen||activeScreen===me);const s=currentScreenStream();const sharing=!!activeScreen||ownLocal;const browsing=!sharing&&!!browserState;const youtube=!sharing&&!browsing&&isYouTubeMovie();$('browserStage').hidden=!browsing;updateYouTubeStage(youtube);$('localMovie').hidden=!ownLocal;ui.screen.hidden=ownLocal||!sharing||!s;ui.movie.hidden=sharing||browsing||!movieState||youtube;$('empty').hidden=ownLocal||browsing||(sharing&&!!s)||(!sharing&&!!movieState);const displayStream=ownLocal?null:s||null;if(ui.screen.srcObject!==displayStream){autoplayBlocked=false;ui.screen.srcObject=displayStream;ui.screen.muted=activeScreen===me;if(displayStream){ui.screen.playsInline=true;ui.screen.autoplay=true;play(ui.screen);}}if(sharing&&!s&&!ownLocal){$('empty').querySelector('h2').textContent='Connecting to shared screen…';}else $('empty').querySelector('h2').textContent='Make it movie night.';if((sharing||browsing)&&!ui.movie.paused)ui.movie.pause();refreshAccess();updateMediaOverlay();}

function chooseLocal(){if(!joined)return;if(localPlayback||pendingLocal){stopShare();return;}if(localScreen||activeScreen){toast('Stop the current share first.');return;}$('localFile').click();}
$('localLabel').onclick=chooseLocal;$('emptyLocal').onclick=chooseLocal;
$('localFile').onchange=async()=>{const file=$('localFile').files[0];$('localFile').value='';if(!file||!joined||localScreen||activeScreen||pendingLocal)return;const v=$('localMovie'),capture=v.captureStream||v.mozCaptureStream;if(!capture){notice('Local video streaming is unavailable in this browser. Use desktop Chrome or Edge.');return;}pendingLocal=true;const url=URL.createObjectURL(file);localURL=url;v.src=url;v.volume=Number($('movieVolume').value);renderStage();$('localLabel').textContent='Loading video…';try{await new Promise((resolve,reject)=>{if(v.readyState>=2){resolve();return;}const timer=setTimeout(()=>{cleanup();reject(Error('Video did not load'));},15000);function cleanup(){clearTimeout(timer);v.removeEventListener('loadeddata',ready);v.removeEventListener('error',bad);}function ready(){cleanup();resolve();}function bad(){cleanup();reject(Error('Unsupported format. Try MP4 (H.264/AAC) or WebM.'));}v.addEventListener('loadeddata',ready,{once:true});v.addEventListener('error',bad,{once:true});});if(!pendingLocal||localURL!==url)return;if(activeScreen){stopShare(false);notice('Another participant started sharing.');return;}const stream=capture.call(v);if(!stream.getVideoTracks().length){v.play().catch(()=>{});await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);stream.removeEventListener('addtrack',check);resolve();};const check=()=>{if(stream.getVideoTracks().length)done();};timer=setTimeout(done,2500);stream.addEventListener('addtrack',check);check();});}if(!pendingLocal||localURL!==url){stream.getTracks().forEach(t=>t.stop());return;}if(!stream.getVideoTracks().length){stream.getTracks().forEach(t=>t.stop());throw Error('Cannot capture video. Try desktop Chrome or Edge.');}if(activeScreen){stream.getTracks().forEach(t=>t.stop());stopShare(false);return;}localScreen=stream;localPlayback=true;pendingLocal=false;localSeekId=id();const changed=()=>{if(localScreen===stream)republish('screen');};stream.addEventListener('addtrack',changed);stream.addEventListener('removetrack',changed);toHost({type:'share',on:true,kind:'local'});announceLocalTimeline();if(!localScreen)return;setScreenShareControls(true);$('localLabel').textContent='Stop local video';$('localLabel').setAttribute('aria-pressed','true');publishMedia();renderStage();v.play().catch(()=>toast('Press play on the movie.'));notice(stream.getAudioTracks().length?'Local video is streaming directly to the room. No upload.':'No audio track captured. Check the file or browser.');}catch(e){if(localURL===url){stopShare(false);notice(e.message||'Could not play video.');}}};

function canPlayback(){return host||permissions.playback===true;}
function canBrowse(){return host||permissions.browse===true;}
function applyPermissions(p){permissions={playback:p?.playback===true,browse:p?.browse===true,seek:p?.seek===true};refreshAccess();}
function refreshAccess(){const browse=canBrowse(), playback=canPlayback(), connected=joined&&(host||!!up?.open);$('permissionsToggle').hidden=!host;$('allowPlayback').checked=permissions.playback;$('allowBrowse').checked=permissions.browse;$('allowSeek').checked=permissions.seek;$('browserURL').disabled=!browse||!connected;$('browserGo').disabled=!browse||!connected;$('browserReload').disabled=!browse||!connected||!browserState;$('browserClose').disabled=!browse||!connected||!browserState;$('browserLock').hidden=browse;$('browserFrame').inert=!browse;$('browserFrame').tabIndex=browse?0:-1;$('browserFrame').style.pointerEvents=browse?'auto':'none';$('browserExternal').hidden=!browse||!browserState;$('browserShareTab').hidden=!connected||!browse||!browserState;$('browserShareTab').disabled=!!activeScreen;$('permissionStatus').textContent=host?'Host':(permissions.playback?'Playback allowed':'Playback locked')+' · '+(permissions.browse?'Browser allowed':'Browser locked')+(permissions.seek?' · Seeking allowed':'');const playable=activeScreen?activeShareKind==='local':!!movieState&&!browserState;const own=localPlayback&&activeScreen===me;$('sharedControls').hidden=!(playable&&(playback||own));$('roomPlay').disabled=!connected||!(playback||own);$('roomPause').disabled=!connected||!(playback||own);updateSeekControls();}
$('permissionsToggle').onclick=()=>{if(!host)return;const panel=$('permissionsPanel');panel.hidden=!panel.hidden;$('permissionsToggle').setAttribute('aria-expanded',String(!panel.hidden));};
function changePermissions(){if(!host||!joined)return;applyPermissions({playback:$('allowPlayback').checked,browse:$('allowBrowse').checked,seek:$('allowSeek').checked});broadcast({type:'permissions',permissions});toast('Guest permissions updated.');}
$('allowPlayback').onchange=changePermissions;$('allowBrowse').onchange=changePermissions;$('allowSeek').onchange=changePermissions;
function browserURL(v){const u=normalizeSourceURL(v);if(!u||u.length>2048)return '';try{if(new URL(u).origin===location.origin)return '';return u;}catch{return '';}}
function selectBrowser(on){browserSelected=on;$('browserBar').hidden=!on;$('videoBar').hidden=on;$('browserMode').setAttribute('aria-pressed',String(on));$('videoMode').setAttribute('aria-pressed',String(!on));refreshAccess();}
function applyBrowser(raw){const url=raw?browserURL(raw):'';const changed=browserState!==url;browserState=url;const frame=$('browserFrame');if(changed){if(url)frame.src=url;else frame.removeAttribute('src');}if(url){$('browserURL').value=url;$('browserExternal').href=url;selectBrowser(true);}else{if(changed)$('browserURL').value='';$('browserExternal').removeAttribute('href');}renderStage();}
function setBrowser(url){if(!host)return;if(url&&movieState){clearMovie();broadcast({type:'movie',state:null});}applyBrowser(url);broadcast({type:'browser',url});}
function timelineTime(value, duration) {
  return Number.isFinite(value) ? Math.max(0, Math.min(duration, value)) : null;
}

function seekableTimeline(source, time, duration) {
  if (!/^[a-f0-9]{32}$/.test(source || '') || !Number.isFinite(duration) || duration <= 0) return null;
  const position = timelineTime(time, duration);
  return position === null ? null : {source, time: position, duration};
}

function applyLocalTimeline(raw) {
  if (!activeScreen || activeShareKind !== 'local') return;
  const next = seekableTimeline(raw?.source, raw?.time, raw?.duration);
  if (next) { localTimeline = next; updateSeekControls(); }
}

function announceLocalTimeline() {
  if (!joined || leaving || !localPlayback) return;
  const video = $('localMovie');
  const timeline = seekableTimeline(localSeekId, video.currentTime, video.duration);
  if (timeline) toHost({type: 'localTimeline', timeline});
}

function roomTimeline() {
  if (activeScreen) {
    if (activeShareKind !== 'local') return null;
    return localTimeline;
  }
  if (browserState || !movieState) return null;
  if (!isYouTubeMovie()) return seekableTimeline(movieState.seekId, ui.movie.currentTime, ui.movie.duration);
  if (!youtubeSession?.ready) return null;
  const player = youtubeSession.player;
  return seekableTimeline(movieState.seekId, player.getCurrentTime(), player.getDuration());
}

const seekSlider = $('roomSeek');
let previewingSeek = false;

function timeLabel(value) {
  const seconds = Math.floor(value || 0);
  const minutes = Math.floor(seconds / 60);
  return minutes + ':' + String(seconds % 60).padStart(2, '0');
}

function updateSeekControls() {
  const timeline = roomTimeline();
  const allowed = joined && (host || !!up?.open) && (host || permissions.seek) && timeline;
  $('seekControls').hidden = !allowed;
  if (!allowed) { previewingSeek = false; delete seekSlider.dataset.source; return; }
  if (seekSlider.dataset.source !== timeline.source) previewingSeek = false;
  if (previewingSeek) return;
  seekSlider.dataset.source = timeline.source;
  seekSlider.max = timeline.duration;
  seekSlider.value = timeline.time;
  $('seekPosition').textContent = timeLabel(timeline.time) + ' / ' + timeLabel(timeline.duration);
}

seekSlider.oninput = () => {
  previewingSeek = true;
  $('seekPosition').textContent = timeLabel(Number(seekSlider.value)) + ' / ' + timeLabel(Number(seekSlider.max));
};
seekSlider.onchange = () => {
  const source = seekSlider.dataset.source;
  const time = Number(seekSlider.value);
  previewingSeek = false;
  if (source && (host || permissions.seek)) toHost({type: 'seekRequest', source, time});
};
seekSlider.onblur = () => { previewingSeek = false; updateSeekControls(); };

function seekLocal(time) {
  const video = $('localMovie');
  const position = timelineTime(time, video.duration);
  if (position !== null && Number.isFinite(video.duration)) video.currentTime = position;
}

function applyRoomSeek(who, message) {
  if (who !== me && !permissions.seek) return;
  const timeline = roomTimeline();
  if (!timeline || message.source !== timeline.source) return;
  const position = timelineTime(message.time, timeline.duration);
  if (position === null) return;
  if (activeScreen) {
    if (activeScreen === me) seekLocal(position);
    else send(clients.get(activeScreen), {type: 'localSeek', source: timeline.source, time: position});
  } else if (isYouTubeMovie()) {
    const player = youtubeSession.player;
    player.seekTo(position, true);
    if (movieState.paused) player.pauseVideo();
    syncMovie();
  } else {
    ui.movie.currentTime = position;
    syncMovie();
  }
}

for (const event of ['loadedmetadata', 'durationchange', 'seeked', 'play', 'pause']) {
  $('localMovie').addEventListener(event, announceLocalTimeline);
}

function executePlayback(v,action){if(action==='pause')v.pause();else if(action==='play')v.play().catch(()=>notice('Playback requires a tap on the video on the sender device.'));}
function handleRoomRequest(who,m){if(!host)return false;const owner=who===me;if(m.type==='roomScreenAnswer'){const connection=clients.get(who);if(connection&&validRoomScreenSignal(m))roomScreenLinks.get(connection)?.acceptAnswer(m);return true;}
if(m.type==='seekRequest'){applyRoomSeek(who,m);return true;}
if(m.type==='localTimeline'){if(activeScreen===who&&activeShareKind==='local'){applyLocalTimeline(m.timeline);if(localTimeline)broadcast({type:'localTimeline',timeline:localTimeline});}return true;}
if(m.type==='mediaRetry'){if(!activeScreen||activeScreen===who)return true;const now=Date.now();if(now-(lastMediaRequest.get(who)||0)<5000)return true;lastMediaRequest.set(who,now);if(activeScreen===me){if(!tryRoomScreen(who))retryPeerMedia(who,'screen');}else if(!(owner&&tryRoomScreen(activeScreen)))send(clients.get(activeScreen),{type:'retryScreenFor',target:who});return true;}
if(m.type==='browserRequest'){if(!(owner||permissions.browse)){if(!owner)send(clients.get(who),{type:'permissions',permissions});return true;}if(m.url===''){setBrowser('');return true;}const url=typeof m.url==='string'?browserURL(m.url):'';if(!url||activeScreen||pendingLocal||localPlayback)return true;const youtube=readYouTubeLink(url);if(youtube||isDirectVideo(url))loadMovie(url,youtube);else setBrowser(url);return true;}
if(m.type==='playbackRequest'){if(!['play','pause'].includes(m.action))return true;const sourceOwn=activeScreen===who&&activeShareKind==='local';if(!(owner||permissions.playback||sourceOwn))return true;if(activeScreen){if(activeShareKind!=='local')return true;if(activeScreen===me){if(localPlayback)executePlayback($('localMovie'),m.action);}else send(clients.get(activeScreen),{type:'localPlaybackCommand',action:m.action});}else if(movieState&&!browserState){if(isYouTubeMovie())youtubePlayback(m.action);else{executePlayback(ui.movie,m.action);syncMovie();}}return true;}return false;}
$('browserMode').onclick=()=>selectBrowser(true);$('videoMode').onclick=()=>selectBrowser(false);$('browserLocal').onclick=()=>{selectBrowser(false);chooseLocal();};$('browserShare').onclick=()=>share();$('browserShareTab').onclick=()=>share(true);$('youtubeShareTab').onclick=()=>share(true);
$('browserForm').onsubmit=e=>{e.preventDefault();if(!canBrowse())return;const url=browserURL($('browserURL').value);if(!url){toast('Enter a valid external HTTPS website address.');return;}if(activeScreen||pendingLocal){toast('Stop the current share before browsing.');return;}toHost({type:'browserRequest',url});};
$('browserReload').onclick=()=>{if(canBrowse()&&browserState)$('browserFrame').src=browserState;};
$('browserClose').onclick=()=>{if(canBrowse())toHost({type:'browserRequest',url:''});};
$('roomPlay').onclick=()=>toHost({type:'playbackRequest',action:'play'});$('roomPause').onclick=()=>toHost({type:'playbackRequest',action:'pause'});
function validURL(v){try{const u=new URL(v);return u.protocol==='https:'&& !u.username&&!u.password?u.href:'';}catch{return '';}}
function normalizeSourceURL(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048 || /\s/.test(raw)) return '';
  const address = /^[\w-]+(?:\.[\w-]+)+(?:[:/?#]|$)/.test(raw) ? 'https://' + raw : raw;
  return validURL(address.replace(/^http:\/\//i, 'https://'));
}

function readYouTubeLink(url) {
  if (!url) return null;
  const parsed = new URL(url);
  const name = parsed.hostname.toLowerCase();
  const [, section, item] = parsed.pathname.split('/');
  let id;
  if (name === 'youtu.be' || name === 'www.youtu.be') id = section;
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(name)) {
    if (section === 'watch') id = parsed.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v'].includes(section)) id = item;
  } else if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(name) && section === 'embed') {
    id = item;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) return null;
  const timestamp = parsed.searchParams.get('t') ?? parsed.searchParams.get('start') ??
    new URLSearchParams(parsed.hash.slice(1)).get('t') ?? '';
  const parts = timestamp.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  const seconds = /^\d+$/.test(timestamp) ? Number(timestamp) :
    parts ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0) : 0;
  return {id, time: Math.min(seconds || 0, 86400), url: 'https://www.youtube.com/watch?v=' + id};
}

function isDirectVideo(url) {
  return /\.(mp4|webm|m4v|ogv)$/i.test(new URL(url).pathname);
}

let youtubeSession = null;
let youtubeAPI = null;
const youtubeStage = $('youtubeStage');
const youtubeTools = $('youtubeTools');
const youtubeMessage = $('youtubeMessage');
let youtubeVisible = false;
const youtubeObserver = new IntersectionObserver(([entry]) => {
  youtubeVisible = entry.intersectionRatio > .5;
  applyYouTubePlayback();
}, {threshold: [.5, .51]});
youtubeObserver.observe(youtubeStage);
document.addEventListener('visibilitychange', applyYouTubePlayback);

function isYouTubeMovie() { return movieState?.kind === 'youtube'; }

function getYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeAPI) return youtubeAPI;
  youtubeAPI = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      reject(Error('The YouTube player did not load.'));
    };
    const timer = setTimeout(fail, 12000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
      else fail();
    };
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = fail;
    document.head.append(script);
  }).catch(error => {
    youtubeAPI = null;
    throw error;
  });
  return youtubeAPI;
}

function setYouTubeMessage(text, enableLocalPlay = false) {
  youtubeMessage.textContent = text;
  $('youtubeStart').hidden = !enableLocalPlay;
}

function clearMovieElement() {
  if (youtubeSession) {
    const session = youtubeSession;
    youtubeSession = null;
    clearTimeout(session.timeout);
    session.player?.destroy();
    youtubeStage.replaceChildren();
  }
  if (ui.movie.hasAttribute('src')) {
    ui.movie.pause();
    ui.movie.removeAttribute('src');
    ui.movie.load();
  }
}

function clearMovie() {
  movieState = null;
  clearMovieElement();
  renderStage();
}

function updateYouTubeStage(visible) {
  youtubeStage.hidden = !visible;
  youtubeTools.hidden = !visible;
  $('fullscreen').hidden = visible;
  if (!visible && youtubeSession?.ready) {
    const state = youtubeSession.player.getPlayerState();
    if (state === 1 || state === 3) youtubeSession.player.pauseVideo();
  }
}

function mountYouTube(state) {
  const session = {id: state.id, ready: false, player: null, autoplayBlocked: false, timeout: null};
  youtubeSession = session;
  $('youtubeExternal').href = state.url;
  setYouTubeMessage('Loading YouTube…');

  const fail = message => {
    if (youtubeSession !== session) return;
    clearTimeout(session.timeout);
    setYouTubeMessage(message + ' Open it on YouTube, then share that tab if you can play it there.');
  };

  getYouTubeAPI().then(YT => {
    if (youtubeSession !== session || leaving) return;
    const iframe = document.createElement('iframe');
    const embed = new URL('https://www.youtube.com/embed/' + state.id);
    embed.searchParams.set('enablejsapi', '1');
    embed.searchParams.set('origin', location.origin);
    embed.searchParams.set('playsinline', '1');
    if (state.time > 0) embed.searchParams.set('start', String(Math.floor(state.time)));
    iframe.title = 'YouTube video player';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.src = embed.href;
    youtubeStage.replaceChildren(iframe);
    session.timeout = setTimeout(() => fail('The YouTube player did not respond.'), 20000);
    session.player = new YT.Player(iframe, {events: {
      onReady(event) {
        if (youtubeSession !== session) return;
        clearTimeout(session.timeout);
        session.player = event.target;
        session.ready = true;
        event.target.setVolume(Number($('movieVolume').value) * 100);
        setYouTubeMessage(host ? 'Play or pause to control the room.' : 'Following the room’s playback.');
        if (!host) applyYouTubePlayback();
      },
      onStateChange(event) {
        if (youtubeSession !== session || !session.ready) return;
        if (event.data === 1) {
          session.autoplayBlocked = false;
          setYouTubeMessage(host ? 'Playing for the room.' : 'Following the room’s playback.');
          if (youtubeStage.hidden) { event.target.pauseVideo(); return; }
        }
        if (host && [0, 1, 2, 3].includes(event.data)) syncMovie();
        if (!host && event.data === 2 && movieState?.paused) applyYouTubePlayback();
      },
      onPlaybackRateChange() { if (host && youtubeSession === session) syncMovie(); },
      onAutoplayBlocked() {
        if (youtubeSession !== session) return;
        session.autoplayBlocked = true;
        setYouTubeMessage('Tap Play here to start on this device.', true);
      },
      onError(event) {
        if (youtubeSession !== session) return;
        session.ready = false;
        if ([101, 150].includes(event.data)) fail('This video’s owner has disabled embedded playback.');
        else if (event.data === 100) fail('This video is unavailable.');
        else fail('YouTube could not play this video here.');
      }
    }});
  }).catch(error => fail(error.message));
}

function youtubePlayback(action) {
  const session = youtubeSession;
  if (!session?.ready || youtubeStage.hidden) return;
  if (action === 'pause') session.player.pauseVideo();
  else {
    session.autoplayBlocked = false;
    session.player.playVideo();
  }
}

function movieTime(state) {
  const delay = state.paused ? 0 : Math.min(5, Math.max(0, (Date.now() - state.at) / 1000));
  return state.time + delay * state.rate;
}

function applyYouTubePlayback() {
  const session = youtubeSession;
  if (host || !isYouTubeMovie() || !session?.ready || youtubeStage.hidden) return;
  const player = session.player;
  const phase = player.getPlayerState();
  if (player.getPlaybackRate() !== movieState.rate) player.setPlaybackRate(movieState.rate);
  if (movieState.paused) {
    if (phase === 1 || phase === 3) player.pauseVideo();
    // A paused seek can start playback when the iframe has only cued the video.
    if (phase === 2 && Math.abs(player.getCurrentTime() - movieState.time) > .6) {
      player.seekTo(movieState.time, true);
    }
    return;
  }
  if (document.hidden || !youtubeVisible || session.autoplayBlocked) return;
  const target = movieTime(movieState);
  if (phase !== 3 && Math.abs(player.getCurrentTime() - target) > 1.25) player.seekTo(target, true);
  if (phase !== 1 && phase !== 3) player.playVideo();
}

function currentMovie() {
  if (!movieState) return null;
  if (isYouTubeMovie()) {
    if (!youtubeSession?.ready) return movieState;
    const player = youtubeSession.player;
    const phase = player.getPlayerState();
    const position = player.getCurrentTime();
    const time = Number.isFinite(position) && (position || ![-1, 5].includes(phase)) ? position : movieState.time;
    return {...movieState, time, rate: player.getPlaybackRate() || 1,
      paused: phase === 3 ? movieState.paused : phase !== 1, at: Date.now()};
  }
  return {...movieState, time: ui.movie.currentTime || 0, paused: ui.movie.paused,
    rate: ui.movie.playbackRate || 1, at: Date.now()};
}

function syncMovie() {
  if (!host || applying || !movieState) return;
  movieState = currentMovie();
  broadcast({type: 'movie', state: movieState});
}

function loadMovie(url, youtube = readYouTubeLink(url)) {
  if (browserState) setBrowser('');
  clearMovie();
  selectBrowser(false);
  $('mediaURL').value = url;
  movieState = youtube ? {...youtube, kind: 'youtube', paused: true, rate: 1, at: Date.now()} :
    {url, time: 0, paused: true, rate: 1, at: Date.now()};
  movieState.seekId = id();
  if (youtube) mountYouTube(movieState);
  else {
    ui.movie.src = url;
    ui.movie.controls = true;
    play(ui.movie);
  }
  renderStage();
  syncMovie();
}

$('mediaForm').onsubmit = event => {
  event.preventDefault();
  if (!host) return;
  const url = normalizeSourceURL($('mediaURL').value);
  if (!url) { toast('Paste a YouTube video or a direct HTTPS video link.'); return; }
  const youtube = readYouTubeLink(url);
  if (!youtube && /^(?:www\.|m\.|music\.)?youtube\.com$/.test(new URL(url).hostname)) {
    toast('Paste a link to an individual YouTube video.');
    return;
  }
  if (activeScreen || localScreen || localPlayback || pendingLocal) {
    toast('Stop the current share before loading a video.');
    return;
  }
  loadMovie(url, youtube);
};

function applyMovie(raw) {
  if (host) return;
  const url = validURL(raw?.url);
  const youtube = raw?.kind === 'youtube' ? readYouTubeLink(url) : null;
  if (!url || (raw?.kind === 'youtube' && !youtube)) { clearMovie(); return; }
  if (browserState) applyBrowser('');
  const time = Number(raw.time);
  const at = Number(raw.at);
  const state = {url, time: Number.isFinite(time) ? Math.max(0, time) : 0, paused: raw.paused !== false,
    rate: Math.min(2, Math.max(.25, Number(raw.rate) || 1)), at: Number.isFinite(at) ? at : Date.now(),
    seekId: typeof raw.seekId === 'string' ? raw.seekId : ''};
  const changed = movieState?.url !== url || isYouTubeMovie() !== !!youtube;
  if (changed) clearMovieElement();
  movieState = youtube ? {...state, kind: 'youtube', id: youtube.id} : state;
  if (changed) {
    selectBrowser(false);
    if (youtube) mountYouTube(movieState);
    else {
      ui.movie.src = url;
      ui.movie.controls = false;
    }
  }
  renderStage();
  if (youtube) { applyYouTubePlayback(); return; }
  applying = true;
  clearTimeout(applyTimer);
  const adjust = () => {
    if (movieState !== state) return;
    const target = movieTime(state);
    if (Math.abs(ui.movie.currentTime - target) > .65) try { ui.movie.currentTime = target; } catch {}
    ui.movie.playbackRate = Math.max(.5, state.rate);
    if (state.paused || activeScreen) ui.movie.pause();
    else ui.movie.play().catch(() => notice('Tap the video to allow playback.'));
  };
  if (ui.movie.readyState >= 1) adjust();
  else ui.movie.addEventListener('loadedmetadata', adjust, {once: true});
  applyTimer = setTimeout(() => applying = false, 800);
}

for (const event of ['play', 'pause', 'seeked', 'ratechange', 'ended']) {
  ui.movie.addEventListener(event, () => { if (!isYouTubeMovie()) syncMovie(); });
}
setInterval(() => {
  if (host && joined && (isYouTubeMovie() || (movieState && !ui.movie.paused))) syncMovie();
  updateSeekControls();
  if (localPlayback && !$('localMovie').paused) announceLocalTimeline();
}, 3000);
$('youtubeStart').onclick = () => {
  youtubePlayback('play');
  if (!host) applyYouTubePlayback();
};
ui.movie.onclick = () => { if (!host && movieState && !movieState.paused) play(ui.movie); };
ui.movie.onerror = () => notice('This video could not load. Try a direct MP4 or WebM file, or open the source in a tab and share it.');
$('movieVolume').oninput = () => {
  const volume = Number($('movieVolume').value);
  ui.movie.volume = ui.screen.volume = $('localMovie').volume = volume;
  if (youtubeSession?.ready) youtubeSession.player.setVolume(volume * 100);
};
$('fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen?.();else if($('stage').requestFullscreen)$('stage').requestFullscreen().catch(()=>toast('Fullscreen unavailable'));else if(!$('localMovie').hidden)$('localMovie').webkitEnterFullscreen?.();else if(!ui.movie.hidden)ui.movie.webkitEnterFullscreen?.();else if(!ui.screen.hidden)ui.screen.webkitEnterFullscreen?.();};
$('leave').onclick=()=>{leaving=true;releaseRoomAccess();stopShare(false);localAV.getTracks().forEach(t=>t.stop());updateMicMonitor();clearInterval(networkWatch);stopVoiceCapture();clearVoicePlayback();peer?.destroy();location.href=new URL('./',location.href).href;};window.addEventListener('pagehide',()=>{leaving=true;stopAndroidCapture();releaseRoomAccess();clearInterval(micMonitorTimer);stopVoiceCapture();clearVoicePlayback();if(voiceContext?.state!=='closed')voiceContext?.close().catch(()=>{});localScreen?.getTracks().forEach(t=>t.stop());localAV.getTracks().forEach(t=>t.stop());peer?.destroy();});document.addEventListener('pointerdown',()=>{for(const v of document.querySelectorAll('video'))if(v.srcObject&&v.paused)play(v);});let installPrompt=null;const installButton=$('install'),installHelp=$('installHelp');const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;async function installErev(){if(standalone()){toast('Erev is already installed.');return;}if(!installPrompt){toast(/Android/i.test(navigator.userAgent)?'Chrome menu ⋮ → Install app or Add to Home screen.':'Use Chrome or Edge browser menu to install Erev.');return;}try{const p=installPrompt;installPrompt=null;await p.prompt();const result=await p.userChoice;if(result.outcome==='accepted')installButton.hidden=true;}catch{toast('Use the browser menu to install Erev.');}}window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;installButton.hidden=false;});window.addEventListener('appinstalled',()=>{installButton.hidden=true;installHelp.hidden=true;installPrompt=null;});installButton.onclick=installErev;installHelp.onclick=installErev;installButton.hidden=standalone();installHelp.hidden=standalone();if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});

fetch('./api/me?roomClient=2').then(response=>response.ok?response.json():null).then(account=>{if(account&&!$('nickname').value)$('nickname').value=account.name.slice(0,28);}).catch(()=>{});
