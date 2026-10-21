import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  KINDS,
  KIND_SECRETS,
  LIMITS,
  SCHEMAS,
  SEVERITIES,
  SOURCE_LANES,
  describeErrors,
  fit,
  jsonSchema,
  jsonSchemaText,
  literal,
  measure,
  plainText,
  prose,
  renderText,
  validate,
} from '../../scripts/lib/notify-contract.mjs';
import { ROOT } from './helpers/adopter.js';
import { schemaAccepts } from './helpers/json-schema.js';

/**
 * Plan 0011 step N2, the notification contract (§3): `validate`, `literal`, `prose`, `fit`,
 * `renderText`, `SCHEMAS`, `KIND_SECRETS` and the published JSON Schema. Every "What must be true"
 * of the N2 row is a case here, by name.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a message is read field by field, as the tests build it
type Msg = Record<string, any>;

const SOURCE = { repository: 'acme/widgets', lane: 'project-digest', run_url: 'https://github.com/acme/widgets/actions/runs/1' };

const FIXTURES: Record<string, Msg> = {
  'project-digest': {
    schema_version: 1,
    kind: 'project-digest',
    severity: 'warning',
    title: 'Projects, Tuesday 14 October',
    summary: 'Three projects open. One is stopped on a decision you owe: [#812](https://github.com/acme/widgets/issues/812).',
    sections: [{
      heading: 'Stopped',
      body: '- [#812](https://github.com/acme/widgets/issues/812) Merge retry: the Implementer posted a plan and stopped for a decision.',
      fields: [{ label: 'Open issues', value: '4' }, { label: 'Waiting', value: '2 days' }],
    }],
    links: [{ label: 'The run', url: 'https://github.com/acme/widgets/actions/runs/1' }],
    source: SOURCE,
  },
  'weekly-digest': {
    schema_version: 1,
    kind: 'weekly-digest',
    severity: 'info',
    title: 'The week in acme/widgets',
    summary: 'Four changes shipped, **none** waiting on you.',
    sections: [{ body: 'Checkout is _faster_.\n\nThe `search` page loads in half the time.' }],
    source: { ...SOURCE, lane: 'weekly-digest' },
  },
  deploy: {
    schema_version: 1,
    kind: 'deploy',
    severity: 'critical',
    title: 'Production deploy of 2.4.0 failed',
    summary: 'Production still runs 2.3.1.',
    links: [{ label: 'Release 2.4.0', url: 'https://github.com/acme/widgets/releases/tag/v2.4.0' }],
    source: { ...SOURCE, lane: 'deploy' },
  },
  release: {
    schema_version: 1,
    kind: 'release',
    severity: 'info',
    title: 'Pre-release v2.5.0-rc.1 of acme/widgets',
    summary: 'A **pre-release** (a candidate), **v2.5.0-rc.1**, is published.',
    sections: [{ heading: 'Features', body: '- search: filter by tag ([#901](https://github.com/acme/widgets/pull/901))' }],
    links: [{ label: 'Release v2.5.0-rc.1', url: 'https://github.com/acme/widgets/releases/tag/v2.5.0-rc.1' }],
    source: { ...SOURCE, lane: 'release-announce' },
  },
};

const clone = (m: Msg): Msg => structuredClone(m);
const base = () => clone(FIXTURES['project-digest']!);
const errorsOf = (m: unknown) => {
  const r = validate(m);
  return r.ok ? [] : r.errors;
};
/** A value no problem may echo: it is in every oversized string below. */
const SENTINEL = 'Zq7SENTINEL';
const fill = (n: number) => (SENTINEL + 'x'.repeat(n)).slice(0, n);

