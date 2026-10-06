import { expect, it } from 'vitest';

// Throwaway (#407): a deliberately red test, to prove one red shard turns the required check red.
it('fails on purpose', () => {
  expect(1).toBe(2);
});
