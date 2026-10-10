// Voice-mode answers without command words: a bare room on "Where are you?" must set the starting point
// and then ask "Where to?"; a bare place on "Where to?" must become the destination.
// Same fakes as blind-voice-only.js. Expect: "k30" lists only HG K 30.x rooms; "number 1" sets the start and asks
// "Where to?"; "the audimax" -> route preview to HG F 30.
async (page) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('polyguide.stt', 'browser'); // these fakes stand in for the browser's recognizer, not Whisper
    window.__spoken = [];
    window.__recs = [];
    class FakeRec {
      constructor() { this.running = false; window.__recs.push(this); }
      start() { if (this.running) throw new Error('already started'); this.running = true; this.startedAt = Date.now(); }
      stop() { this.running = false; setTimeout(() => this.onend && this.onend(), 0); }
      // Like Chrome: aborting a session that has barely started may never fire onend.
      abort() { const was = this.running; this.running = false; if (was && Date.now() - this.startedAt > 300) setTimeout(() => this.onend && this.onend(), 0); }
    }
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
    window.__listening = () => window.__recs.some((r) => r.running);
    window.__say = (text) => {
      const rec = window.__recs.find((r) => r.running);
      if (!rec) return false;
      rec.onresult && rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
      if (!rec.continuous) { rec.running = false; rec.onend && rec.onend(); }
      return true;
    };
    const synth = {
      speaking: false,
      // Like Android Chrome: speech is silent while a recognizer holds the mic.
      // Muted speech never reports its end.
      speak(u) { const muted = window.__listening(); window.__spoken.push((muted ? 'MUTED: ' : '') + u.text); if (muted) window.__muted = (window.__muted || 0) + 1; else setTimeout(() => u.onend && u.onend(), 5); },
      cancel() {}, getVoices() { return []; },
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  });
  await page.goto('http://localhost:5174/');
  const log = [];
  const wait = (ms) => page.waitForTimeout(ms);
  const heading = () => page.evaluate(() => document.querySelector('h1')?.textContent ?? '(start gate)');
  async function say(text) {
    await wait(1500);
    const ok = await page.evaluate((t) => window.__say(t), text);
    await wait(4500); // the model may be asked
    const spoken = await page.evaluate(() => window.__spoken.slice(-2).join(' | '));
    log.push(`SAY "${text}" -> heard=${ok} screen=${await heading()} :: ${spoken.slice(0, 160)}`);
  }
  await page.waitForSelector('.start-gate'); await wait(1000);
  await page.mouse.click(400, 300); await wait(500);
  for (const cmd of ['I am blind', 'next', 'next', 'k30', 'number 1', 'the audimax']) await say(cmd);
  return log;
}
