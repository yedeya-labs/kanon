/**
 * The runner's OIDC endpoint and a telemetry store's token URL, as one fake `fetch` (plan 0008
 * §2.1, step J5), for the reading lanes' tests: each request to the runner mints a new token,
 * numbered, and each request to the store is recorded with its method, path, query and bearer
 * token, and answered by `answer`. Never a real token: a JWS-shaped string the fake makes.
 */
export const RUNNER_ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://runner.example/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token' };
/** A self-hosted store's token URL and audience, and a stand-in for the hosted URL. */
export const SELF_URL = 'https://abc123def.lambda-url.eu-central-1.on.aws/';
export const SELF_AUDIENCE = 'acme-telemetry';
export const HOSTED_URL = 'https://hosted0123.lambda-url.eu-central-1.on.aws/';
export const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

export type StoreCall = { url: string; host: string; path: string; query: Record<string, string>; method: string; auth?: string };
export type StoreAnswer = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

export function tokenNet(answer: (call: StoreCall) => StoreAnswer | Promise<StoreAnswer>) {
  const calls: StoreCall[] = [];
  const minted: string[] = [];
  const fetchImpl = (async (url: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const u = new URL(url);
    if (u.host === 'runner.example') {
      const token = `${TOKEN}${minted.length + 1}`;
      minted.push(token);
      return new Response(JSON.stringify({ value: token }), { status: 200 });
    }
    const call = { url, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? 'GET', auth: init.headers?.authorization };
    calls.push(call);
    const a = await answer(call);
    return new Response(a.text ?? (a.json === undefined ? '' : JSON.stringify(a.json)), { status: a.status, headers: a.headers });
  }) as unknown as typeof fetch;
  return { calls, minted, fetchImpl };
}
