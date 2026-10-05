// The lane's prompt, with the instruction to open every post with the agent's persona header
// and role marker appended (plan 0005 §3.3, step L3). `agent-setup` resolved the role and
// exported its header line; with no role resolved, the prompt goes through unchanged.
//
// Written to `$GITHUB_OUTPUT` as `text`, under a delimiter the prompt can't contain.
//
// Inputs, by environment only: PROMPT, KANON_ROLE, KANON_POST_HEADER, GITHUB_OUTPUT.

import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { withPersona } from '../../scripts/lib/role-marker.mjs';

const text = withPersona(process.env.PROMPT ?? '', process.env.KANON_ROLE ?? '', process.env.KANON_POST_HEADER ?? '');
const eof = `KANON_PROMPT_${randomBytes(16).toString('hex')}`;
appendFileSync(String(process.env.GITHUB_OUTPUT), `text<<${eof}\n${text}\n${eof}\n`);
