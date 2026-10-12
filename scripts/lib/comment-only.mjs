// Is a change to a source file comments or whitespace, and nothing else? The red-test check
// (`K-MERGE-13`) asks, because a pull request whose only source changes are comments has no
// behaviour change to revert: its test locks behaviour that was already right, and cannot fail
// on a revert by construction (the Owner's decision of 2026-10-12, #666).
//
// ONE DIRECTION ONLY MAY ERR. "Yes" skips the check, so it is said only when it is proven; "no"
// keeps the file on the path the check already had for it. So each reader below is strict: on
// anything it can't read for certain (an unterminated string, a slash that may start a regex or
// divide, JSX, a Python f-string whose quotes nest, a shell script) it answers null, "can't
// prove", never a guess. A comment that a tool or the runtime reads (a shebang, `//go:build`,
// an `@jsx` pragma, a PEP 263 coding line, a bundler's magic comment) is code here.
//
// HOW IT COMPARES. Each file is read into a skeleton: its comments removed, its string literals
// kept byte for byte, and the whitespace between tokens normalised the way the language ignores
// it: a run of spaces is one space, a line's indentation and trailing space go, and an empty line
// goes. A line break stays, since a JavaScript `return` or a Go statement ends at one, and so
// does a gap between two tokens, since `a+ +b` is not `a++b`. Python's indentation is its block
// structure, so there it stays exactly. Two versions are comment-only apart when their skeletons
// are equal.
//
// Not the test-convention table's scanners (`test-conventions.mjs`): those find titles, and on
// text they can't read they carry on, which is right for a title and wrong here.

/** @typedef {{ t: 'code' | 'str' | 'ws' | 'nl', v: string }} Seg */

/** The block tags of JSDoc and TSDoc: documentation, which no runtime or bundler reads. Any other
 *  `@name` in a JavaScript comment may be a pragma (`@jsx`, `@vite-ignore`, `@vitest-environment`,
 *  `@ts-expect-error`), so it makes the comment code. */
const DOC_TAGS = new Set([
  'abstract', 'access', 'alias', 'alpha', 'arg', 'argument', 'async', 'augments', 'author', 'beta', 'borrows',
  'callback', 'category', 'class', 'classdesc', 'const', 'constant', 'constructor', 'constructs', 'copyright',
  'default', 'defaultvalue', 'deprecated', 'desc', 'description', 'emits', 'enum', 'event', 'example',
  'exception', 'experimental', 'exports', 'extends', 'external', 'file', 'fileoverview', 'fires', 'func',
  'function', 'generator', 'global', 'hideconstructor', 'ignore', 'implements', 'import', 'inheritdoc', 'inner',
  'instance', 'interface', 'internal', 'kind', 'label', 'lends', 'link', 'linkcode', 'linkplain', 'listens',
  'member', 'memberof', 'method', 'mixes', 'mixin', 'module', 'name', 'namespace', 'overload', 'override',
  'overview', 'package', 'param', 'private', 'privateremarks', 'prop', 'property', 'protected', 'public',
  'readonly', 'remarks', 'requires', 'return', 'returns', 'satisfies', 'sealed', 'see', 'since', 'static',
  'summary', 'template', 'this', 'throws', 'todo', 'tutorial', 'type', 'typedef', 'typeparam', 'var',
  'variation', 'version', 'virtual', 'yield', 'yields',
]);

/** A JavaScript comment that a tool or the runtime reads, so it is code. `body` is the text
 *  between the delimiters. @param {string} body @param {'line' | 'block'} kind */
