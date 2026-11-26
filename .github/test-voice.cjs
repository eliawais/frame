const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const role = process.argv[2];
assert.ok(['host', 'guest'].includes(role));
const host = role === 'host';
const peer = host ? 'guest' : 'host';
const frequency = host ? 440 : 700;
const remoteFrequency = host ? 700 : 440;
const seed = process.env.GITHUB_RUN_ID + '/' + process.env.GITHUB_RUN_ATTEMPT;
const roomBytes = [...crypto.createHash('sha256').update('frame-voice/' + seed).digest().subarray(0, 10)];
const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
const roomBits = roomBytes.map(byte => byte.toString(2).padStart(8, '0')).join('');
const room = roomBits.match(/.{5}/g).map(bits => alphabet[parseInt(bits, 2)]).join('');
const base = 'https://eliawais.github.io/frame/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function egressHash() {
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {signal: AbortSignal.timeout(8000)});
    const address = (await response.text()).match(/^ip=(.+)$/m)?.[1];
    return address ? crypto.createHash('sha256').update(seed + '/' + address).digest('hex').slice(0, 20) : 'unknown';
  } catch { return 'unknown'; }
}

async function waitUntil(check, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(350);
  }
  throw Error('Timed out waiting for ' + label);
}

(async () => {
  const egress = await egressHash();
  const browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({frequency, roomBytes, host}) => {
    const timestamps = { direct: 0, backup: 0 };
    const analysisByStream = new WeakMap();
    let capture;
    let analyzerContext;
    let captureSource;
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    let roomGenerated = false;
    if (host) {
      crypto.getRandomValues = buffer => {
        if (!roomGenerated && buffer instanceof Uint8Array && buffer.length === roomBytes.length) {
          roomGenerated = true;
          buffer.set(roomBytes);
          return buffer;
        }
        return getRandomValues(buffer);
      };
    }
    function powerAt(samples, sampleRate, target) {
      if (!samples.length) return 0;
      let sine = 0;
      let cosine = 0;
      for (let index = 0; index < samples.length; index++) {
        const phase = 2 * Math.PI * target * index / sampleRate;
        sine += samples[index] * Math.sin(phase);
        cosine += samples[index] * Math.cos(phase);
      }
      return 2 * Math.hypot(sine, cosine) / samples.length;
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async ({audio}) => {
        if (!audio) throw Error('The fixture supplies only audio.');
        capture ||= new AudioContext();
        await capture.resume();
        const tone = capture.createOscillator();
        const gain = capture.createGain();
        const destination = capture.createMediaStreamDestination();
        gain.gain.value = 0.035;
        tone.frequency.value = frequency;
        tone.connect(gain).connect(destination);
        tone.start();
        captureSource = tone;
        return destination.stream;
      }
    });
    const remote = host ? 700 : 440;
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const buffer = this.buffer;
      if (buffer?.length && powerAt(buffer.getChannelData(0), buffer.sampleRate, remote) > 0.008) {
        timestamps.backup = Date.now();
      }
      return originalStart.apply(this, args);
    };
    window.observeVoice = () => {
      const audio = [...document.querySelectorAll('#voiceAudio audio')].find(item =>
        item.srcObject && !item.paused && !item.muted);
      if (audio) {
        analyzerContext ||= new AudioContext();
        if (!analysisByStream.has(audio.srcObject)) {
          const source = analyzerContext.createMediaStreamSource(audio.srcObject);
          const analyzer = analyzerContext.createAnalyser();
          analyzer.fftSize = 2048;
          const samples = new Float32Array(analyzer.fftSize);
          source.connect(analyzer);
          analysisByStream.set(audio.srcObject, {source, analyzer, samples});
        }
        const {analyzer, samples} = analysisByStream.get(audio.srcObject);
        analyzer.getFloatTimeDomainData(samples);
        if (powerAt(samples, analyzerContext.sampleRate, remote) > 0.008) timestamps.direct = Date.now();
      }
      return {...timestamps, status: document.querySelector('#voiceStatus').textContent};
    };
    window.addEventListener('pagehide', () => captureSource?.stop());
  }, {frequency, roomBytes, host});

  const status = page.locator('#voiceStatus');
  const connected = () => status.isVisible();
  const announce = async value => {
    await page.locator('#message').fill(value);
    await page.locator('#message').press('Enter');
  };
  const waitForMessage = async prefix => await waitUntil(async () => {
    return await page.locator('#messages .msg:not(.self)').evaluateAll((elements, start) =>
      elements.map(element => element.lastElementChild?.textContent || '')
        .find(message => message.startsWith(start)), prefix);
  }, 90000, prefix + ' marker');

  try {
    await page.goto(host ? base : base + '#voice-check.' + room, {waitUntil:'domcontentloaded',timeout:25000});
    assert.match(await page.locator('footer').innerText(), /FRAME \/ 0\.8 BETA/);
    await page.locator('#nickname').fill('voice-' + role);
    if (host) {
      await page.locator('#roomName').fill('voice-check');
      await page.locator('#start').click();
      await status.waitFor({state:'visible',timeout:20000});
      assert.ok(page.url().endsWith('#voice-check.' + room), 'Unexpected room code');
    } else {
      await waitUntil(async () => {
        if (await connected()) return true;
        const button = page.locator('#start');
        if (await button.isEnabled()) await button.click();
        return connected();
      }, 150000, 'the host to become reachable');
    }
    await waitUntil(async () => (await page.locator('#count').textContent()).trim() === '2 / 6', 150000, 'the second runner');
    await announce('NET ' + egress);
    const otherNetwork = (await waitForMessage('NET ')).slice(4);
    console.log('Separate runners connected; distinct public egress: ' +
      (egress === 'unknown' || otherNetwork === 'unknown' ? 'unverified' : egress !== otherNetwork));
    await page.locator('#mic').click();
    await waitUntil(async () => (await page.locator('#mic').textContent()).trim() === 'Mic on', 15000, 'local synthetic microphone');
    await waitUntil(async () => await page.locator('#people .person .voice-indicator').allTextContents().then(values =>
      values.filter(value => value === 'MIC ON').length === 2), 55000, 'both microphones');
    const directStart = Date.now();
    let directDetected = false;
    try {
      directDetected = !!await waitUntil(async () => (await page.evaluate(() => window.observeVoice())).direct >= directStart,
        12000, 'the other runner’s standard WebRTC audio tone');
    } catch {}
    console.log('Received expected ' + remoteFrequency + ' Hz tone on standard WebRTC: ' + directDetected);
    await announce('STANDARD ' + Number(directDetected));
    await waitForMessage('STANDARD ');
    const backupStart = Date.now();
    await page.locator('#voiceRoute').click();
    const played = await waitUntil(async () => {
      const result = await page.evaluate(() => window.observeVoice());
      return result.backup >= backupStart && result.status.includes('1/1 remote audio connected') &&
        result.status.includes('1 on backup') && result;
    }, 24000, 'the other runner’s backup PCM audio tone to be scheduled for playback');
    console.log('Received expected ' + remoteFrequency + ' Hz backup tone: ' + played.status);
    await announce('BACKUP 1');
    await waitForMessage('BACKUP ');
    await page.locator('#mic').click();
    assert.equal((await page.locator('#mic').textContent()).trim(), 'Mic off');
    assert.deepEqual(errors, []);
    if (!directDetected) console.log('Standard route was unavailable here; backup audio played.');
  } catch (error) {
    const statusText = await status.textContent().catch(() => '');
    const detail = await page.locator('#toast').textContent().catch(() => '');
    const roomStatus = await page.locator('#status').textContent().catch(() => '');
    console.error({role, statusText, detail, roomStatus, errors});
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
