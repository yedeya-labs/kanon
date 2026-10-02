import { fileURLToPath } from 'node:url';

/** Kanon's root, for the files a library test reads from Kanon's own tree. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The fixture adopter these tests run inside (`tests/fixtures/adopter`): the files an
 * adopter keeps at chapter 11's paths that the library reads from its working directory,
 * with example values. Each library test's process starts here (`in-adopter.ts`).
 */
export const ADOPTER = fileURLToPath(new URL('../../fixtures/adopter/', import.meta.url));