describe('the kinds, the severities and the secrets', () => {
  it('a fixture of each of the four kinds validates', () => {
    expect(Object.keys(FIXTURES)).toEqual([...KINDS]);
    for (const m of Object.values(FIXTURES)) expect(validate(m)).toEqual({ ok: true });
  });

  it('has no `health` kind, and refuses one (decision 13)', () => {
    expect(KINDS).toEqual(['project-digest', 'weekly-digest', 'deploy', 'release']);
    expect(KINDS).not.toContain('health');
    expect(errorsOf({ ...base(), kind: 'health' })).toEqual([{ field: 'kind', problem: 'enum' }]);
  });

  it('names one secret per kind, `KANON_CHAT_` and the kind in capitals (decision 3)', () => {
    expect(KIND_SECRETS).toEqual({
      'project-digest': 'KANON_CHAT_PROJECT_DIGEST',
      'weekly-digest': 'KANON_CHAT_WEEKLY_DIGEST',
      deploy: 'KANON_CHAT_DEPLOY',
      release: 'KANON_CHAT_RELEASE',
    });
  });

  // The `release` kind (kanon#1190) comes from a lane named for what it does, not for its kind, so
  // the lanes are the kinds' producers by name: the digests and the deploy lane by their kind's,
  // the release announcement as `release-announce`. No lane is called `release`.
  it('admits each producing lane as `source.lane`, the release announcement as release-announce (kanon#1190)', () => {
    expect(SOURCE_LANES).toEqual(['project-digest', 'weekly-digest', 'deploy', 'release-announce']);
    const release = FIXTURES.release!;
    expect(validate(release)).toEqual({ ok: true });
    expect(errorsOf({ ...release, source: { ...SOURCE, lane: 'release' } })).toEqual([{ field: 'source.lane', problem: 'enum' }]);
  });

  it('has three severities and one version, the one `fit` writes', () => {
    expect(SEVERITIES).toEqual(['info', 'warning', 'critical']);
    expect(Object.keys(SCHEMAS)).toEqual(['1']);
    expect(CONTRACT_VERSION).toBe(1);
  });
});

/**
 * Each limit, at its value and one past it: the message is valid at the limit and refused one past,
 * naming the field and never the value.
 */
const LIMIT_CASES: { name: string; at: (n: number) => Msg; limit: number; field: string }[] = [
  { name: 'title', limit: LIMITS.title, field: 'title', at: (n) => ({ ...base(), title: fill(n) }) },
  { name: 'summary', limit: LIMITS.summary, field: 'summary', at: (n) => ({ ...base(), summary: fill(n) }) },
  { name: 'sections', limit: LIMITS.sections, field: 'sections', at: (n) => ({ ...base(), sections: Array.from({ length: n }, () => ({ body: SENTINEL })) }) },
  { name: 'a heading', limit: LIMITS.heading, field: 'sections[0].heading', at: (n) => ({ ...base(), sections: [{ heading: fill(n), body: 'b' }] }) },
  { name: 'a body', limit: LIMITS.body, field: 'sections[0].body', at: (n) => ({ ...base(), sections: [{ body: fill(n) }] }) },
  { name: 'fields', limit: LIMITS.fields, field: 'sections[0].fields', at: (n) => ({ ...base(), sections: [{ body: 'b', fields: Array.from({ length: n }, () => ({ label: SENTINEL, value: 'v' })) }] }) },
  { name: "a field's label", limit: LIMITS.fieldLabel, field: 'sections[0].fields[0].label', at: (n) => ({ ...base(), sections: [{ body: 'b', fields: [{ label: fill(n), value: 'v' }] }] }) },
  { name: "a field's value", limit: LIMITS.fieldValue, field: 'sections[0].fields[0].value', at: (n) => ({ ...base(), sections: [{ body: 'b', fields: [{ label: 'l', value: fill(n) }] }] }) },
  { name: 'links', limit: LIMITS.links, field: 'links', at: (n) => ({ ...base(), links: Array.from({ length: n }, () => ({ label: SENTINEL, url: 'https://e.example/' })) }) },
  { name: "a link's label", limit: LIMITS.linkLabel, field: 'links[0].label', at: (n) => ({ ...base(), links: [{ label: fill(n), url: 'https://e.example/' }] }) },
  { name: "a link's URL", limit: LIMITS.url, field: 'links[0].url', at: (n) => ({ ...base(), links: [{ label: 'l', url: `https://e.example/${fill(n - 18)}` }] }) },
  { name: 'the run URL', limit: LIMITS.url, field: 'source.run_url', at: (n) => ({ ...base(), source: { ...SOURCE, run_url: `https://e.example/${fill(n - 18)}` } }) },
];

