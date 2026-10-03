# Escalation paths

The Python fixture adopter's escalation file (`K-LAYOUT-8`), for the pipeline library's tests. The pipeline's own paths (`.github/` and the documents directly inside `docs/qa/`) escalate whatever this file says.

## Escalation paths

- `^migrations/` — database migrations
- `/^src/.*payments?/i` — payments

## Pipeline code

- `scripts/pipeline/` — the project's own pipeline scripts

## Bail list

- A change to how an order's total is computed.