function jsDirective(body, kind) {
  // `///` (TypeScript's triple-slash directives), `//#` and `//@` (a source map's URL).
  if (kind === 'line' && /^[/#@]/.test(body)) return true;
  // `/*!` (kept by minifiers), `#__PURE__`, and a tag-like `<…>`.
  if (/^[!#<]/.test(body.replace(/^[\s*]*/, ''))) return true;
  for (const m of body.matchAll(/@([\w-]*)/g)) if (!DOC_TAGS.has((m[1] ?? '').toLowerCase())) return true;
  return /\bwebpack[A-Z]\w*|\bvite-ignore\b|\bsourceMappingURL\b|\bsourceURL\b|__PURE__|__NO_SIDE_EFFECTS__/.test(body);
}

/** Keywords after which a `/` starts a regex, not a division. */
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** Unicode spaces JavaScript reads as whitespace: read as neither, they could hide where a token
 *  ends, so a file with one outside a string is not read. */
const JS_ODD_SPACE = /[\u00A0\uFEFF\u1680\u2000-\u200A\u202F\u205F\u3000]/;

/**
 * May a `/` (or, in a file that may hold JSX, a `<`) start an expression after the token `prev`
 * (and `before` it)? `null` when the language leaves it ambiguous without parsing: after `}` (a
 * block, or an object literal), `++`/`--`, a `.`, or a TypeScript non-null `x!`.
 * @param {string} prev @param {string} before
 * @returns {boolean | null}
 */
function expressionStarts(prev, before) {
  if (prev === '') return true;
  if (/^[A-Za-z_$\\\u0080-\uFFFF]/.test(prev)) return BEFORE_EXPRESSION.has(prev);
  if (prev === 'num' || prev === 'str' || prev === ')' || prev === ']') return false;
  if (prev === '}' || prev === '++' || prev === '--' || prev === '.') return null;
  if (prev === '!' && (/^[A-Za-z_$\\\u0080-\uFFFF]/.test(before) ? !BEFORE_EXPRESSION.has(before) : ['num', 'str', ')', ']'].includes(before))) return null;
  return true;
}

/** The end of the quoted string at `i`, or null when it is unterminated. @param {string} text @param {number} i */
function jsString(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j += text[j + 1] === '\r' && text[j + 2] === '\n' ? 2 : 1; continue; }
    if (c === q) return j + 1;
    if (c === '\n' || c === '\r') return null;
  }
  return null;
}

/** The end of the template literal at `i`, its `${…}` read as code, or null. @param {string} text @param {number} i @param {boolean} jsx */
function jsTemplate(text, i, jsx) {
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && text[j + 1] === '{') {
      const end = jsCode(text, j + 2, [], true, jsx);
      if (end === null) return null;
      j = end - 1;
    }
  }
  return null;
}

/** The end of the regex literal at `i`, its flags included, or null. @param {string} text @param {number} i */
function jsRegex(text, i) {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\n' || c === '\r') return null;
    if (c === '\\') { if (text[j + 1] === undefined || text[j + 1] === '\n' || text[j + 1] === '\r') return null; j++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true;
    else if (c === '/') {
      let k = j + 1;
      while (k < text.length && /[A-Za-z]/.test(text[k] ?? '')) k++;
      return k;
    }
  }
  return null;
}

/**
 * JavaScript or TypeScript code from `start`, into `segs`. Returns where it stopped: past the `}`
 * that closes a template's `${` when `inTemplate`, else the end of the text; null when it can't
 * read the text for certain.
 * @param {string} text @param {number} start @param {Seg[]} segs @param {boolean} inTemplate @param {boolean} jsx
 * @returns {number | null}
 */