describe('each limit is refused at one past it, naming the field and never the value', () => {
  it.each(LIMIT_CASES)('$name', ({ at, limit, field }) => {
    expect(validate(at(limit))).toEqual({ ok: true });
    const errors = errorsOf(at(limit + 1));
    expect(errors).toEqual([{ field, problem: 'range' }]);
    expect(JSON.stringify(errors)).not.toContain(SENTINEL);
    expect(describeErrors(errors)).toBe(`${field} (range)`);
  });

  it('every string field is refused empty', () => {
    expect(errorsOf({ ...base(), title: '' })).toEqual([{ field: 'title', problem: 'range' }]);
    expect(errorsOf({ ...base(), sections: [{ body: '' }] })).toEqual([{ field: 'sections[0].body', problem: 'range' }]);
  });

  // Every string together, at 12,000 characters: twelve sections of 1,000, less the rest.
  const wide = (extra: number) => {
    const m = base();
    delete m.links;
    m.sections = [];
    const rest = measure(m).chars;
    const total = LIMITS.messageChars - rest + extra;
    for (let left = total; left > 0; left -= LIMITS.body) m.sections.push({ body: fill(Math.min(LIMITS.body, left)) });
    return m;
  };

  it('the whole message: 12,000 characters of text across every field', () => {
    expect(measure(wide(0)).chars).toBe(LIMITS.messageChars);
    expect(validate(wide(0))).toEqual({ ok: true });
    const errors = errorsOf(wide(1));
    expect(errors).toEqual([{ field: '(message)', problem: 'too-long' }]);
    expect(JSON.stringify(errors)).not.toContain(SENTINEL);
  });

  it('the whole message: 64 KiB as JSON', () => {
    // A control character is one character and six bytes of JSON (`\u0001`): 11,000 of them in
    // bodies stay under 12,000 characters and pass 64 KiB.
    const m = base();
    m.sections = Array.from({ length: 5 }, () => ({ body: '\u0001'.repeat(2200) }));
    expect(measure(m).chars).toBeLessThanOrEqual(LIMITS.messageChars);
    expect(measure(m).bytes).toBeGreaterThan(LIMITS.messageBytes);
    expect(errorsOf(m)).toEqual([{ field: '(message)', problem: 'too-large' }]);
  });
});

