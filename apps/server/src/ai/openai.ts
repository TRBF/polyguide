/**
 * Lazily created OpenAI client. Returns null when OPENAI_API_KEY is unset so every AI route can
 * answer `disabled` and guidance keeps working without AI (SPEC §5.1).
 */
import OpenAI from 'openai';

let client: OpenAI | null | undefined;

export function getOpenAI(): OpenAI | null {
  if (client === undefined) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    // No SDK retries: callers have hard latency budgets and handle failure themselves.
    client = apiKey ? new OpenAI({ apiKey, maxRetries: 0 }) : null;
  }
  return client;
}

export const visionModel = () => process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-4.1-mini';
export const textModel = () => process.env.OPENAI_TEXT_MODEL?.trim() || process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-4.1-mini';

/** Optional, for reasoning models only (e.g. "minimal" keeps latency low). Leave unset for non-reasoning models. */
export const reasoningEffort = () => {
  const v = process.env.OPENAI_REASONING_EFFORT?.trim();
  return v ? ({ effort: v } as { effort: 'minimal' | 'low' | 'medium' | 'high' }) : undefined;
};

export type AiFailure = 'timeout' | 'model_error' | 'rate_limited';

/** Map an SDK / abort error to a VisionResponse-style reason. Never includes request content. */
export function classifyError(err: unknown, aborted: boolean): { reason: AiFailure; message: string } {
  if (aborted || (err instanceof Error && /abort|timed? ?out/i.test(err.name + err.message))) {
    return { reason: 'timeout', message: 'The model did not answer in time.' };
  }
  const status = (err as { status?: number })?.status;
  if (status === 429) return { reason: 'rate_limited', message: 'The model is rate limited.' };
  return { reason: 'model_error', message: err instanceof Error ? err.message : 'Model error.' };
}

/** Short diagnostic for logs: error class, HTTP status and network cause. Never request content. */
export function describeError(err: unknown): string {
  const e = err as { constructor?: { name?: string }; status?: number; message?: string; cause?: { code?: string; message?: string; cause?: { code?: string } } };
  const cause = e?.cause?.code ?? e?.cause?.cause?.code ?? e?.cause?.message;
  return [e?.constructor?.name, e?.status, e?.message?.slice(0, 160), cause && `cause=${cause}`].filter(Boolean).join(' ');
}

/** Run fn with an AbortSignal that fires after ms. */
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}
