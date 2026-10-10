// Voice mode through Whisper, end to end: real audio -> the app's speech detection -> MediaRecorder ->
// POST /api/stt -> Whisper -> command. The browser's own SpeechRecognition is removed, so only Whisper can work.
// The mic is a fake getUserMedia stream that plays espeak clips (run scripts/e2e/make-speech-clips.sh first).
// Needs the server with OPENAI_API_KEY. Pass this file as a Playwright `page => ...` snippet; set BASE below.
// Expect every step to match, sttCalls === steps, and micLiveWhileSpeaking === 0.
async (page) => {
  const BASE = 'http://localhost:5175';
  await page.addInitScript(() => {
    localStorage.clear();
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    window.__spoken = [];
    window.__micLiveWhileSpeaking = 0;
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const tracks = [];
    window.__micLive = () => tracks.some((t) => t.readyState === 'live');
    document.addEventListener('pointerdown', () => ctx.resume(), true);
    navigator.mediaDevices.getUserMedia = async () => {
      await ctx.resume();
      const track = dest.stream.getAudioTracks()[0].clone();
      tracks.push(track);
      return new MediaStream([track]);
    };
    window.__play = async (name) => {
      const data = await (await fetch(`/__e2e/${name}.wav`)).arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest);
      source.start();
      return buffer.duration;
    };
    const synth = {
      speaking: false,
      speak(u) {
        if (window.__micLive()) window.__micLiveWhileSpeaking += 1;
        window.__spoken.push(u.text);
        setTimeout(() => u.onend && u.onend(), 5);
      },
      cancel() {}, getVoices() { return []; }, addEventListener() {},
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  });
  let sttCalls = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/stt?lang=en') && r.method() === 'POST') sttCalls += 1; });
  await page.goto(`${BASE}/`);
  const log = [];
  const wait = (ms) => page.waitForTimeout(ms);
  const heading = () => page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
  async function sayClip(name, expect) {
    for (let i = 0; i < 80 && !(await page.evaluate(() => window.__micLive())); i += 1) await wait(100);
    const before = await page.evaluate(() => window.__spoken.length);
    await page.evaluate((n) => window.__play(n), name);
    let reply = '';
    for (let i = 0; i < 120 && !reply; i += 1) {
      await wait(100);
      const fresh = await page.evaluate((b) => window.__spoken.slice(b).join(' | '), before);
      if (expect.test(fresh)) reply = fresh;
    }
    const heard = await page.locator('.transcript').innerText().catch(() => '');
    log.push(`${reply ? 'OK ' : 'FAIL'} clip "${name}" heard=${heard || '?'} screen=${await heading()} :: ${(reply || '(no matching reply)').slice(0, 110)}`);
    return Boolean(reply);
  }
  await page.waitForSelector('.start-gate');
  await wait(1500);
  await page.mouse.click(400, 300);
  const steps = [
    ['blind', /Blind, with voice-first/],
    ['next', /Device permissions/],
    ['next', /Where are you/],
    ['k30', /starting points|Starting point set/],
    ['number1', /Starting point set to HG K 30/],
    ['audimax', /Route to HG F 30/],
    ['start', /Navigation started|Go straight|Turn/],
  ];
  for (const [clip, expect] of steps) if (!(await sayClip(clip, expect))) break;
  const micLiveWhileSpeaking = await page.evaluate(() => window.__micLiveWhileSpeaking);
  return { sttCalls, steps: steps.length, micLiveWhileSpeaking, log };
}