describe('what else is refused', () => {
  it('an unknown field, at the top and inside, by name; a key that is not a field name, unnamed', () => {
    expect(errorsOf({ ...base(), colour: 'red' })).toEqual([{ field: 'colour', problem: 'unknown' }]);
    expect(errorsOf({ ...base(), sections: [{ body: 'b', image: 'x' }] })).toEqual([{ field: 'sections[0].image', problem: 'unknown' }]);
    expect(errorsOf({ ...base(), source: { ...SOURCE, [`${SENTINEL} key`]: 1 } })).toEqual([{ field: 'source.(unnamed)', problem: 'unknown' }]);
  });

  it('an `http:` link', () => {
    expect(errorsOf({ ...base(), links: [{ label: 'l', url: `http://e.example/${SENTINEL}` }] })).toEqual([{ field: 'links[0].url', problem: 'pattern' }]);
    expect(errorsOf({ ...base(), source: { ...SOURCE, run_url: 'http://e.example/' } })).toEqual([{ field: 'source.run_url', problem: 'pattern' }]);
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('a line break (%j) in a title, a heading, a label', (br) => {
    expect(errorsOf({ ...base(), title: `a${br}${SENTINEL}` })).toEqual([{ field: 'title', problem: 'line-break' }]);
    expect(errorsOf({ ...base(), sections: [{ heading: `a${br}b`, body: 'b' }] })).toEqual([{ field: 'sections[0].heading', problem: 'line-break' }]);
    expect(errorsOf({ ...base(), links: [{ label: `a${br}b`, url: 'https://e.example/' }] })).toEqual([{ field: 'links[0].label', problem: 'line-break' }]);
    // A field's value, the summary and a body may hold one.
    expect(validate({ ...base(), summary: `a${br}b`, sections: [{ body: `a${br}b`, fields: [{ label: 'l', value: `a${br}b` }] }] })).toEqual({ ok: true });
  });

  it('a missing required field, a wrong type, an unknown version, a repository or lane that is not one', () => {
    const m = base();
    delete m.summary;
    expect(errorsOf(m)).toEqual([{ field: 'summary', problem: 'required' }]);
    expect(errorsOf({ ...base(), sections: { body: 'b' } })).toEqual([{ field: 'sections', problem: 'type' }]);
    expect(errorsOf({ ...base(), schema_version: 2 })).toEqual([{ field: 'schema_version', problem: 'enum' }]);
    expect(errorsOf({ ...base(), severity: 'urgent' })).toEqual([{ field: 'severity', problem: 'enum' }]);
    expect(errorsOf({ ...base(), source: { ...SOURCE, repository: 'acme' } })).toEqual([{ field: 'source.repository', problem: 'pattern' }]);
    expect(errorsOf({ ...base(), source: { ...SOURCE, lane: 'review' } })).toEqual([{ field: 'source.lane', problem: 'enum' }]);
    expect(errorsOf(null)).toEqual([{ field: '(message)', problem: 'type' }]);
    expect(errorsOf([])).toEqual([{ field: '(message)', problem: 'type' }]);
  });

  it('Kanon text refuses no character: markup that forms nothing, HTML, a heading and a table are text', () => {
    const body = '# not a heading\n| a | b |\n<b>&amp;</b> <!channel> **open *lone _x [y](http://z) `';
    expect(validate({ ...base(), summary: body, sections: [{ body }] })).toEqual({ ok: true });
  });
});

describe('text nobody controls never makes a message invalid', () => {
  const titles = ['Support Array<string>', '**urgent** fix for snake_case_name'];
  const narrative = '# The week\nSomething **shipped**.\n| a | b |\nNothing \\* else.';
  const draft = () => ({
    kind: 'project-digest',
    severity: 'info',
    title: `Projects: ${titles[1]}`,
    summary: prose(narrative),
    sections: [{
      heading: 'Open',
      body: titles.map((t, i) => `- [#${i + 1}](https://github.com/acme/widgets/issues/${i + 1}) ${literal(t)}`).join('\n'),
    }],
    source: SOURCE,
  });

  it('validates after `literal` and `prose`, and `renderText` returns each exactly as written', () => {
    const m = fit(draft());
    expect(validate(m)).toEqual({ ok: true });
    const text = renderText(m);
    for (const t of titles) expect(text).toContain(t);
    expect(text).toContain('# The week\nSomething shipped.\n| a | b |\nNothing * else.');
    expect(text).toContain('- #1 (https://github.com/acme/widgets/issues/1) Support Array<string>');
    expect(text).toContain('- #2 (https://github.com/acme/widgets/issues/2) **urgent** fix for snake_case_name');
  });

  it('`literal` escapes every markup character, so `*` and `_` arrive as written', () => {
    expect(literal('**urgent** snake_case `x` [a](https://b) \\')).toBe('\\*\\*urgent\\*\\* snake\\_case \\`x\\` \\[a](https://b) \\\\');
    expect(plainText(literal('**urgent**'))).toBe('**urgent**');
  });

  it('`_` is emphasis only at a word\'s edges, so `snake_case_name` stays as written unescaped', () => {
    expect(plainText('snake_case_name and _this_')).toBe('snake_case_name and this');
    expect(prose('snake_case_name and _this_')).toBe('snake\\_case\\_name and _this_');
  });

  it('`prose` keeps the subset and escapes markup that forms nothing', () => {
    expect(prose('**a** _b_ `c` [d](https://e.example/) **open *lone [y](http://z)'))
      .toBe('**a** _b_ `c` [d](https://e.example/) \\*\\*open \\*lone \\[y](http://z)');
  });

  // A seeded generator of hostile text: markup characters, brackets, URLs, line breaks, emoji.
  const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ATOMS = ['*', '**', '_', '`', '[', ']', '(', ')', '\\', 'https://e.example/p', 'a', 'snake_case', ' ', '\n', '#', '|', '<', '>', '&', 'é', '😀', '](https://e.example/)', '[x](https://e.example/)'];
  const hostile = (r: () => number, n: number) => Array.from({ length: n }, () => ATOMS[Math.floor(r() * ATOMS.length)]).join('');

  it('`literal` round-trips any text through `plainText`, and `prose` is idempotent and keeps what it reads', () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const s = hostile(r, 1 + Math.floor(r() * 30));
      expect(plainText(literal(s))).toBe(s);
      const p = prose(s);
      expect(prose(p)).toBe(p);
      expect(plainText(p)).toBe(plainText(s));
    }
  });
});

