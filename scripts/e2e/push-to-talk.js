// Push-to-talk walkthrough for a touch user, with the same Chrome/Android-like speech fakes as
// blind-voice-only.js. Each command is one mic press; one press lands while the app is still talking.
// Expect heard=true on every line and the route to start.
async (page) => {
  await page.addInitScript(() => {
    localStorage.clear();
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
  const mic = () => page.locator('.button-mic');
  async function push(text, waitFirst = 1500) {
    await wait(waitFirst);
    await mic().click();
    await wait(100);
    const ok = await page.evaluate((t) => window.__say(t), text);
    await wait(1500);
    log.push(`PUSH+SAY "${text}" -> heard=${ok} screen=${await heading()} button="${await mic().innerText()}"`);
  }
  await page.waitForSelector('.start-gate'); await wait(1000);
  await page.mouse.click(400, 300); await wait(500);
  await page.getByRole('button', { name: 'Continue', exact: true }).click(); await wait(300);
  await page.getByRole('button', { name: 'Not now' }).click(); await wait(300);
  log.push(`touch user on ${await heading()}, button="${await mic().innerText()}"`);
  await push("i'm at hg e 41");
  await push('take me to hg f 30');
  await push('repeat', 0); // pressed while the app is still talking
  await push('start');
  await push('next');
  const spoken = await page.evaluate(() => window.__spoken);
  return { log, spoken: spoken.slice(-8).map((t) => t.slice(0, 90)) };
}
