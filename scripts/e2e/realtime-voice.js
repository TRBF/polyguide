// Realtime voice end to end: real WebRTC call to OpenAI, spoken turns from espeak clips through a fake mic,
// a fake rear camera that shows an HG room sign, and a fake compass. Checks that the agent localizes the user
// from the camera, plans the trip, starts guidance on "yes" and answers with the live position.
// Run scripts/e2e/make-realtime-clips.sh first; needs the server with OPENAI_API_KEY.
// Pass this file as a Playwright `page => ...` snippet; set BASE below.
async (page) => {
  const BASE = 'http://localhost:5185';
  await page.addInitScript(() => {
    localStorage.clear();
    window.__spoken = [];
    window.__rt = [];
    window.__heading = 90;
    const t0 = performance.now();
    const log = (kind, data) => window.__rt.push({ t: Math.round(performance.now() - t0), kind, ...data });
    // Fake mic: whatever window.__play() plays.
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    document.addEventListener('pointerdown', () => ctx.resume(), true);
    window.__play = async (name) => {
      const buffer = await ctx.decodeAudioData(await (await fetch(`/__e2e/${name}.wav`)).arrayBuffer());
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest);
      source.start();
      return buffer.duration;
    };
    // Fake rear camera: the sign photo, redrawn so the stream keeps producing frames.
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 640;
    const img = new Image();
    img.src = '/__e2e/sign.jpg';
    setInterval(() => img.complete && canvas.getContext('2d').drawImage(img, 0, 0), 100);
    navigator.mediaDevices.getUserMedia = async (c) => {
      await ctx.resume();
      const tracks = [];
      if (c.audio) tracks.push(dest.stream.getAudioTracks()[0].clone());
      if (c.video) tracks.push(canvas.captureStream(10).getVideoTracks()[0]);
      return new MediaStream(tracks);
    };
    // Fake compass (Android-style absolute orientation): heading = 360 - alpha when flat.
    setInterval(() => window.dispatchEvent(Object.assign(new Event('deviceorientationabsolute'), { alpha: (360 - window.__heading) % 360, beta: 0, gamma: 0, absolute: true })), 50);
    // Browser voice (fallback only): record instead of speaking.
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); }, cancel() {}, getVoices() { return []; }, addEventListener() {} }, configurable: true });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    // Tap the realtime event channel.
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const dc = create.apply(this, args);
      window.__channels = (window.__channels ?? 0) + 1;
      dc.addEventListener('message', (m) => {
        const e = JSON.parse(m.data);
        if (e.type === 'input_audio_buffer.speech_stopped') log('speech_stopped', {});
        if (e.type === 'output_audio_buffer.started') log('audio_started', {});
        if (e.type === 'conversation.item.input_audio_transcription.completed') log('heard', { text: e.transcript });
        if (e.type === 'response.output_audio_transcript.done') log('said', { text: e.transcript });
        if (e.type === 'response.function_call_arguments.done') log('tool', { name: e.name, args: e.arguments });
        if (e.type === 'error') log('error', { error: JSON.stringify(e.error) });
      });
      const send = dc.send.bind(dc);
      dc.send = (data) => {
        const e = JSON.parse(data);
        if (e.item?.type === 'function_call_output') log('tool_out', { out: e.item.output.slice(0, 300) });
        if (e.item?.role === 'system') log('live_state', { text: e.item.content[0].text });
        send(data);
      };
      return dc;
    };
  });
  await page.goto(`${BASE}/`);
  const wait = (ms) => page.waitForTimeout(ms);
  const rt = () => page.evaluate(() => window.__rt);
  const status = () => page.locator('.voice-bar [role=status]').first().innerText().catch(() => '');
  async function waitFor(pred, ms) {
    for (let i = 0; i < ms / 200; i += 1) {
      if (pred(await rt())) return true;
      await wait(200);
    }
    return false;
  }
  await page.waitForSelector('.start-gate');
  await page.mouse.click(400, 300);
  let connected = false;
  for (let i = 0; i < 60 && !connected; i += 1) {
    connected = /Listening|Speaking|Thinking/.test(await status());
    if (!connected) await wait(250);
  }
  const result = { connected };
  // Let the greeting finish.
  await waitFor((l) => l.some((e) => e.kind === 'said'), 20000);
  await wait(1500);

  async function turn(clip, until, ms = 40000, settle = 1200) {
    const before = (await rt()).length;
    await page.evaluate((n) => window.__play(n), clip);
    const ok = await waitFor((l) => until(l.slice(before)), ms);
    await wait(settle);
    return { ok, events: (await rt()).slice(before) };
  }
  const said = (l, re) => l.some((e) => e.kind === 'said' && re.test(e.text));

  const t1 = await turn('rt_lost', (l) => said(l, /right\?|correct\?|Shall|Should|confirm/i));
  const t2 = await turn('rt_yes', (l) => l.some((e) => e.kind === 'tool' && e.name === 'start_navigation') && l.filter((e) => e.kind === 'said').length >= 1, 30000, 6000);
  const screen = await page.locator('h1').first().innerText().catch(() => '');
  // The user turned to face south-south-west: the answer should reflect the new heading.
  await page.evaluate(() => { window.__heading = 200; });
  const t3 = await turn('rt_which', (l) => { const h = l.findIndex((e) => e.kind === 'heard'); return h >= 0 && l.slice(h).some((e) => e.kind === 'said'); }, 30000);

  const latency = (events) => {
    const stop = events.find((e) => e.kind === 'speech_stopped');
    const audio = stop && events.find((e) => e.kind === 'audio_started' && e.t > stop.t);
    return stop && audio ? audio.t - stop.t : null;
  };
  const brief = (events) => events.filter((e) => e.kind !== 'live_state' && e.kind !== 'speech_stopped' && e.kind !== 'audio_started').map((e) => `${e.t}ms ${e.kind}: ${e.text ?? e.name ?? ''} ${e.args ?? e.out ?? e.error ?? ''}`.slice(0, 260));
  const lastState = (events) => [...events].reverse().find((e) => e.kind === 'live_state')?.text;
  return {
    ...result,
    screen,
    realtimeSessions: await page.evaluate(() => window.__channels),
    instruction: await page.locator('.hud-instruction').innerText().catch(() => ''),
    fallbackSpoken: await page.evaluate(() => window.__spoken),
    turn1: { ok: t1.ok, firstAudioMs: latency(t1.events), log: brief(t1.events) },
    turn2: { ok: t2.ok, firstAudioMs: latency(t2.events), log: brief(t2.events) },
    turn3: { ok: t3.ok, firstAudioMs: latency(t3.events), log: brief(t3.events), liveState: lastState(t3.events) },
  };
}