describe('`fit`', () => {
  const r0 = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lines = (r: () => number, max: number) => {
    const out = [];
    let n = 0;
    while (n < max) { const l = 'w'.repeat(1 + Math.floor(r() * 300)) + (r() < 0.1 ? '\u0001é😀' : ''); out.push(l); n += l.length + 1; }
    return out.join('\n');
  };
  /** A draft far past every limit, of a random shape. */
  const huge = (r: () => number) => ({
    kind: KINDS[Math.floor(r() * KINDS.length)],
    severity: 'info',
    title: `T${'t'.repeat(Math.floor(r() * 400))}\nsecond line`,
    summary: lines(r, Math.floor(r() * 5000)) || 's',
    sections: Array.from({ length: Math.floor(r() * 60) }, () => ({
      ...(r() < 0.5 ? { heading: `H\r\n${'h'.repeat(Math.floor(r() * 400))}` } : {}),
      body: lines(r, 1 + Math.floor(r() * 8000)),
      ...(r() < 0.5 ? { fields: Array.from({ length: Math.floor(r() * 25) }, () => ({ label: `L\n${'l'.repeat(Math.floor(r() * 300))}`, value: lines(r, 1 + Math.floor(r() * 4000)) })) } : {}),
    })),
    links: Array.from({ length: Math.floor(r() * 30) }, (_, i) => ({ label: `link ${i}\n${'k'.repeat(Math.floor(r() * 200))}`, url: `https://e.example/${'u'.repeat(Math.floor(r() * 2100))}` })),
    source: SOURCE,
  });

  it('on generated drafts far past every limit, always returns a valid message that says what it cut', () => {
    const r = r0(42);
    for (let i = 0; i < 300; i++) {
      const m = fit(huge(r));
      const v = validate(m);
      if (!v.ok) throw new Error(`draft ${i}: ${describeErrors(v.errors)}`);
      expect(renderText(m).length).toBeLessThanOrEqual(LIMITS.messageChars);
    }
  });

  it('says what it cut: `… truncated` and `… N more`', () => {
    const m = fit({
      ...base(),
      title: 't'.repeat(200),
      summary: 'line\n'.repeat(400),
      sections: Array.from({ length: 25 }, (_, i) => ({ body: `section ${i}` })),
      links: Array.from({ length: 12 }, (_, i) => ({ label: `l${i}`, url: 'https://e.example/' })),
    });
    expect(validate(m)).toEqual({ ok: true });
    expect(m.title).toHaveLength(LIMITS.title);
    expect(m.title.endsWith('…')).toBe(true);
    expect(m.summary.endsWith('\n… truncated')).toBe(true);
    expect(m.links).toHaveLength(LIMITS.links);
    // A section past the twentieth folds into a last one that names how many were left out.
    expect(m.sections).toHaveLength(LIMITS.sections);
    expect(m.sections[19]).toEqual({ body: '… 6 more sections and 3 more links, left out to fit' });
    expect(m.sections[18]).toEqual({ body: 'section 18' });
  });

  it('cuts at line boundaries, and folds a line break in a one-line field into a space', () => {
    const m = fit({ ...base(), title: 'one\ntwo', sections: [{ heading: 'a\r\nb', body: `${'x'.repeat(2000)}\n${'y'.repeat(2000)}` }] });
    expect(m.title).toBe('one two');
    expect(m.sections[0].heading).toBe('a b');
    expect(m.sections[0].body).toBe(`${'x'.repeat(2000)}\n… truncated`);
  });

  it('keeps a draft within the limits as it is, and sets the version', () => {
    for (const f of Object.values(FIXTURES)) {
      const draft = { ...f };
      delete draft.schema_version;
      expect(fit(draft)).toEqual(f);
    }
  });

  it('folds fields past the tenth into a last `… N more`', () => {
    const m = fit({ ...base(), sections: [{ body: 'b', fields: Array.from({ length: 14 }, (_, i) => ({ label: `l${i}`, value: 'v' })) }] });
    expect(m.sections[0].fields).toHaveLength(LIMITS.fields);
    expect(m.sections[0].fields[9]).toEqual({ label: '…', value: '5 more fields' });
  });

  it('repairs nothing its precondition excludes: a missing or empty required string, or a link not `https://`, reaches `validate`', () => {
    const cases: [Msg, string, string][] = [
      [(() => { const d = base(); delete d.title; return d; })(), 'title', 'range'],
      [{ ...base(), summary: '' }, 'summary', 'range'],
      [{ ...base(), sections: [{ body: '' }] }, 'sections[0].body', 'range'],
      [{ ...base(), sections: [{ body: 'b', fields: [{ label: '', value: 'v' }] }] }, 'sections[0].fields[0].label', 'range'],
      [{ ...base(), sections: [{ body: 'b', fields: [{ label: 'l' }] }] }, 'sections[0].fields[0].value', 'range'],
      [{ ...base(), links: [{ url: 'https://e.example/' }] }, 'links[0].label', 'range'],
      [{ ...base(), links: [{ label: 'l', url: 'http://e.example/' }] }, 'links[0].url', 'pattern'],
    ];
    for (const [draft, field, problem] of cases) {
      delete draft.schema_version;
      expect(errorsOf(fit(draft))).toEqual([{ field, problem }]);
    }
  });
});

