// Placeholder proving the INTEGRATION suite is wired (task 1.2).
// Real integration tests read datastore connection settings from the environment and
// run against dockerized deps (task 6.1: readiness.integration.test.ts).
import { describe, it, expect } from 'vitest';

describe('integration harness', () => {
  it('runs the integration suite', () => {
    expect(true).toBe(true);
  });
});
