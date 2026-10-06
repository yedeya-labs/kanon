// A YAML reader for the files `kanon doctor` reads in an adopter's `.github/`: workflows,
// composite actions and the Dependabot file (plan 0005 §5.5, step L10).
//
// WHY ITS OWN. The CLI runs from a Kanon checkout or through `npx`, with Node's built-ins and
// nothing installed (cli/init.mjs), and `lane-check`'s `yq` is a runner tool most machines
// don't have. Doctor has to read what a job grants, calls and maps, so it needs the structure,
// not a regular expression over the text.
//
// WHAT IT READS. Block mappings and sequences (a sequence may sit at its key's own indentation,
// as workflows often write `steps:`), plain, single- and double-quoted scalars, plain and
// quoted scalars that run over several lines, literal and folded block scalars with their
// chomping and indentation indicators, flow sequences and mappings over one or more lines, and
// comments. Scalars resolve as YAML 1.2's core schema does: `null`, `~` and nothing are null,
// `true` and `false` booleans, decimal, octal and hexadecimal integers and floats numbers, and
// everything else a string. Anchors, aliases, tags, explicit `?` keys and multi-document
// streams throw a `YamlError` naming the line: doctor then says it could not read the file,
// rather than guessing. tests/unit/workflow-yaml.test.ts holds the reader to the `yaml`
// package's answer on every workflow, action and fixture in Kanon's tree.

export class YamlError extends Error {}

/** @typedef {{ n: number, indent: number, text: string }} Line */

const NULL = /^(?:~|null|Null|NULL)?$/;
const BOOL = /^(?:true|True|TRUE|false|False|FALSE)$/;
const INT = /^[-+]?[0-9]+$/;
const OCT = /^0o[0-7]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const INF = /^[-+]?\.(?:inf|Inf|INF)$/;
const NAN = /^\.(?:nan|NaN|NAN)$/;

