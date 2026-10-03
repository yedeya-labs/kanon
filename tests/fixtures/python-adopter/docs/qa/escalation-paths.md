# Escalation paths

The Python fixture adopter's escalation file (`K-LAYOUT-8`), for the pipeline library's tests. The pipeline's own paths escalate whatever this file says (`K-MERGE-4`).

## Escalation paths

- `^migrations/` — database migrations
- `/^src/.*payments?/i` — payments

## Pipeline code

- `scripts/pipeline/` — the project's own pipeline scripts

## Bail list

- A change to how an order's total is computed.
