import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One of the fixture adopter's documents, by its repository-relative path (the working directory). */
export const readRepoDoc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');
