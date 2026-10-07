// The PR-text check's entry point (#239): .github/workflows/public-text.yml runs this file to hash
// every word of a pull request's title and body against the reference adopter's names. The list
// and the check live in `actions/agent-telemetry/public-words.mjs`, which the telemetry scrub
// also reads (plan 0006 §4.2); this file re-exports them, so every earlier reader of this path
// keeps working. The workflow sparse-checks out both directories.
//
// It never prints the word it found, only where it found it: a public run's log would publish
// it just as the file would.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { check } from '../../actions/agent-telemetry/public-words.mjs';

export * from '../../actions/agent-telemetry/public-words.mjs';

// Inline rather than `scripts/lib/cli-entry.mjs`'s `isCliEntry`: `public-text.yml` sparse-checks
// out only `.github/scripts` and `actions/agent-telemetry`, so that import would not exist at run
// time (kanon#191).
const IS_CLI = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (IS_CLI) {
  const { code, message } = check(process.env);
  console.log(message);
  process.exit(code);
}