describe('`renderText`', () => {
  it('is plain text: markup removed, escapes resolved, a link `label (url)`, the run last', () => {
    expect(renderText(FIXTURES['project-digest']!)).toBe([
      'Warning: Projects, Tuesday 14 October',
      '',
      'Three projects open. One is stopped on a decision you owe: #812 (https://github.com/acme/widgets/issues/812).',
      '',
      'Stopped',
      '- #812 (https://github.com/acme/widgets/issues/812) Merge retry: the Implementer posted a plan and stopped for a decision.',
      'Open issues: 4',
      'Waiting: 2 days',
      '',
      'The run (https://github.com/acme/widgets/actions/runs/1)',
    ].join('\n'));
    expect(renderText(FIXTURES['weekly-digest']!)).toContain('Four changes shipped, none waiting on you.');
    expect(renderText(FIXTURES['weekly-digest']!)).toContain('Checkout is faster.\n\nThe search page loads in half the time.');
  });

  it('is at most 12,000 characters, even for a message at every limit', () => {
    const m = base();
    m.sections = Array.from({ length: 20 }, () => ({ heading: 'h'.repeat(150), body: 'b\n'.repeat(250).trim(), fields: [{ label: 'l', value: 'v' }] }));
    const f = fit(m);
    expect(validate(f)).toEqual({ ok: true });
    const text = renderText(f);
    expect(text.length).toBeLessThanOrEqual(LIMITS.messageChars);
  });
});

