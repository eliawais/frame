const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('playwright');
const routes = new Map([
  ['/', ['index.html','text/html']],
  ['/app.js', ['app.js','application/javascript']],
  ['/room-screen.js', ['room-screen.js','application/javascript']],
  ['/style.css', ['style.css','text/css']],
  ['/sw.js', ['sw.js','application/javascript']],
  ['/manifest.webmanifest', ['manifest.webmanifest','application/manifest+json']],
  ['/icon.svg', ['icon.svg','image/svg+xml']],
  ['/icon-maskable.svg', ['icon-maskable.svg','image/svg+xml']]
]);
const server = http.createServer((req,res) => {
  const match = routes.get(new URL(req.url,'http://127.0.0.1').pathname);
  if (!match) return res.writeHead(404).end();
  res.writeHead(200, {'Content-Type': match[1]});
  res.end(fs.readFileSync(match[0]));
});
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function checkSoon(callback, condition, timeout=30000) {
  const until=Date.now()+timeout; let last;
  do {
    last=await callback();
    if(condition(last)) return last;
    await pause(300);
  } while(Date.now()<until);
  throw Error('Condition not met: '+JSON.stringify(last));
}
async function openRoom(page, url, name) {
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
  assert.match(await page.locator('footer').innerText(), /0\.10 BETA/);
  await page.locator('#nickname').fill(name);
  await page.locator('#start').click();
  await page.locator('#room').waitFor({state:'visible', timeout:35000});
}
const readVideo = page => page.locator('#screenVideo').evaluate(video => ({
  width: video.videoWidth, time: video.currentTime, paused: video.paused, ready: video.readyState,
  audio: video.srcObject?.getAudioTracks().some(track=>!track.muted), active: !video.hidden,
  count: document.getElementById('count').textContent,
  overlay: document.getElementById('mediaOverlayText').textContent
}));
async function exercise(sender, viewer, label, checkAuto) {
  await sender.locator('#browserShare').click();
  const first=await checkSoon(()=>readVideo(viewer), state=>state.width===320&&state.time>0.15&&state.audio&&!state.paused, 30000);
  const second=await checkSoon(()=>readVideo(viewer), state=>state.time>first.time+.45, 12000);
  const route=await checkSoon(
    ()=>viewer.locator('#networkInfo').textContent(), text=>text.includes('Shared video via room'), 15000);
  assert.equal(second.count,'2 / 6');
  assert.equal(await viewer.locator('#mediaOverlay').isVisible(),false);
  if(checkAuto) assert.ok(await sender.evaluate(()=>window.failedScreenCalls)>0, 'Separate media path was never tried');
  assert.ok(route.includes('Room connection'));
  console.log(label+': fallback displayed advancing frames and received the synthetic audio track.');
  await sender.locator('#share').click();
  await checkSoon(()=>readVideo(viewer), state=>!state.active, 8000);
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/';
  const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
  const pages=await Promise.all([browser.newPage(),browser.newPage()]);
  const [host,guest]=pages; const errors=[];
  try {
    for(const page of pages) {
      page.on('pageerror', error=>errors.push(error.message));
      await page.addInitScript(()=>{
        window.failedScreenCalls=0;
        let keepAlive;
        Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{
          configurable:true,
          value:async()=>{
            const canvas=document.createElement('canvas');
            canvas.width=320;canvas.height=180;
            const screen=canvas.getContext('2d');let frame=0;
            const paint=()=>{
              screen.fillStyle='#253240';screen.fillRect(0,0,320,180);
              screen.fillStyle='#d8fa73';screen.fillRect(++frame*11%255,15,65,40);
            };
            paint();
            const stream=canvas.captureStream(18);
            const tick=setInterval(paint,55);
            const context=new AudioContext();
            await context.resume();
            const tone=context.createOscillator(), gain=context.createGain(), output=context.createMediaStreamDestination();
            gain.gain.value=.01;tone.frequency.value=440;tone.connect(gain).connect(output);tone.start();
            keepAlive={canvas,tone,tick,context};
            stream.addTrack(output.stream.getAudioTracks()[0]);
            window.addEventListener('pagehide',()=>{clearInterval(tick);context.close();},{once:true});
            return stream;
          }
        });
      });
    }
    await openRoom(host,url,'Test Host');
    await openRoom(guest,host.url(),'Test Guest');
    await checkSoon(()=>host.locator('#count').textContent(), value=>value==='2 / 6');
    for (const page of pages) {
      await page.evaluate(()=>{
        const original=Peer.prototype.call;
        Peer.prototype.call=function(target,stream,options){
          if(options?.metadata?.kind==='screen'){window.failedScreenCalls++;return undefined;}
          return original.call(this,target,stream,options);
        };
      });
    }
    await exercise(host,guest,'Host to guest with separate screen connection disabled',true);
    await exercise(guest,host,'Guest to host using the negotiated connection',false);
    await guest.locator('#message').fill('Chat still works after shared video');
    await guest.locator('#message').press('Enter');
    await host.getByText('Chat still works after shared video',{exact:true}).waitFor({state:'visible',timeout:6000});
    assert.deepEqual(errors,[]);
    console.log('Room chat survived the video retry. Both peers can stop and share again.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
