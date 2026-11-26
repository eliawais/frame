const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const fixtureFile = '/tmp/frame-seek-fixture.webm';
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
  assert.match(await page.locator('footer').innerText(), /0\.11 BETA/);
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
  fs.writeFileSync(fixtureFile, Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAABQ4EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsghQQ7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhA04gAAAAAABZUrmvXrgEAAAAAAABO14EBc8WI2nsGOYlDbwScgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QHc1lA4JCwgfC6gZCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WI2nsGOYlDbwRnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MjAuMDAwMDAwMDAwAB9DtnVE2+eBAKP2gQAAgPAJAJ0BKvAAkAAARwiFhYiFhIgCAgJ1qgP4AgaGhPcGgWSfa9ubJzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jzh7Jy4A/v6UgH/unr2nr2nr+YP/8Vv+K3/Fb/+JxKOagQB9AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEA+gBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBAXcAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQH0AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoECcQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBAu4AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQNrAFECAAEQEBRgAGFgv9AAIgAi5eBmAACjmoED6ABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBBGUAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQTiAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEFXwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBBdwAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQZZAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEG1gBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBB1MAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQfQAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEITQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCMoAUQIAARAQFGAAYWC/0AAiACLl4GYAAKOagQlHAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEJxABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCkEAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQq+AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoELOwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBC7gAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQw1AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEMsgBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDS8AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ2sAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEOKQBRAgABEBAUYABhYL/QACIAIuXgZgAAo5qBDqYAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ8jAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEPoABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEB0AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagRCaAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoERFwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEZQAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagRIRAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoESjgBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEwsAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagROIAFECAAEQEBRgAGFgv9AAIgAi5eBmAAAfQ7Z1RIDnghQFo5qBAAAAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQB9AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEA+gBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBAXcAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQH0AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoECcQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBAu4AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQNrAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoED6ABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBBGUAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQTiAFECAAEQEBRgAGFgv9AAIgAi5eBmAACjmoEFXwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBBdwAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQZZAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEG1gBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBB1MAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQfQAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEITQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCMoAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQlHAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEJxABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCkEAUQIAARAQFGAAYWC/0AAiACLl4GYAAKOagQq+AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoELOwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBC7gAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQw1AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEMsgBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDS8AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ2sAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEOKQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDqYAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ8jAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEPoABRAgABEBAUYABhYL/QACIAIuXgZgAAo5qBEB0AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagRCaAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoERFwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEZQAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagRIRAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoESjgBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEwsAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagROIAFECAAEQEAAYABhYL/QACIAIuXgZgAAfQ7Z1RIDngigKo5qBAAAAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQB9AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEA+gBRAgABEBAUYABhYL/QACIAIuXgZgAAo5qBAXcAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQH0AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoECcQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBAu4AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQNrAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoED6ABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBBGUAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQTiAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEFXwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBBdwAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQZZAFECAAEQEBRgAGFgv9AAIgAi5eBmAACjmoEG1gBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBB1MAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQfQAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEITQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCMoAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQlHAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEJxABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCkEAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQq+AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoELOwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBC7gAUQIAARAQFGAAYWC/0AAiACLl4GYAAKOagQw1AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEMsgBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDS8AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ2sAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEOKQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDqYAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ8jAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEPoABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEB0AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagRCaAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoERFwBRAgABEBAUYABhYL/QACIAIuXgZgAAo5qBEZQAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagRIRAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoESjgBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEwsAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagROIAFECAAEQEAAYABhYL/QACIAIuXgZgAAfQ7Z1RGzngjwPo5qBAAAAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQB9AFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEA+gBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBAXcAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQH0AFECAAEQEAAYABhYL/QACIAIuXgZgACj9oECcYDwCQCdASrwAJAAAEcIhYWIhYSIAgICdaoD+AIGhoT3BoFkn2vbmyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eycuAP7+lIB/7p69p69p6/mD//Fb/it/xW//icSjmoEC7gBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBA2sAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQPoAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEEZQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBBOIAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQVfAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEF3ABRAgABEBAUYABhYL/QACIAIuXgZgAAo5qBBlkAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQbWAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEHUwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBB9AAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQhNAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEIygBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCUcAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQnEAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEKQQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBCr4AUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQs7AFECAAEQEBRgAGFgv9AAIgAi5eBmAACjmoELuABRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDDUAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQyyAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoENLwBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDawAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ4pAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEOpgBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBDyMAUQIAARAQABgAGFgv9AAIgAi5eBmAAKOagQ+gAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoEQHQBRAgABEBAAGAAYWC/0AAiACLl4GYAAo5qBEJoAUQIAARAQFGAAYWC/0AAiACLl4GYAAKOagREXAFECAAEQEAAYABhYL/QACIAIuXgZgACjmoERlABRAgABEBAAGAAYWC/0AAiACLl4GYAAHFO7a6O7j7OBALeK94EB8YIBsfCBA7uQs4I+gLeK94EB8YIPnvCBkA==", 'base64'));
  console.log('Generated the synthetic seek fixture.');
  const browser=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
  const pages=await Promise.all([browser.newPage(),browser.newPage()]);
  const [host,guest]=pages; const errors=[];
  try {
    for (const [index, page] of pages.entries()) {
      page.on('pageerror', error=>errors.push(error.message));
      await page.route('https://media.frame.test/seek.webm', async route => {
        const data = fs.readFileSync(fixtureFile);
        const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const headers = {'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes'};
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Math.min(data.length - 1, Number(range[2])) : data.length - 1;
          const body = data.subarray(start, end + 1);
          return route.fulfill({status:206, body, contentType:'video/webm', headers:{
            ...headers, 'Content-Range':'bytes '+start+'-'+end+'/'+data.length, 'Content-Length':String(body.length)
          }});
        }
        return route.fulfill({status:200, body:data, contentType:'video/webm', headers:{
          ...headers, 'Content-Length':String(data.length)
        }});
      });
      await page.route('https://www.youtube.com/embed/**', route => route.fulfill({body:'Test player element'}));
      await page.addInitScript(({frequency})=>{
        const sources = [];
        let voiceAnalyser;
        window.streamAudioLevel = () => {
          const media = document.querySelector('#voiceAudio audio');
          if (!media || media.paused || media.muted || !media.srcObject) return 0;
          if (!voiceAnalyser || voiceAnalyser.stream !== media.srcObject) {
            const ctx = new AudioContext(), input = ctx.createMediaStreamSource(media.srcObject), meter = ctx.createAnalyser();
            meter.fftSize = 512;
            input.connect(meter);
            voiceAnalyser = {stream: media.srcObject, ctx, input, meter, samples: new Float32Array(meter.fftSize)};
          }
          const {meter, samples} = voiceAnalyser;
          meter.getFloatTimeDomainData(samples);
          return Math.max(...samples.map(value => Math.abs(value)));
        };
        Object.defineProperty(navigator.mediaDevices,'getUserMedia',{
          configurable:true,
          value:async()=>{
            const context=new AudioContext();
            await context.resume();
            const tone=context.createOscillator(), gain=context.createGain(), destination=context.createMediaStreamDestination();
            tone.frequency.value=frequency;gain.gain.value=.04;
            tone.connect(gain).connect(destination);tone.start();
            sources.push({context,tone});
            return destination.stream;
          }
        });
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
      }, {frequency:index ? 640 : 480});
    }
    await openRoom(host,url,'Test Host');
    console.log('Host room is open.');
    await openRoom(guest,host.url(),'Test Guest');
    console.log('Guest room connection is open.');
    await checkSoon(()=>host.locator('#count').textContent(), value=>value==='2 / 6');
    for (const page of pages) {
      await page.evaluate(()=>{
        const original=Peer.prototype.call;
        Peer.prototype.call=function(target,stream,options){
          if(options?.metadata?.kind==='screen'){window.failedScreenCalls++;return undefined;}
          if(options?.metadata?.kind==='av')return undefined;
          return original.call(this,target,stream,options);
        };
      });
    }
    await host.locator('#mic').click();
    await guest.locator('#mic').click();
    for (const page of pages) {
      await checkSoon(()=>page.locator('#voiceStatus').textContent(), text=>text.includes('1/1 remote audio connected')&&text.includes('via room'),20000);
      await checkSoon(()=>page.evaluate(()=>window.streamAudioLevel()), level=>level>.005,14000);
    }
    assert.equal(await host.locator('#micMeter').isVisible(),true);
    await checkSoon(()=>host.locator('#micLevel').evaluate(meter=>meter.value), value=>value>0,10000);
    console.log('Two-way microphone audio reached the actual browser audio element through the room while standalone audio was disabled.');
    await exercise(host,guest,'Host to guest with separate screen connection disabled',false);
    await exercise(guest,host,'Guest to host using the negotiated connection',false);
    await guest.locator('#message').fill('Chat still works after shared video');
    await guest.locator('#message').press('Enter');
    await host.getByText('Chat still works after shared video',{exact:true}).waitFor({state:'visible',timeout:6000});
    const setPosition=(page,time)=>page.locator('#roomSeek').evaluate((slider,value)=>{
      slider.value=String(value);
      slider.dispatchEvent(new Event('input',{bubbles:true}));
      slider.dispatchEvent(new Event('change',{bubbles:true}));
    },time);
    await host.locator('#mediaURL').fill('https://media.frame.test/seek.webm');
    await host.locator('#loadMovie').click();
    await checkSoon(()=>host.locator('#roomSeek').isVisible(),Boolean,12000);
    await checkSoon(()=>host.locator('#movie').evaluate(video=>video.currentTime), value=>value>.2,8000);
    await host.locator('#roomPause').click();
    assert.equal(await guest.locator('#roomSeek').isVisible(),false);
    await guest.evaluate(()=>toHost({type:'seekRequest',source:movieState.seekId,time:12}));
    await pause(600);
    assert.ok(await host.locator('#movie').evaluate(video=>video.currentTime)<8);
    await host.locator('#permissionsToggle').click();
    await host.locator('#allowSeek').check();
    await guest.locator('#roomSeek').waitFor({state:'visible',timeout:8000});
    await setPosition(guest,12);
    for (const [index, page] of pages.entries()) {
      const result = await checkSoon(()=>page.locator('#movie').evaluate(video=>({
        role: host ? 'host' : 'guest', time: video.currentTime, available: video.seekable.length ? video.seekable.end(0) : null,
        permissions, sourceMatches: document.querySelector('#roomSeek').dataset.source===movieState.seekId,
        receivedTime: movieState.time, duration:video.duration
      })), value=>Math.abs(value.time-12)<.7,12000);
      console.log('Direct seek state for '+(index?'guest':'host')+': '+JSON.stringify(result));
    }
    await host.locator('#allowSeek').uncheck();
    await guest.locator('#roomSeek').waitFor({state:'hidden',timeout:6000});
    console.log('Direct video seeking was blocked by default, synced when granted, and disappeared when revoked.');

    await guest.locator('#localFile').setInputFiles(fixtureFile);
    await checkSoon(()=>host.locator('#roomSeek').isVisible(),Boolean,14000);
    await host.locator('#allowSeek').check();
    await guest.locator('#roomSeek').waitFor({state:'visible',timeout:6500});
    await setPosition(host,10);
    await checkSoon(()=>guest.locator('#localMovie').evaluate(video=>video.currentTime), value=>value>=9.8,10000);
    console.log('A room seek command moved a guest-hosted local video to the requested time.');
    await guest.locator('#share').click();

    for (const page of pages) {
      await page.evaluate(()=>{
        window.YT = {Player: class {
          constructor(frame, config) {
            this.time=0;
            setTimeout(()=>config.events.onReady({target:this}),0);
          }
          getPlayerState(){return 2;}
          getPlaybackRate(){return 1;}
          getCurrentTime(){return this.time;}
          getDuration(){return 240;}
          setVolume(){}
          seekTo(position){this.time=position;}
          pauseVideo(){}
          destroy(){}
        }};
      });
    }
    await host.locator('#mediaURL').fill('https://youtu.be/M7lc1UVf-VE');
    await host.locator('#loadMovie').click();
    await guest.locator('#roomSeek').waitFor({state:'visible',timeout:6500});
    await setPosition(guest,125);
    for (const page of pages) {
      await checkSoon(()=>page.evaluate(()=>youtubeSession?.player?.getCurrentTime()), value=>value===125,7500);
    }
    console.log('With the YouTube API mocked, an allowed guest seek synchronized the host and guest players.');
    assert.deepEqual(errors,[]);
    console.log('Room chat survived the video retry. Both peers can stop and share again.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
