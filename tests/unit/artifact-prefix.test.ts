import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionFiles } from './helpers/actions.js';
import { ARTIFACT_PREFIX } from '../../scripts/lib/telemetry-artifacts.mjs';

/**
 * kanon#826: the collector reads every artifact whose name starts with `kanon-telemetry-` as a
 * lane's run row, and an artifact under that prefix without one fails the sweep. Only
 * `actions/agent-telemetry`'s row upload may use the prefix.
 */

const ROW_UPLOADER = 'actions/agent-telemetry/action.yml';

const files = (): string[] => [
  ...readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f)).map((f) => join('.github/workflows', f)),
  // Every action, nested ones too (kanon#927).
  ...actionFiles(),
];

/** The `name:` of each `upload-artifact` step, read from the text so a template stays as written. */
const uploadNames = (text: string): string[] => {
  const names: string[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!/uses:\s*actions\/upload-artifact@/.test(line)) return;
    const indent = line.search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() && next.search(/\S/) <= indent - 2) break;
      const m = /^\s+name:\s*(\S.*?)\s*$/.exec(next);
      if (m) { names.push(m[1]!.replace(/^['"]|['"]$/g, '')); break; }
    }
  });
  return names;
};

describe('only a lane\'s run row carries the collector\'s artifact prefix (kanon#826)', () => {
  it('finds the uploads it guards', () => {
    // Every action, nested ones too (kanon#927): plan 0011's hook actions sit one level down.
    expect(files()).toContain('actions/notify/slack/action.yml');
    expect(uploadNames(readFileSync(ROW_UPLOADER, 'utf8'))).toContain(`${ARTIFACT_PREFIX}\${{ inputs.lane }}-\${{ github.run_id }}-\${{ github.run_attempt }}`);
    expect(uploadNames(readFileSync('.github/workflows/agent-explore-telemetry.yml', 'utf8')).length).toBeGreaterThan(0);
  });

  it('no other upload names an artifact with the prefix', () => {
    const offenders = files().filter((f) => f !== ROW_UPLOADER)
      .flatMap((f) => uploadNames(readFileSync(f, 'utf8')).filter((n) => n.startsWith(ARTIFACT_PREFIX)).map((n) => `${f}: ${n}`));
    expect(offenders).toEqual([]);
  });

  it('would catch the Explorer\'s old name (mutation)', () => {
    const old = readFileSync('.github/workflows/agent-explore-telemetry.yml', 'utf8').replaceAll('kanon-explore-aggregate-', 'kanon-telemetry-aggregate-');
    expect(uploadNames(old).filter((n) => n.startsWith(ARTIFACT_PREFIX))).not.toEqual([]);
  });
});
