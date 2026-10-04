import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestWebhook } from '../../scripts/lib/digest-webhook.mjs';
import { ROOT } from './helpers/adopter.js';

/**
 * The digests' webhook (plan 0004, decision 7): the lanes pass the caller's `DIGEST_WEBHOOK`
 * secret under its own name, and the reference adopter's own workflows passed
 * `SLACK_RELEASE_WEBHOOK` until they called the lanes.
 */
describe('the webhook the digests post to', () => {
  it('is the lane\'s fixed name first', () => {
    expect(digestWebhook({ DIGEST_WEBHOOK: 'https://hook/a', SLACK_RELEASE_WEBHOOK: 'https://hook/b' })).toBe('https://hook/a');
  });

  it('falls back to the name the reference adopter passed before it called the lanes', () => {
    expect(digestWebhook({ SLACK_RELEASE_WEBHOOK: 'https://hook/b' })).toBe('https://hook/b');
    expect(digestWebhook({ DIGEST_WEBHOOK: '', SLACK_RELEASE_WEBHOOK: 'https://hook/b' })).toBe('https://hook/b');
  });

  it('is empty when neither is set, so the digest posts nothing', () => {
    expect(digestWebhook({})).toBe('');
  });

  it.each(['project-digest', 'weekly-digest'])('%s posts to it, and to nothing else', (name) => {
    const code = readFileSync(join(ROOT, 'scripts', `${name}.mjs`), 'utf8');
    expect(code).toMatch(/const webhook = digestWebhook\(process\.env\);/);
    // No second read of either variable, destructured or direct.
    expect(code).not.toMatch(/SLACK_RELEASE_WEBHOOK/);
    expect(code).not.toMatch(/\bDIGEST_WEBHOOK\s*[,}:]|env\.DIGEST_WEBHOOK/);
  });
});
