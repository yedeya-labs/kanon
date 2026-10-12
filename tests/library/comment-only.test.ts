import { describe, expect, it } from 'vitest';
import { commentOnly, skeleton } from '../../scripts/lib/comment-only.mjs';

/**
 * Is a change to a source file provably comments or whitespace? The red-test check (`K-MERGE-13`)
 * concludes "no behaviour change to revert" only when it is, so every doubt here must land on
 * "no": a false "yes" lets a behaviour change skip the check, a false "no" only keeps it on the
 * path it was already on (the Owner's decision of 2026-10-12 on #666).
 */

const same = (path: string, before: string, after: string) => commentOnly(path, before, after);

describe('a change to comments or whitespace alone is provably no behaviour change', () => {
  it('JavaScript and TypeScript: line comments, block comments and doc blocks', () => {
    expect(same('src/a.ts', 'const a = 1; // old\n', 'const a = 1; // new, and longer\n')).toBe(true);
    expect(same('src/a.ts', '/* one */\nexport const a = 1;\n', '/*\n * two\n */\nexport const a = 1;\n')).toBe(true);
    expect(same('src/a.mjs', '/**\n * Adds.\n * @param {number} a\n * @returns {number}\n */\nexport const f = (a) => a;\n',
      '/**\n * Adds one thing.\n * @param {number} a the thing\n * @returns {number} itself\n */\nexport const f = (a) => a;\n')).toBe(true);
    expect(same('src/a.js', 'const a = 1;\n', '// A new comment line.\nconst a = 1;\n')).toBe(true);
  });

  it('whitespace: indentation, trailing space, blank lines and the width of a gap', () => {
    expect(same('src/a.ts', 'if (x) {\n  run();\n}\n', 'if (x) {\n\n    run();   \n}\n\n')).toBe(true);
    expect(same('src/a.ts', 'const a = 1;\n', 'const a  =\t1;\n')).toBe(true);
    expect(same('main.go', 'package main\n\nfunc f() {\n\treturn\n}\n', 'package main\n\n// f returns.\nfunc f() {\n        return // early\n}\n')).toBe(true);
  });

  it('Python: comments and blank lines, with the indentation kept exactly', () => {
    expect(same('app/a.py', 'def f():\n    return 1  # one\n', 'def f():\n    # the one\n\n    return 1\n')).toBe(true);
  });

  it('a URL in a string is a string, not a comment, and a comment after it is still read as one', () => {
    expect(same('src/a.ts', 'const u = "http://x"; // a\n', 'const u = "http://x"; // b\n')).toBe(true);
  });

  it('a quote in a regex literal opens no string, so the comment after it is still read as one', () => {
    expect(same('src/a.ts', "const r = /'/; // a\n", "const r = /'/; // b\n")).toBe(true);
  });
});

