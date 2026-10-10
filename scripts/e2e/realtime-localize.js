// Localization end to end, real WebRTC call: (A) with no known position, the background sign reader reads the
// room sign the fake camera shows and fixes the position by itself; (B) the camera then shows an ETH photo of
// HG F 30 that is NOT in data/hg/room-photos (held out), the user asks where they are, and the agent should use
// identify_room and name the Audimax. Also checks live captions and the per-turn camera frames.
// Needs apps/web/public/__e2e/{sign.jpg,f30.jpg,rt_hall.wav} (scripts/e2e/make-realtime-clips.sh; f30.jpg is
// HG F 30 photo 4 from ETH Room Information). Pass as a Playwright `page => ...` snippet; set BASE below.
async (page) => {
  const BASE = 'http://localhost:5185';
  await page.addInitScript(() => {
    localStorage.clear();
    window.__rt = [];
    window.__camImage = '/__e2e/sign.jpg';
    const t0 = performance.now();
    const log = (kind, data) => window.__rt.push({ t: Math.round(performance.now() - t0), kind, ...data });
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    document.addEventListener('pointerdown', () => ctx.resume(), true);
    window.__play = async (name) => {
      const buffer = await ctx.decodeAudioData(await (await fetch(`/__e2e/${name}.wav`)).arrayBuffer());
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(dest);
      s.start();
    };
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const img = new Image();
    let shown = '';
    setInterval(() => {
      if (shown !== window.__camImage) { shown = window.__camImage; img.src = shown; }
      if (img.complete && img.naturalWidth) canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    }, 100);
    navigator.mediaDevices.getUserMedia = async (c) => {
      await ctx.resume();
      const tracks = [];
      if (c.audio) tracks.push(dest.stream.getAudioTracks()[0].clone());
      if (c.video) tracks.push(canvas.captureStream(10).getVideoTracks()[0]);
      return new MediaStream(tracks);
    };
    setInterval(() => window.dispatchEvent(Object.assign(new Event('deviceorientationabsolute'), { alpha: 270, beta: 0, gamma: 0, absolute: true })), 50);
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, speak(u) { setTimeout(() => u.onend && u.onend(), 5); }, cancel() {}, getVoices() { return []; }, addEventListener() {} }, configurable: true });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const dc = create.apply(this, args);
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
        if (e.item?.type === 'function_call_output') log('tool_out', { out: e.item.output.slice(0, 400) });
        if (e.item?.role === 'system' && !String(e.item.content?.[0]?.text).startsWith('[Live state]')) log('note', { text: e.item.content[0].text });
        if (e.item?.role === 'system' && String(e.item.content?.[0]?.text).startsWith('[Live state]')) log('live_state', { text: e.item.content[0].text });
        if (String(e.item?.id ?? '').startsWith('cam_')) log('frame', {});
        send(data);
      };
      return dc;
    };
  });
  await page.goto(`${BASE}/`);
  const wait = (ms) => page.waitForTimeout(ms);
  const rt = () => page.evaluate(() => window.__rt);
  await page.waitForSelector('.start-gate');
  await page.mouse.click(400, 300);
  for (let i = 0; i < 60; i++) { if ((await rt()).some((e) => e.kind === 'said')) break; await wait(250); }

  // (A) Silent: the background reader should find the sign within ~25 s.
  let note = null;
  for (let i = 0; i < 120 && !note; i++) { note = (await rt()).find((e) => e.kind === 'note'); if (!note) await wait(250); }
  const peekVisible = await page.locator('.camera-peek').isVisible().catch(() => false);

  // (B) Inside the Audimax.
  await page.evaluate(() => { window.__camImage = '/__e2e/f30.jpg'; });
  await wait(1500);
  const before = (await rt()).length;
  await page.evaluate(() => window.__play('rt_hall'));
  const captions = new Set();
  let done = false;
  for (let i = 0; i < 300 && !done; i++) {
    const text = await page.locator('.convo-reply').first().innerText().catch(() => '');
    if (text) captions.add(text);
    const ev = (await rt()).slice(before);
    const heard = ev.findIndex((e) => e.kind === 'heard');
    done = ev.some((e) => e.kind === 'said' && /30|audimax/i.test(e.text)) || (heard >= 0 && ev.filter((e) => e.kind === 'said').length >= 3);
    await wait(150);
  }
  await wait(1500);
  const ev = (await rt()).slice(before);
  const brief = (l) => l.filter((e) => !['live_state', 'speech_stopped', 'audio_started'].includes(e.kind)).map((e) => `${e.t}ms ${e.kind}: ${e.text ?? e.name ?? ''} ${e.args ?? e.out ?? e.error ?? ''}`.slice(0, 330));
  return {
    signReader: note ? `${note.t}ms ${note.text}` : 'NO NOTE',
    peekVisible,
    framesAttachedThisTurn: ev.filter((e) => e.kind === 'frame').length,
    captionUpdates: captions.size,
    captionsSample: [...captions].slice(0, 4),
    log: brief(ev),
  };
}
