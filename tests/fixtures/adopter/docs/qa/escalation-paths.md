# Escalation paths

The fixture adopter's escalation file (`K-LAYOUT-8`), for the pipeline library's tests. The pipeline's own paths escalate whatever this file says (`K-MERGE-4`).

## Escalation paths

- `^migrations/` — database migrations
- `/^src/.*(auth|sessions?)([^a-z]|$)/i` — auth

An example of a prose line between entries, which the parser leaves alone.

## Pipeline code

- `scripts/pipeline/` — the project's own pipeline scripts

## Bail list

- A change to how a check-in is counted.