function jsCode(text, start, segs, inTemplate, jsx) {
  let prev = '', before = '', depth = 0;
  const tok = (/** @type {string} */ t) => { before = prev; prev = t; };
  let i = start;
  while (i < text.length) {
    const c = text[i] ?? '';
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let end = i + 2;
      while (end < text.length && !/[\n\r\u2028\u2029]/.test(text[end] ?? '')) end++;
      if (jsDirective(text.slice(i + 2, end), 'line')) segs.push({ t: 'code', v: text.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return null;
      const body = text.slice(i + 2, close);
      if (jsDirective(body, 'block')) segs.push({ t: 'code', v: text.slice(i, close + 2) });
      else segs.push({ t: /[\n\r\u2028\u2029]/.test(body) ? 'nl' : 'ws', v: ' ' });
      i = close + 2;
      continue;
    }
    if (c === '/' || (c === '<' && jsx)) {
      const starts = expressionStarts(prev, before);
      if (starts === null) return null;
      // JSX: its text may hold a `//` or a quote that is no comment or string.
      if (c === '<' && starts) return null;
      if (c === '/' && starts) {
        const end = jsRegex(text, i);
        if (end === null) return null;
        segs.push({ t: 'str', v: text.slice(i, end) });
        tok('str');
        i = end;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = c === '`' ? jsTemplate(text, i, jsx) : jsString(text, i);
      if (end === null) return null;
      segs.push({ t: 'str', v: text.slice(i, end) });
      tok('str');
      i = end;
      continue;
    }
    if (c === '\n' || (c === '\r' && next !== '\n')) { segs.push({ t: 'nl', v: '\n' }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') { segs.push({ t: 'ws', v: c }); i++; continue; }
    if (c === '\u2028' || c === '\u2029') { segs.push({ t: 'nl', v: '\n' }); i++; continue; }
    if (JS_ODD_SPACE.test(c)) return null;
    if (/[A-Za-z_$\\\u0080-\uFFFF]/.test(c)) {
      let end = i + 1;
      while (end < text.length && /[\w$\\\u0080-\uFFFF]/.test(text[end] ?? '') && !/[\u2028\u2029]/.test(text[end] ?? '') && !JS_ODD_SPACE.test(text[end] ?? '')) end++;
      segs.push({ t: 'code', v: text.slice(i, end) });
      // A keyword after `.` is a property name: `a.in / 2` divides.
      tok(prev === '.' ? 'prop' : text.slice(i, end));
      i = end;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let end = i + 1;
      while (end < text.length && /[\w.]/.test(text[end] ?? '')) end++;
      segs.push({ t: 'code', v: text.slice(i, end) });
      tok('num');
      i = end;
      continue;
    }
    if ((c === '+' || c === '-') && next === c) { segs.push({ t: 'code', v: c + c }); tok(c + c); i += 2; continue; }
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0) return inTemplate ? i + 1 : null;
      depth--;
    }
    segs.push({ t: 'code', v: c });
    tok(c);
    i++;
  }
  return inTemplate ? null : i;
}

/** @param {string} text @param {boolean} jsx @returns {Seg[] | null} */
function scanJs(text, jsx) {
  /** @type {Seg[]} */
  const segs = [];
  let i = 0;
  if (text.startsWith('#!')) {
    const nl = text.search(/[\n\r]/);
    i = nl < 0 ? text.length : nl;
    segs.push({ t: 'code', v: text.slice(0, i) });
  }
  return jsCode(text, i, segs, false, jsx) === null ? null : segs;
}

/** Python's string prefixes; `f` and `t` hold replacement fields. */
const PY_PREFIX = /^(?:[rRuUbBfFtT]|[bB][rR]|[rR][bB]|[fF][rR]|[rR][fF]|[tT][rR]|[rR][tT])$/;

/**
 * The end of the Python string whose quote is at `i`, or null. In an f-string (or a t-string) the
 * replacement fields' braces are counted, and a closing quote, or a `#`, inside one is not read:
 * Python 3.12 lets a field nest the string's own quote, and older Pythons end the string there.
 * @param {string} text @param {number} i @param {boolean} fields
 */
function pyString(text, i, fields) {
  const c = text[i] ?? '';
  const q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
  let depth = 0;
  for (let j = i + q.length; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') {
      if (fields && (text[j + 1] === '{' || text[j + 1] === '}')) continue;
      j += text[j + 1] === '\r' && text[j + 2] === '\n' ? 2 : 1;
      continue;
    }
    if (text.startsWith(q, j)) return depth > 0 ? null : j + q.length;
    if (q.length === 1 && (ch === '\n' || ch === '\r')) return null;
    if (!fields) continue;
    if (ch === '{') {
      if (depth === 0 && text[j + 1] === '{') { j++; continue; }
      depth++;
    } else if (ch === '}') {
      if (depth === 0 && text[j + 1] === '}') { j++; continue; }
      if (depth === 0) return null;
      depth--;
    } else if (ch === '#' && depth > 0) return null;
  }
  return null;
}

/** @param {string} text @returns {Seg[] | null} */
function scanPython(text) {
  /** @type {Seg[]} */
  const segs = [];
  const firstNl = text.indexOf('\n');
  const secondNl = firstNl < 0 ? -1 : text.indexOf('\n', firstNl + 1);
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === '#') {
      let end = i + 1;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
      const body = text.slice(i + 1, end);
      const line1 = firstNl < 0 || i < firstNl;
      const line2 = line1 || secondNl < 0 || i < secondNl;
      // A shebang, and PEP 263's coding declaration, which decides how the file is decoded.
      if ((line1 && body.startsWith('!')) || (line2 && /coding[:=]/.test(body))) segs.push({ t: 'code', v: text.slice(i, end) });
      i = end;
      continue;
    }
    if (/[A-Za-z_\u0080-\uFFFF]/.test(c)) {
      let end = i + 1;
      while (end < text.length && /[\w\u0080-\uFFFF]/.test(text[end] ?? '')) end++;
      const word = text.slice(i, end);
      if ((text[end] === '"' || text[end] === "'") && PY_PREFIX.test(word)) {
        const close = pyString(text, end, /[fFtT]/.test(word));
        if (close === null) return null;
        segs.push({ t: 'str', v: text.slice(i, close) });
        i = close;
        continue;
      }
      segs.push({ t: 'code', v: word });
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const close = pyString(text, i, false);
      if (close === null) return null;
      segs.push({ t: 'str', v: text.slice(i, close) });
      i = close;
      continue;
    }
    if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) { segs.push({ t: 'nl', v: '\n' }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { segs.push({ t: 'ws', v: c }); i++; continue; }
    segs.push({ t: 'code', v: c });
    i++;
  }
  return segs;
}

