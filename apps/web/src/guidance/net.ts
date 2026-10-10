/**
 * Guidance's own JSON fetch. Deliberately not ../api: that client falls back to fixtures on
 * network errors, and a fixture vision result or route must never move a real user along.
 */
export async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = (await res.json().catch(() => null)) as T | null;
    if (data == null) throw new Error(`Request failed (${res.status})`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
