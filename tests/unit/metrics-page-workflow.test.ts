import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/metrics-page.yml', 'utf8'));

describe('the metrics page workflow', () => {
  it("grants the page job exactly the reads Kanon's health needs, the closing pull request included (#696)", () => {
    expect(workflow.jobs.page.permissions).toEqual({ contents: 'read', issues: 'read', 'pull-requests': 'read' });
  });
});
