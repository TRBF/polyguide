// Voice-only (blind) walkthrough: one tap on the start gate, then every step by simulated speech.
// Fakes SpeechRecognition (window.__say) and speechSynthesis (window.__spoken).
// Run with `pnpm dev:server` + `pnpm --filter @polyguide/web dev:http`, then pass this file as a
// Playwright `page => ...` snippet (e.g. Playwright MCP browser_run_code). Expect taps === 1 and a final "You've arrived".
async (page) => {
  await page.addInitScript(() => {
    localStorage.clear();
    window.__spoken = [];
    window.__recs = [];
    class FakeRec {
      constructor() { this.running = false; window.__recs.push(this); }
      start() { if (this.running) throw new Error('already started'); this.running = true; }
      stop() { this.running = false; setTimeout(() => this.onend && this.onend(), 0); }
      abort() { this.running = false; }
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
      speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); },
      cancel() {}, getVoices() { return []; },
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  });
  await page.goto('http://localhost:5174/');
  const log = [];
  let taps = 0;
  const wait = (ms) => page.waitForTimeout(ms);
  const heading = () => page.evaluate(() => document.querySelector('h1')?.textContent ?? '(start gate)');
  async function say(text) {
    await wait(1500); // the app ignores the mic for 1.2 s after its own speech
    const ok = await page.evaluate((t) => window.__say(t), text);
    await wait(900);
    log.push(`SAY "${text}" -> heard=${ok} screen=${await heading()}`);
    return ok;
  }
  // The single unavoidable gesture: browsers block speech/mic until one.
  await page.waitForSelector('.start-gate'); await wait(1000);
  await page.mouse.click(400, 300); taps++;
  await wait(500);
  log.push(`after tap: screen=${await heading()} listening=${await page.evaluate(() => window.__listening())}`);
  for (const cmd of [
    'help', 'I am blind', 'next', 'enable', 'help',
    "i'm at hg e 41", 'take me to hg f 30', 'repeat', 'start',
    'where am i', 'next', 'next', 'next', 'next', 'next', 'next', 'next', 'next', 'next', 'next',
  ]) {
    if ((await heading()).includes('arrived')) break;
    const ok = await say(cmd);
    if (!ok) { log.push('  mic not listening -> blind user would have to tap the mic'); break; }
  }
  const spoken = await page.evaluate(() => window.__spoken);
  return { taps, log, spoken: spoken.map((s) => s.slice(0, 140)) };
}
