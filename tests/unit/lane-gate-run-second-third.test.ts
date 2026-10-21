import { vi } from 'vitest';
import { describeGateRun, third } from './helpers/lane-gate-run.js';
import { SPAWNS } from './helpers/spawns.js';

// Each case runs a lane's gate step in `bash` against a stub `gh`, so every case takes the spawn
// budget (#436).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// kanon#46 half 2, the second third of the lanes' triggers: split out of lane-gate-run.test.ts so
// the thirds run in parallel (#1204). The four cases are in tests/unit/helpers/lane-gate-run.ts.
describeGateRun(third(2));