/** A Go comment the toolchain reads: `//go:build`, `//go:embed`, `//line`, cgo's `//export`, the
 *  old `// +build`. `body` is the text after `//`. @param {string} body */
const goDirective = (body) => /^(?:[a-z0-9_.-]+:\S|line\s|export\s|extern\s)/.test(body) || /^\s*\+build\b/.test(body);

/** @param {string} text @returns {Seg[] | null} */
function scanGo(text) {
  // cgo: the comment before `import "C"` is C code, compiled with the package.
  if (text.includes('"C"')) return null;
  /** @type {Seg[]} */
  const segs = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      if (goDirective(text.slice(i + 2, end))) segs.push({ t: 'code', v: text.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return null;
      const body = text.slice(i + 2, close);
      if (body.startsWith('line ')) segs.push({ t: 'code', v: text.slice(i, close + 2) });
      else segs.push({ t: body.includes('\n') ? 'nl' : 'ws', v: ' ' });
      i = close + 2;
      continue;
    }
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close < 0) return null;
      segs.push({ t: 'str', v: text.slice(i, close + 1) });
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const close = jsString(text, i);
      if (close === null) return null;
      segs.push({ t: 'str', v: text.slice(i, close) });
      i = close;
      continue;
    }
    if (c === '\n') { segs.push({ t: 'nl', v: '\n' }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { segs.push({ t: 'ws', v: c }); i++; continue; }
    segs.push({ t: 'code', v: c });
    i++;
  }
  return segs;
}

/**
 * The skeleton's text: one line per line that holds anything, a gap as one space, the
 * indentation dropped unless it is significant. Whitespace a backslash escapes is kept as it is.
 * @param {Seg[]} segs @param {boolean} indentation
 */
function render(segs, indentation) {
  /** @type {Seg[][]} */
  const lines = [[]];
  for (const s of segs) {
    if (s.t === 'nl') lines.push([]);
    else lines.at(-1)?.push(s);
  }
  const out = [];
  for (const line of lines) {
    /** @type {Seg[]} */
    const merged = [];
    for (const s of line) {
      const last = merged.at(-1);
      if (s.t === 'ws' && last?.t === 'ws') merged[merged.length - 1] = { t: 'ws', v: last.v + s.v };
      else if (s.t === 'ws' && last?.t === 'code' && last.v.endsWith('\\')) merged.push({ t: 'code', v: s.v });
      else merged.push(s);
    }
    while (merged.at(-1)?.t === 'ws') merged.pop();
    if (!merged.length) continue;
    out.push(merged.map((s, k) => (s.t !== 'ws' ? s.v : k > 0 ? ' ' : indentation ? s.v : '')).join(''));
  }
  return out.join('\n');
}

/**
 * A source file's skeleton: its code and strings, without its comments or the whitespace its
 * language ignores. Null when this can't read the file for certain, or reads no file of its kind.
 * @param {string} path the file's path, for its language
 * @param {string} text
 * @returns {string | null}
 */
export function skeleton(path, text) {
  const ext = /\.([^./]+)$/.exec(path)?.[1] ?? '';
  if (['ts', 'mts', 'cts'].includes(ext)) {
    const segs = scanJs(text, false);
    return segs && render(segs, false);
  }
  if (['js', 'mjs', 'cjs', 'jsx', 'tsx'].includes(ext)) {
    const segs = scanJs(text, true);
    return segs && render(segs, false);
  }
  if (ext === 'py') {
    const segs = scanPython(text);
    return segs && render(segs, true);
  }
  if (ext === 'go') {
    const segs = scanGo(text);
    return segs && render(segs, false);
  }
  // A shell script, and every other language: no reader here is sound for it.
  return null;
}

/**
 * Do two versions of a source file differ in comments or whitespace only, provably?
 * @param {string} path @param {string} before @param {string} after
 */
export function commentOnly(path, before, after) {
  const a = skeleton(path, before);
  return a !== null && a === skeleton(path, after);
}