describe('anything it cannot prove is comments or whitespace is a behaviour change', () => {
  it('a change to code, or to a string', () => {
    expect(same('src/a.ts', 'const a = 1;\n', 'const a = 2;\n')).toBe(false);
    expect(same('src/a.ts', "const a = 'x';\n", "const a = 'x ';\n")).toBe(false);
  });

  it('whitespace INSIDE a string, a template or a raw string is content', () => {
    expect(same('src/a.ts', 'const a = `a\n  b`;\n', 'const a = `a\n    b`;\n')).toBe(false);
    expect(same('main.go', 'package main\n\nvar a = `x\n y`\n', 'package main\n\nvar a = `x\n  y`\n')).toBe(false);
    expect(same('app/a.py', 'A = """x\n  y"""\n', 'A = """x\n    y"""\n')).toBe(false);
  });

  it('a gap appearing or disappearing between two tokens, or a line break moving', () => {
    expect(same('src/a.ts', 'const a = b+c;\n', 'const a = b + c;\n')).toBe(false);
    // Automatic semicolon insertion: `return\nx` returns undefined.
    expect(same('src/a.ts', 'function f() { return x; }\n', 'function f() { return\nx; }\n')).toBe(false);
  });

  it('Python indentation is code', () => {
    expect(same('app/a.py', 'if x:\n    a()\n    b()\n', 'if x:\n    a()\nb()\n')).toBe(false);
  });

  it('code hidden behind a "//" inside a string or a regex is still read as code', () => {
    expect(same('src/a.ts', 'const u = "a//b"; run(1);\n', 'const u = "a//b"; run(2);\n')).toBe(false);
    expect(same('src/a.ts', 'const r = /a\\/\\/b/; run(1);\n', 'const r = /a\\/\\/b/; run(2);\n')).toBe(false);
    expect(same('src/a.ts', 'const r = /[/*]/; run(1);\n', 'const r = /[/*]/; run(2);\n')).toBe(false);
    expect(same('src/a.ts', 'const r = /[//]/; run(1);\n', 'const r = /[//]/; run(2);\n')).toBe(false);
    expect(same('src/a.ts', 'const t = `${a /* x */}`; run(1);\n', 'const t = `${a /* x */}`; run(2);\n')).toBe(false);
    expect(same('app/a.py', 'u = "a#b"; run(1)\n', 'u = "a#b"; run(2)\n')).toBe(false);
  });

  it('a comment that is a directive to a tool or the runtime is code', () => {
    expect(same('src/a.ts', '/** @jsx h */\nexport const a = 1;\n', '/** @jsx React.createElement */\nexport const a = 1;\n')).toBe(false);
    expect(same('src/a.ts', '/// <reference path="a.d.ts" />\nexport {};\n', '/// <reference path="b.d.ts" />\nexport {};\n')).toBe(false);
    expect(same('src/a.ts', 'import(/* webpackChunkName: "a" */ "./a");\n', 'import(/* webpackChunkName: "b" */ "./a");\n')).toBe(false);
    expect(same('src/a.ts', 'const a = /* @__PURE__ */ f();\n', 'const a = f();\n')).toBe(false);
    expect(same('src/a.ts', '// @ts-expect-error\nconst a: number = "x";\n', 'const a: number = "x";\n')).toBe(false);
    expect(same('src/a.mjs', '#!/usr/bin/env node\nrun();\n', '#!/usr/bin/env bun\nrun();\n')).toBe(false);
    // A shebang is no JavaScript: read as code, `//` in it would start a comment.
    expect(same('src/a.mjs', '#!//usr/bin/env node\nrun();\n', '#!//usr/bin/env bun\nrun();\n')).toBe(false);
    expect(same('main.go', '//go:build linux\n\npackage main\n', '//go:build darwin\n\npackage main\n')).toBe(false);
    expect(same('main.go', 'package main\n\n// #include <a.h>\nimport "C"\n', 'package main\n\n// #include <b.h>\nimport "C"\n')).toBe(false);
    expect(same('app/a.py', '# -*- coding: latin-1 -*-\nA = 1\n', '# -*- coding: utf-8 -*-\nA = 1\n')).toBe(false);
    expect(same('app/a.py', '#!/usr/bin/env python3\nA = 1\n', '#!/usr/bin/env python2\nA = 1\n')).toBe(false);
  });

  it('JSX, whose text may hold a "//" that is not a comment, is not read at all', () => {
    expect(skeleton('src/a.tsx', 'export const A = () => <p>http://x {run(1)}</p>;\n')).toBeNull();
    expect(skeleton('src/a.js', 'export const A = () => <p>http://x {run(1)}</p>;\n')).toBeNull();
    // A TypeScript file cannot hold JSX, so a type assertion there is code, not a bail.
    expect(skeleton('src/a.ts', 'const a = <number>b;\n')).not.toBeNull();
  });

  it('a Python f-string whose quotes nest (3.12) is not read, since older Pythons end it early', () => {
    expect(skeleton('app/a.py', 'x = f"{d["#"]}"; run(1)\n')).toBeNull();
    expect(skeleton('app/a.py', 'x = f"{d[\'k\']} and {{braces}}"\n')).not.toBeNull();
  });

  it('a lexically ambiguous slash is not guessed at', () => {
    // After `}` a `/` may start a regex (a block ended) or divide (an object literal ended).
    expect(skeleton('src/a.ts', 'if (a) {}\n/x/.test(s);\n')).toBeNull();
  });

  it('an unterminated string or comment is not read', () => {
    expect(skeleton('src/a.ts', 'const a = "x;\nrun();\n')).toBeNull();
    expect(skeleton('src/a.ts', '/* open\nrun();\n')).toBeNull();
    expect(skeleton('main.go', 'package main\nvar a = `x\n')).toBeNull();
  });

  it('a shell script, or a language the reader has no lexer for, is never provable', () => {
    expect(skeleton('scripts/a.sh', '# a\necho hi\n')).toBeNull();
    expect(same('scripts/a.sh', '# a\necho hi\n', '# b\necho hi\n')).toBe(false);
    expect(same('src/a.rb', '# a\n', '# b\n')).toBe(false);
  });
});
