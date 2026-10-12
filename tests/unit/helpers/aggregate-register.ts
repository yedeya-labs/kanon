import { generateKeyPairSync, sign } from 'node:crypto';

import { ISSUER, keyCache } from '../../../infra/telemetry/function/oidc.mjs';
import { AGGREGATE_GET, AGGREGATE_SCAN } from '../../../infra/telemetry/function/register-fields.mjs';

/**
 * Plan 0008 J4's fakes for the aggregate function: the register table, as the aggregate role
 * sees it, and GitHub's OIDC tokens, signed with a key pair made here. Nothing leaves the process.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/** One registration, as the operator's CLI and the ingest function would have written it. */
export type Registration = {
  repository_id: string, key: string, status?: string, label?: string, owner?: string, default_ref?: string,
  aggregate_invoker?: boolean, page_reader?: boolean,
};

export const OWNER = '7890';
export const DEFAULT_REF = 'refs/heads/main';

const attribute = (v: unknown) => (typeof v === 'boolean' ? { BOOL: v } : typeof v === 'number' ? { N: String(v) } : { S: String(v) });
const itemOf = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, attribute(v)]));

/** Every field of a registration item, the ones no aggregate projection names among them. */
const stored = (r: Registration) => itemOf({
  pk: `repo#${r.repository_id}`, repository_id: r.repository_id, repository_owner_id: r.owner ?? OWNER,
  repository: `octo/${r.key}`, key: r.key, status: r.status ?? 'active', default_ref: r.default_ref ?? DEFAULT_REF,
  name_hashes: 'h1,h2', publish_own_figures_as: r.label, aggregate_invoker: r.aggregate_invoker, page_reader: r.page_reader,
});

/**
 * A fake register table. Like IAM on the aggregate role (plan 0008 §5.3), it refuses a Scan that
 * names an attribute outside `AGGREGATE_SCAN` or leaves `Select` unnamed, and a GetItem that
 * names one outside `AGGREGATE_GET` or none at all, with DynamoDB's 400. Its Scan answers one item
 * a page, so paging is followed, and holds key items and a counter beside the registrations.
 */
export function fakeRegister(registrations: Registration[], { failScan = false }: { failScan?: boolean } = {}) {
  const items = [
    ...registrations.map(stored),
    ...registrations.map((r) => itemOf({ pk: `key#${r.key}`, repository_id: r.repository_id })),
    itemOf({ pk: 'count#all#2026-10-07', n: 3, expires_at: 1 }),
  ];
  const scans: J[] = [];
  const gets: J[] = [];
  const project = (item: Record<string, J>, req: J) => {
    const wanted = Object.values(req.ExpressionAttributeNames ?? {}) as string[];
    return Object.fromEntries(Object.entries(item).filter(([k]) => wanted.includes(k)));
  };
  const scan = async (req: J) => {
    scans.push(req);
    const names = Object.values(req.ExpressionAttributeNames ?? {}) as string[];
    if (failScan || req.Select !== 'SPECIFIC_ATTRIBUTES' || names.length === 0 || !names.every((n) => AGGREGATE_SCAN.includes(n))) {
      throw new Error('Scan 400');
    }
    const from = req.ExclusiveStartKey ? Number(req.ExclusiveStartKey.i.N) : 0;
    return {
      Items: items.slice(from, from + 1).map((i) => project(i, req)),
      ...(from + 1 < items.length ? { LastEvaluatedKey: { i: { N: String(from + 1) } } } : {}),
    };
  };
  const getItem = async (req: J) => {
    gets.push(req);
    const names = Object.values(req.ExpressionAttributeNames ?? {}) as string[];
    if (names.length === 0 || !names.every((n) => AGGREGATE_GET.includes(n))) throw new Error('GetItem 400');
    const item = items.find((i) => i.pk?.S === req.Key?.pk?.S);
    return item ? { Item: project(item, req) } : {};
  };
  return { scan, getItem, scans, gets };
}

export const AUDIENCE = 'kanon-telemetry';
export const MIN_VERSION = '0.40.0';
export const EXPLORE = 'yedeya-labs/kanon/.github/workflows/agent-explore-telemetry.yml';
export const METRICS_PAGE = 'yedeya-labs/kanon/.github/workflows/metrics-page.yml';
export const ALIAS_ARN = `arn:aws:lambda:eu-central-1:${'5'.repeat(12)}:function:kanon-telemetry-aggregate:live`;
export const UNQUALIFIED_ARN = `arn:aws:lambda:eu-central-1:${'5'.repeat(12)}:function:kanon-telemetry-aggregate`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** GitHub's JWKS, as a fake `fetch` serving the test's public key. */
export const keys = () => keyCache({
  fetchImpl: (async () => new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] }), { status: 200 })) as unknown as typeof fetch,
});

/** A token GitHub would sign: the Explorer at a release, on the default branch, by schedule. */
export function token(now: number, repositoryId: string, over: Record<string, unknown> = {}) {
  const t = Math.floor(now / 1000);
  const claims = {
    iss: ISSUER, aud: AUDIENCE, iat: t - 30, nbf: t - 630, exp: t + 270, event_name: 'schedule',
    job_workflow_ref: `${EXPLORE}@refs/tags/v0.40.0`, workflow_ref: `yedeya-labs/kanon-caller/.github/workflows/explore.yml@${DEFAULT_REF}`,
    repository_id: repositoryId, repository_owner_id: OWNER, repository: 'octo/widget', ref: DEFAULT_REF, ref_type: 'branch',
    ...over,
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete (claims as Record<string, unknown>)[k];
  const input = `${b64({ typ: 'JWT', alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** Kanon's metrics page workflow's token: `metrics-page.yml` at the default branch, no reusable workflow. */
export const pageToken = (now: number, repositoryId: string, over: Record<string, unknown> = {}) =>
  token(now, repositoryId, { job_workflow_ref: undefined, workflow_ref: `${METRICS_PAGE}@${DEFAULT_REF}`, ...over });

/** A Function URL event on the token URL: a GET with the bearer token, and the query asked. */
export const tokenEvent = (bearer: string | undefined, query?: Record<string, string>) => ({
  requestContext: { http: { method: 'GET' } },
  headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  ...(query ? { queryStringParameters: query } : {}),
});

/** The token path's environment. */
export const tokenEnv = { TABLE_NAME: 'kanon-telemetry', AUDIENCE, MIN_TOKEN_VERSION: MIN_VERSION, INVOKER_KEYS: '' };
