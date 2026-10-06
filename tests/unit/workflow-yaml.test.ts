import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseYaml, YamlError } from '../../cli/workflow-yaml.mjs';

/**
 * `kanon doctor` reads an adopter's workflows with Node's built-ins only (cli/workflow-yaml.mjs),
 * because the CLI installs nothing. A reader that disagreed with GitHub's on a grant or a `uses:`
 * would make doctor wrong without failing, so it is held to the `yaml` package's answer on every
 * YAML file in Kanon's tree (its workflows, actions and adopter fixtures), and on the shapes a
 * workflow can take that the tree may not hold today.
 */
const ROOT = process.cwd();
const files = execFileSync('git', ['ls-files', '*.yml', '*.yaml'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
// The one file in the tree it doesn't read: a CloudFormation template, which uses tags.
const NOT_READ = ['infra/telemetry/template.yaml'];

describe('the workflow YAML reader', () => {
  it('reads every YAML file in the tree as the yaml package does', () => {
    expect(files.length).toBeGreaterThan(80);
    const differ: string[] = [];
    for (const f of files.filter((x) => !NOT_READ.includes(x))) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      try {
        if (JSON.stringify(parseYaml(text)) !== JSON.stringify(parse(text))) differ.push(f);
      } catch (e) {
        differ.push(`${f}: ${(e as Error).message}`);
      }
    }
    expect(differ).toEqual([]);
  });

  it('refuses, by line, what it does not read', () => {
    for (const f of NOT_READ) expect(() => parseYaml(readFileSync(join(ROOT, f), 'utf8'))).toThrow(YamlError);
    expect(() => parseYaml('a: &x 1\nb: *x\n')).toThrow(/line 1: anchors and aliases are not read/);
    expect(() => parseYaml('a: 1\n---\nb: 2\n')).toThrow(/line 2/);
  });

  const cases: Record<string, string> = {
    'a folded scalar': 'a: >\n  one\n  two\n\n  three\n    more\n  four\n',
    'a folded scalar with leading blank lines': 'a: >-\n\n  x\n  y\n',
    'a literal scalar, stripped': 'a: |-\n  x\n\n',
    'a literal scalar, kept': 'a: |+\n  x\n\n\nb: 1\n',
    'an indentation indicator': 'a: |2\n    indented\n  base\n',
    'a sequence at its key\'s indentation': 'k:\n- a\n- b: 1\n  c: [x, \'y z\', {q: 1}]\n',
    'quoted scalars over several lines': 'a: "multi\n  line\n\n  quoted"\nb: \'it\'\'s\n  ok\'\n',
    'a plain scalar over several lines': "if: github.event_name == 'push' &&\n  github.ref == 'refs/heads/main'\nx: 1 # c\n",
    'permissions: write-all and an empty trigger': 'on:\n  push:\n    branches: [ main ]\n  pull_request:\npermissions: write-all\n',
    'nested sequences': '- - a\n  - b\n- c\n',
    'a flow mapping over several lines': 'x: {a: 1,\n  b: [2,\n  3]}\n',
    'quoted keys and the core schema': "'quoted key': v\n\"k2\": 0x1F\nn: ~\nf: 1.5e3\no: 0o17\nt: True\n",
    'an empty sequence item': 'a:\n  - b\n  -\n    c: 1\n',
    'double-quoted escapes': 'a: "esc \\t \\u00e9 \\"q\\""\n',
    'colons inside plain scalars': 'a: x:y\nb: http://x.y/z\nc: -1\n',
    'an expression and a comment': "run: echo ${{ secrets.X }} # not a comment? yes, it is\nuses: a/b@v1 #pinned\n",
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`reads ${name} as the yaml package does`, () => {
      expect(parseYaml(text)).toEqual(parse(text));
    });
  }
});
