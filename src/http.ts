// Small fetch helpers: retries for 5xx, 429 and network errors; everything else is final.

export type Fetch = typeof fetch;

export const DEFAULT_RETRY_DELAYS_MS = [500, 2000] as const;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const retryable = (status: number): boolean => status >= 500 || status === 429;

export interface Attempted {
  response?: Response;
  error?: unknown;
  attempts: number;
}

/**
 * Call ``send`` until it returns a response that is not retryable, at most ``delays.length + 1``
 * times (3 by default), waiting ``delays[i]`` before retry ``i + 1``.
 */
export async function withRetries(send: () => Promise<Response>, delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS): Promise<Attempted> {
  let last: Attempted = { attempts: 0 };
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await sleep(delays[i - 1]!);
    try {
      const response = await send();
      last = { response, attempts: i + 1 };
      if (!retryable(response.status)) return last;
      if (i < delays.length) await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      last = { error, attempts: i + 1 };
    }
  }
  return last;
}

export async function readJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return undefined;
  }
}

export async function describe(r: Response): Promise<string> {
  let text = '';
  try {
    text = (await r.text()).slice(0, 300);
  } catch {
    // ignore
  }
  return `HTTP ${r.status}${text ? `: ${text}` : ''}`;
}

/** Strip a trailing slash so ``${base}/v1/...`` never doubles it. */
export const trimBase = (url: string): string => url.replace(/\/+$/, '');
