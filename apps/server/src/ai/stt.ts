/**
 * POST /api/stt: speech to text with OpenAI Whisper. The phone records one spoken command (it cuts the
 * clip itself when the user stops talking) and posts the raw audio; we return the text, which the
 * client then handles like any other voice command. GET /api/stt says whether it is available, so the
 * client can fall back to the browser's own recognizer when there is no key.
 */
import { Hono } from 'hono';
import { toFile } from 'openai';
import { classifyError, describeError, getOpenAI, withTimeout } from './openai';

const TIMEOUT_MS = 8000;
/**
 * The phone cuts a command at 12 s: about 200 KB of AAC on iOS (128 kb/s), under 100 KB of Opus elsewhere.
 * Billing is per second of audio, so a low-bitrate file of minutes must not get through either.
 */
const MAX_BYTES = 400 * 1024;
const MIN_BYTES = 1000;

export const sttModel = () => process.env.OPENAI_STT_MODEL?.trim() || 'gpt-4o-mini-transcribe';

/** Vocabulary hint: Whisper spells room codes and command words the way the app parses them. */
const PROMPT = {
  en: 'PolyGuide voice commands at ETH: take me to HG F 30. Take me to the Audimax. Nearest toilet. Elevator. Main entrance. Mensa. I am at HG E 41. Next. Repeat. Where am I? What is ahead? Number 2. I am blind.',
  de: 'PolyGuide Sprachbefehle an der ETH: Bring mich zu HG F 30. Zum Audimax. Nächste Toilette. Lift. Haupteingang. Mensa. Ich bin bei HG E 41. Weiter. Wiederholen. Wo bin ich?',
} as const;

/** Whisper's well-known inventions on silence or noise; never real commands. */
const HALLUCINATIONS = [
  /^(thank you|thanks)( (so much|very much))?( for watching)?[.!]?$/i,
  // (Not "okay": it is a real answer to "Is that right?".)
  /^(you|bye)[.!]?$/i,
  /subtitles? (by|from)|amara\.org|please subscribe|like and subscribe/i,
  /^vielen dank( fürs zuschauen)?[.!]?$/i,
  /^untertitel/i,
];

const sentences = (text: string) => text.toLowerCase().split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
const PROMPT_SENTENCES = new Set([...sentences(PROMPT.en), ...sentences(PROMPT.de)]);

/** The transcript to act on, or '' when it is empty or a known hallucination. */
export function cleanTranscript(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed || /^[\s.,!?…-]*$/.test(trimmed)) return '';
  if (HALLUCINATIONS.some((re) => re.test(trimmed))) return '';
  // On silence Whisper recites the vocabulary prompt or makes up lists ("Number 1. Number 2. …").
  // A user says one command: never three sentences, never two of the prompt's.
  const said = sentences(trimmed);
  if (said.length >= 3 || said.filter((s) => PROMPT_SENTENCES.has(s)).length >= 2) return '';
  return trimmed;
}

function extensionFor(contentType: string): string {
  if (/webm/.test(contentType)) return 'webm';
  if (/ogg/.test(contentType)) return 'ogg';
  if (/mp4|m4a|aac/.test(contentType)) return 'm4a';
  if (/wav/.test(contentType)) return 'wav';
  if (/mpeg|mp3/.test(contentType)) return 'mp3';
  return 'webm';
}

export const sttRoutes = new Hono();

sttRoutes.get('/stt', (c) => c.json({ enabled: Boolean(getOpenAI()), model: sttModel() }));

sttRoutes.post('/stt', async (c) => {
  const openai = getOpenAI();
  if (!openai) return c.json({ ok: false, reason: 'disabled', message: 'Speech to text needs an OpenAI key on the server.' }, 503);
  const contentType = c.req.header('content-type') ?? 'audio/webm';
  if (!/^audio\//.test(contentType)) return c.json({ ok: false, reason: 'invalid_request', message: 'Send the audio as the request body.' }, 400);
  const audio = Buffer.from(await c.req.arrayBuffer());
  if (audio.length < MIN_BYTES) return c.json({ ok: true, text: '' });
  if (audio.length > MAX_BYTES) return c.json({ ok: false, reason: 'invalid_request', message: 'Recording too long.' }, 413);
  const language = c.req.query('lang') === 'de' ? 'de' : 'en';

  let aborted = false;
  const started = Date.now();
  try {
    const result = await withTimeout(TIMEOUT_MS, (signal) => {
      signal.addEventListener('abort', () => (aborted = true), { once: true });
      return toFile(audio, `speech.${extensionFor(contentType)}`, { type: contentType.split(';')[0] }).then((file) =>
        openai.audio.transcriptions.create({ file, model: sttModel(), language, prompt: PROMPT[language] }, { signal }));
    });
    return c.json({ ok: true, text: cleanTranscript(result.text ?? ''), latencyMs: Date.now() - started });
  } catch (err) {
    const { reason, message } = classifyError(err, aborted);
    console.warn(`stt failed: ${reason} (${describeError(err)})`);
    return c.json({ ok: false, reason, message }, reason === 'rate_limited' ? 429 : 502);
  }
});