/** A plain scalar's value under the core schema. @param {string} s */
const resolve = (s) => {
  if (NULL.test(s)) return null;
  if (BOOL.test(s)) return /^t/i.test(s);
  if (INT.test(s)) return Number(s);
  if (OCT.test(s)) return parseInt(s.slice(2), 8);
  if (HEX.test(s)) return parseInt(s.slice(2), 16);
  if (FLOAT.test(s)) return Number(s);
  if (INF.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (NAN.test(s)) return NaN;
  return s;
};

/** A plain scalar's text without its trailing comment. @param {string} s */
const stripComment = (s) => {
  const m = /(^|[ \t])#/.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
};

/**
 * Where the `:` that ends a key on this line is, or -1 when the line is no `key:` line. A
 * quoted key is skipped whole; a plain one ends at the first `:` followed by a space or the end.
 * @param {string} t the line's text, without its indentation
 */
const keyEnd = (t) => {
  if (/^[-?:,[\]{}#&*!|>%@`]/.test(t) && !/^-[^\s]/.test(t) && !/^:[^\s]/.test(t)) {
    if (t[0] !== '"' && t[0] !== "'") return -1;
  }
  let i = 0;
  if (t[0] === '"') {
    for (i = 1; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\') i++;
    i++;
  } else if (t[0] === "'") {
    for (i = 1; i < t.length; i++) {
      if (t[i] === "'") {
        if (t[i + 1] === "'") i++;
        else break;
      }
    }
    i++;
  }
  for (; i < t.length; i++) {
    if (t[i] === ':' && (i + 1 === t.length || t[i + 1] === ' ' || t[i + 1] === '\t')) return i;
    if (t[i] === '#' && (t[i - 1] === ' ' || t[i - 1] === '\t')) return -1;
  }
  return -1;
};

/** A double-quoted scalar's body, escapes resolved. @param {string} body @param {number} n */
const unescapeDouble = (body, n) =>
  body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => {
    const map = /** @type {Record<string, string>} */ ({ '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' });
    if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (e in map) return /** @type {string} */ (map[e]);
    throw new YamlError(`line ${n}: unknown escape \\${e} in a double-quoted scalar`);
  });

/**
 * Folds the lines of a quoted scalar that runs over several: each line break becomes a space,
 * and each empty line a line break.
 * @param {string[]} parts the raw lines, the first after its opening quote
 */
const foldQuoted = (parts) => {
  if (parts.length === 1) return /** @type {string} */ (parts[0]);
  let out = (parts[0] ?? '').replace(/[ \t]+$/, '');
  let pendingBreaks = 0;
  for (let i = 1; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const p = (parts[i] ?? '').replace(/^[ \t]+/, '');
    const t = last ? p : p.replace(/[ \t]+$/, '');
    if (t === '' && !last) {
      pendingBreaks++;
      continue;
    }
    out += pendingBreaks ? '\n'.repeat(pendingBreaks) : ' ';
    pendingBreaks = 0;
    out += t;
  }
  return out;
};

/**
 * A flow collection, `[...]` or `{...}`, from `s` at `i`. Returns the value and where it ended.
 * @param {string} s @param {number} i @param {number} n the line it starts on, for errors
 * @returns {{ v: unknown, i: number }}
 */
const parseFlow = (s, i, n) => {
  const ws = () => {
    while (i < s.length && /\s/.test(s[i] ?? '')) i++;
  };
  /** @returns {unknown} */
  const scalarOrCollection = (/** @type {boolean} */ inMap) => {
    ws();
    const c = s[i];
    if (c === '[' || c === '{') {
      const r = parseFlow(s, i, n);
      i = r.i;
      return r.v;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
      const body = foldQuoted(s.slice(i + 1, j).split('\n'));
      i = j + 1;
      return unescapeDouble(body, n);
    }
    if (c === "'") {
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") j++;
          else break;
        }
      }
      const body = foldQuoted(s.slice(i + 1, j).split('\n')).replace(/''/g, "'");
      i = j + 1;
      return body;
    }
    if (c === '&' || c === '*' || c === '!') throw new YamlError(`line ${n}: anchors, aliases and tags are not read`);
    let j = i;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === ',' || ch === ']' || ch === '}') break;
      if (inMap && ch === ':' && /[\s,\]}]/.test(s[j + 1] ?? ' ')) break;
      if (ch === '#' && /\s/.test(s[j - 1] ?? ' ')) throw new YamlError(`line ${n}: a comment inside a flow collection is not read`);
    }
    const raw = s.slice(i, j).replace(/\s+/g, ' ').trim();
    i = j;
    return resolve(raw);
  };
  const open = s[i];
  i++;
  if (open === '[') {
    /** @type {unknown[]} */
    const arr = [];
    for (;;) {
      ws();
      if (s[i] === ']') return { v: arr, i: i + 1 };
      arr.push(scalarOrCollection(false));
      ws();
      if (s[i] === ',') i++;
      else if (s[i] === ']') return { v: arr, i: i + 1 };
      else throw new YamlError(`line ${n}: a flow sequence is not closed`);
    }
  }
  /** @type {Record<string, unknown>} */
  const obj = {};
  for (;;) {
    ws();
    if (s[i] === '}') return { v: obj, i: i + 1 };
    const k = scalarOrCollection(true);
    ws();
    let v = null;
    if (s[i] === ':') {
      i++;
      ws();
      v = s[i] === ',' || s[i] === '}' ? null : scalarOrCollection(true);
    }
    obj[String(k)] = v;
    ws();
    if (s[i] === ',') i++;
    else if (s[i] === '}') return { v: obj, i: i + 1 };
    else throw new YamlError(`line ${n}: a flow mapping is not closed`);
  }
};

/**
 * Parses one YAML document of the shapes above. Throws `YamlError` naming the line of anything
 * it doesn't read.
 * @param {string} text
 * @returns {unknown}
 */