describe('the published JSON Schema (decision 15)', () => {
  const file = join(ROOT, 'docs', 'notify', 'message-v1.schema.json');
  const schema = JSON.parse(readFileSync(file, 'utf8'));

  it('is generated from `SCHEMAS`, byte for byte', () => {
    // To regenerate: node -e "import('./scripts/lib/notify-contract.mjs').then(m=>process.stdout.write(m.jsonSchemaText(1)))" > docs/notify/message-v1.schema.json
    expect(readFileSync(file, 'utf8')).toBe(jsonSchemaText(1));
    expect(schema).toEqual(jsonSchema(1));
  });

  it('carries the two whole-message limits it cannot state as rules', () => {
    expect(schema['x-kanon-whole-message']).toEqual({ maxChars: LIMITS.messageChars, maxJsonBytes: LIMITS.messageBytes });
    expect(schema.description).toMatch(/whole-message limits/);
  });

  // Every fixture this file builds, valid and not, but the whole-message ones.
  const fixtures = (): unknown[] => [
    ...Object.values(FIXTURES),
    ...LIMIT_CASES.flatMap(({ at, limit }) => [at(limit), at(limit + 1)]),
    { ...base(), kind: 'health' },
    { ...base(), colour: 'red' },
    { ...base(), sections: [{ body: 'b', image: 'x' }] },
    { ...base(), links: [{ label: 'l', url: 'http://e.example/' }] },
    ...['\n', '\r', '\u2028', '\u2029'].flatMap((br) => [
      { ...base(), title: `a${br}b` },
      { ...base(), sections: [{ heading: `a${br}b`, body: 'b' }] },
      { ...base(), summary: `a${br}b`, sections: [{ body: `a${br}b`, fields: [{ label: 'l', value: `a${br}b` }] }] },
    ]),
    { ...base(), title: '' },
    { ...base(), schema_version: 2 },
    { ...base(), schema_version: '1' },
    { ...base(), severity: 'urgent' },
    { ...base(), sections: { body: 'b' } },
    { ...base(), source: { ...SOURCE, repository: 'acme' } },
    { ...base(), source: { ...SOURCE, lane: 'review' } },
    { ...base(), source: { ...SOURCE, run_url: 'https://e.example/a b' } },
    (() => { const m = base(); delete m.source; return m; })(),
    (() => { const m = base(); delete m.sections[0].body; return m; })(),
    null,
    [],
  ];

  it('accepts and refuses the same fixtures as `validate`', () => {
    const all = fixtures();
    expect(all.filter((m) => validate(m).ok).length).toBeGreaterThan(10);
    expect(all.filter((m) => !validate(m).ok).length).toBeGreaterThan(20);
    for (const m of all) expect([JSON.stringify(m)?.slice(0, 120), schemaAccepts(schema, m)]).toEqual([JSON.stringify(m)?.slice(0, 120), validate(m).ok]);
  });

  it('refuses in a URL exactly what it refused with `\\s`, naming each character rather than using a class escape', () => {
    // `\s` and the other class escapes mean different sets in different engines (#921).
    const pattern: string = schema.properties.source.properties.run_url.pattern;
    expect(pattern).not.toMatch(/\\[sSdDwWbB]/);
    const re = new RegExp(pattern, 'u');
    const at = (c: string) => ({ ...base(), source: { ...SOURCE, run_url: `https://e.example/a${c}b` } });
    const differ: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      const was = /\s/.test(c) || cp <= 0x1f || cp === 0x7f;
      if (re.test(`https://e.example/a${c}b`) === was) differ.push(cp);
    }
    expect(differ.map((cp) => cp.toString(16))).toEqual([]);
    for (const c of [' ', '　', '﻿', '\t']) expect(errorsOf(at(c))).toEqual([{ field: 'source.run_url', problem: 'pattern' }]);
    for (const c of ['\u0085', '​', '😀']) expect(errorsOf(at(c))).toEqual([]);
  });

  it('agrees on a `fit` output cut from far past the limits', () => {
    const m = fit({ ...base(), sections: Array.from({ length: 30 }, () => ({ body: 'x'.repeat(3000) })) });
    expect(schemaAccepts(schema, m)).toBe(true);
    expect(validate(m).ok).toBe(true);
  });
});

