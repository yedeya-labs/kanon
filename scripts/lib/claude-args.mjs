// A lane's `claude_args`, read the way the pinned claude-code-action reads them
// (`base-action/src/parse-sdk-options.ts`, `parseClaudeArgsToExtraArgs`, at v1.0.241).
//
// The action drops every line whose first non-blank character is `#`, splits the rest into
// shell words, and walks them: a word starting `--` is a flag, the next word is its value unless
// it starts `--` too, and a later value of the same flag overwrites an earlier one (the
// accumulating flags, `--allowedTools` and its kin, take every word up to the next flag). It then
// hands the SDK `settingSources: <value>.split(",")` when `--setting-sources` has a value, and
// `["user", "project", "local"]` when it has none. Only that space form is read: the `=` form is
// a flag of its own, which reaches the CLI beside the action's default.
//
// Kanon reads the same thing to decide what the agent's run loads (kanon#283), so this follows
// the action's parse rather than the CLI's.

/**
 * Shell words, with quotes and backslash escapes resolved, after full-line comments are dropped.
 * @param {string} args
 * @returns {string[]}
 */
export function claudeArgWords(args) {
  const text = String(args ?? '').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  /** @type {string[]} */
  const words = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < text.length && text.charAt(i) !== '"'; i++) {
        if (text.charAt(i) === '\\' && i + 1 < text.length && '"\\$`'.includes(text.charAt(i + 1))) i++;
        word += text.charAt(i);
      }
    } else if (c === '\\' && i + 1 < text.length) {
      word += text.charAt(++i);
      inWord = true;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * The setting sources the action hands the SDK for these flags.
 * @param {string} args
 * @returns {string[]}
 */
export function settingSources(args) {
  const words = claudeArgWords(args);
  /** @type {string | null | undefined} */
  let value;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (!word.startsWith('--')) continue;
    const flag = word.slice(2);
    const next = words[i + 1];
    // An accumulating flag takes the words after its first value too, but none of them starts
    // `--`, so skipping them one at a time below reaches the same next flag.
    if (next && !next.startsWith('--')) {
      if (flag === 'setting-sources') value = next;
      i++;
    } else if (flag === 'setting-sources') {
      value = null;
    }
  }
  return value ? value.split(',') : ['user', 'project', 'local'];
}

/**
 * Whether the run loads no project settings, so the lane's flags are meant to be its whole
 * grant, and the user scope must be one the job made (kanon#283).
 * @param {string} args
 */
export function loadsNoProjectSettings(args) {
  return !settingSources(args).includes('project');
}