export const parseYaml = (text) => {
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {Line[]} */
  const lines = raw.map((l, i) => {
    const indent = /^ */.exec(l)?.[0].length ?? 0;
    return { n: i + 1, indent, text: l.slice(indent) };
  });
  let p = 0;
  // A document marker at the start is allowed; a second document is not read.
  const blank = (/** @type {Line | undefined} */ l) => !l || /^[ \t]*(#.*)?$/.test(l.text);
  while (p < lines.length && blank(lines[p])) p++;
  if (p < lines.length && /^---(\s|$)/.test(lines[p]?.text ?? '') && lines[p]?.indent === 0) {
    const rest = (lines[p]?.text ?? '').slice(3).trim();
    if (rest && !rest.startsWith('#')) throw new YamlError(`line ${lines[p]?.n}: content on the document marker is not read`);
    p++;
  }
  for (const l of lines.slice(p)) {
    if (l.indent === 0 && /^(---|\.\.\.)(\s|$)/.test(l.text)) throw new YamlError(`line ${l.n}: a second document, or a document end, is not read`);
    if (/^\t/.test(l.text) && !blank(l)) throw new YamlError(`line ${l.n}: indentation with a tab`);
  }

  const next = () => {
    while (p < lines.length && blank(lines[p])) p++;
    return lines[p];
  };

  /**
   * A block scalar after `|` or `>`, whose parent sits at `parent`.
   * @param {string} header the indicator and what follows it @param {number} parent @param {number} n
   */
  const blockScalar = (header, parent, n) => {
    const m = /^([|>])([1-9]?)([-+]?)([1-9]?)\s*(?:#.*)?$/.exec(header);
    if (!m) throw new YamlError(`line ${n}: a block scalar header "${header}" is not read`);
    const folded = m[1] === '>';
    const explicit = Number(m[2] || m[4] || 0);
    const chomp = m[3];
    const body = [];
    let indent = explicit ? parent + explicit : -1;
    while (p < lines.length) {
      const l = /** @type {Line} */ (lines[p]);
      const empty = l.text.trim() === '';
      if (!empty) {
        if (indent === -1) indent = l.indent;
        if (l.indent < indent || l.indent <= parent) break;
      }
      body.push(empty ? (indent !== -1 && l.indent > indent ? ' '.repeat(l.indent - indent) : '') : ' '.repeat(l.indent - indent) + l.text);
      p++;
    }
    while (body.length && body[body.length - 1] === '' && chomp !== '+') body.pop();
    let trailing = 0;
    if (chomp === '+') {
      while (body.length && body[body.length - 1] === '') {
        body.pop();
        trailing++;
      }
    }
    const more = (/** @type {string} */ t) => /^[ \t]/.test(t);
    let out = body[0] ?? '';
    for (let i = 1; i < body.length; i++) {
      const cur = /** @type {string} */ (body[i]);
      const prev = /** @type {string} */ (body[i - 1]);
      if (!folded) out += `\n${cur}`;
      else if (cur === '') out += '\n';
      else if (prev === '') {
        // The break before a run of empty lines is folded away between two normal lines, and
        // kept beside a more-indented one.
        let j = i - 1;
        while (j >= 0 && body[j] === '') j--;
        if (j < 0 || more(/** @type {string} */ (body[j])) || more(cur)) out += '\n';
        out += cur;
      } else if (more(prev) || more(cur)) out += `\n${cur}`;
      else out += ` ${cur}`;
    }
    if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return out;
    if (chomp === '+') return `${out}\n${'\n'.repeat(trailing)}`;
    return `${out}\n`;
  };

  /**
   * The value that starts as `rest` on line `l`, whose parent sits at `parent`.
   * @param {string} rest @param {Line} l @param {number} parent
   * @returns {unknown}
   */
  const inlineValue = (rest, l, parent) => {
    const c = rest[0];
    if (c === '|' || c === '>') {
      p++;
      return blockScalar(rest, parent, l.n);
    }
    if (c === '&' || c === '*' || c === '!' || c === '?' || c === '%' || c === '@' || c === '`') {
      throw new YamlError(`line ${l.n}: ${c === '&' || c === '*' ? 'anchors and aliases' : c === '!' ? 'tags' : `"${c}"`} ${c === '&' || c === '*' ? 'are' : 'is'} not read`);
    }
    if (c === '[' || c === '{') {
      let s = rest;
      let q = p;
      for (;;) {
        try {
          const r = parseFlow(s, 0, l.n);
          const after = s.slice(r.i).trim();
          if (after && !after.startsWith('#')) throw new YamlError(`line ${l.n}: text after a flow collection`);
          p = q + 1;
          return r.v;
        } catch (e) {
          if (!(e instanceof YamlError) || !/not closed/.test(e.message) || q + 1 >= lines.length) throw e;
          q++;
          const nl = /** @type {Line} */ (lines[q]);
          s += `\n${nl.text}`;
        }
      }
    }
    if (c === '"' || c === "'") {
      const parts = [rest.slice(1)];
      let q = p;
      const closes = (/** @type {string} */ s) => {
        if (c === '"') {
          for (let i = 0; i < s.length; i++) {
            if (s[i] === '\\') i++;
            else if (s[i] === '"') return i;
          }
          return -1;
        }
        for (let i = 0; i < s.length; i++) {
          if (s[i] === "'") {
            if (s[i + 1] === "'") i++;
            else return i;
          }
        }
        return -1;
      };
      let end = closes(/** @type {string} */ (parts[0]));
      while (end === -1) {
        q++;
        if (q >= lines.length) throw new YamlError(`line ${l.n}: a quoted scalar is not closed`);
        const nl = /** @type {Line} */ (lines[q]);
        parts.push(' '.repeat(nl.indent) + nl.text);
        end = closes(/** @type {string} */ (parts[parts.length - 1]));
      }
      const lastPart = /** @type {string} */ (parts[parts.length - 1]);
      const after = lastPart.slice(end + 1).trim();
      if (after && !after.startsWith('#')) throw new YamlError(`line ${lines[q]?.n}: text after a quoted scalar`);
      parts[parts.length - 1] = lastPart.slice(0, end);
      p = q + 1;
      const folded = foldQuoted(parts);
      return c === '"' ? unescapeDouble(folded, l.n) : folded.replace(/''/g, "'");
    }
    // A plain scalar, perhaps continued on more-indented lines.
    let s = stripComment(rest);
    const ended = s.length !== rest.trim().length;
    p++;
    if (!ended) {
      let breaks = 0;
      while (p < lines.length) {
        const nl = /** @type {Line} */ (lines[p]);
        if (nl.text.trim() === '') {
          breaks++;
          p++;
          continue;
        }
        if (nl.indent <= parent || /^#/.test(nl.text)) break;
        const t = stripComment(nl.text);
        s += breaks ? '\n'.repeat(breaks) + t : ` ${t}`;
        breaks = 0;
        p++;
        if (t.length !== nl.text.trim().length) break;
      }
      // Blank lines after the scalar belong to no one.
    }
    return resolve(s);
  };

  /** @param {number} indent @returns {unknown[]} */
  const parseSeq = (indent) => {
    /** @type {unknown[]} */
    const arr = [];
    for (;;) {
      const l = next();
      if (!l || l.indent !== indent || !/^-(\s|$)/.test(l.text)) return arr;
      const after = l.text.slice(1);
      const content = after.trimStart();
      if (content === '' || content.startsWith('#')) {
        p++;
        const nl = next();
        arr.push(nl && nl.indent > indent ? parseNode(indent + 1) : null);
        continue;
      }
      // The item sits on the dash's line: read it as if it began on its own line, at its column.
      const col = indent + 1 + (after.length - content.length);
      lines[p] = { n: l.n, indent: col, text: content };
      arr.push(parseNode(col, indent));
    }
  };

  /** @param {number} indent @returns {Record<string, unknown>} */
  const parseMap = (indent) => {
    /** @type {Record<string, unknown>} */
    const obj = {};
    for (;;) {
      const l = next();
      if (!l || l.indent !== indent) return obj;
      if (/^-(\s|$)/.test(l.text)) throw new YamlError(`line ${l.n}: a sequence item where a key was expected`);
      const k = keyEnd(l.text);
      if (k === -1) throw new YamlError(`line ${l.n}: expected a key`);
      const rawKey = l.text.slice(0, k).trim();
      let key;
      if (rawKey.startsWith('"')) key = unescapeDouble(rawKey.slice(1, -1), l.n);
      else if (rawKey.startsWith("'")) key = rawKey.slice(1, -1).replace(/''/g, "'");
      else if (/^[&*!?]/.test(rawKey)) throw new YamlError(`line ${l.n}: anchors, aliases, tags and explicit keys are not read`);
      else key = String(resolve(rawKey));
      const rest = l.text.slice(k + 1).trim();
      if (rest === '' || rest.startsWith('#')) {
        p++;
        const nl = next();
        if (nl && nl.indent > indent) obj[key] = parseNode(nl.indent, indent);
        else if (nl && nl.indent === indent && /^-(\s|$)/.test(nl.text)) obj[key] = parseSeq(indent);
        else obj[key] = null;
      } else obj[key] = inlineValue(rest, l, indent);
    }
  };

  /**
   * The node whose first line is the next significant one, at `indent`, under a parent at
   * `parent`.
   * @param {number} indent @param {number} [parent]
   * @returns {unknown}
   */
  const parseNode = (indent, parent = indent - 1) => {
    const l = next();
    if (!l) return null;
    if (/^-(\s|$)/.test(l.text)) return parseSeq(l.indent);
    if (keyEnd(l.text) !== -1) return parseMap(l.indent);
    return inlineValue(l.text, l, parent);
  };

  const first = next();
  if (!first) return null;
  const doc = parseNode(first.indent, -1);
  const left = next();
  if (left) throw new YamlError(`line ${left.n}: unexpected indentation or content`);
  return doc;
};