describe('the topic doc', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'notifications.md'), 'utf8');
  const plan = readFileSync(join(ROOT, 'docs', 'plans', '0011-notifications.md'), 'utf8');
  /** A section's text from its heading to the next of its level, with link targets dropped. */
  const words = (md: string, heading: RegExp, next: RegExp) => {
    const from = md.search(heading);
    const rest = md.slice(from).split('\n').slice(1).join('\n');
    const end = rest.search(next);
    return (end === -1 ? rest : rest.slice(0, end)).replace(/\]\([^)]*\)/g, ']').trim();
  };

  it("states §5.3's weakness word for word under its security section", () => {
    // Every paragraph of §5.3 but the one about this doc itself, link targets aside: the plan's
    // point at its own sections, the doc's at the plan's.
    const paragraphs = words(plan, /^### 5\.3 /m, /^#{2,3} /m).split('\n\n').filter((p) => !p.startsWith('The topic doc,'));
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs.join('').length).toBeGreaterThan(2000);
    const security = words(doc, /^## Security$/m, /^## /m);
    for (const p of paragraphs) expect(security).toContain(p);
  });

  it("states every field's limit in its table as the JSON Schema does", () => {
    // Each field's path as the table writes it, and the limit the schema publishes for it.
    const limits = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON Schema, walked property by property
    const walk = (s: Record<string, any>, path: string) => {
      if (s.type === 'string' && s.maxLength !== undefined) limits.set(path, `${s.minLength} to ${s.maxLength.toLocaleString('en-US')}`);
      if (s.type === 'array') { limits.set(path, `0 to ${s.maxItems}`); walk(s.items, `${path}[]`); }
      for (const [k, sub] of Object.entries(s.properties ?? {})) walk(sub as Msg, path ? `${path}.${k}` : k);
    };
    walk(jsonSchema(1), '');
    const rows = new Map(doc.split('\n').flatMap((l) => {
      const m = /^\| `([^`]+)` \| [^|]+ \| [^|]+ \| ([^|]+) \|/.exec(l);
      return m ? [[m[1]!, m[2]!.trim()] as const] : [];
    }));
    expect(limits.size).toBeGreaterThan(10);
    for (const [path, limit] of limits) expect([path, rows.get(path)]).toEqual([path, limit]);
  });

  it("states `fit`'s precondition, and that the library imports nothing", () => {
    const row = doc.split('\n').find((l) => l.startsWith('| `fit(draft)` |'))!;
    expect(row).toMatch(/non-empty/);
    expect(row).toMatch(/`https:\/\/`/);
    const lib = readFileSync(join(ROOT, 'scripts', 'lib', 'notify-contract.mjs'), 'utf8');
    expect(lib).not.toMatch(/^\s*import\b|\bimport\(|\brequire\(/m);
    const library = words(doc, /^## The library$/m, /^## /m);
    expect(library).toMatch(/^\S+ is the contract in code\. It imports nothing/);
    // The telemetry schema imports `./scrub.mjs`, so it is no example of a library that imports nothing.
    expect(library).not.toMatch(/as the telemetry schema/);
  });

  it('names each kind and its secret, and the published JSON Schema', () => {
    for (const [k, s] of Object.entries(KIND_SECRETS)) expect(doc).toMatch(new RegExp(`\`${k}\`[^\\n]*\`${s}\``));
    expect(doc).toContain('notify/message-v1.schema.json');
  });
});
