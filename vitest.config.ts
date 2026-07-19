import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Two suites, split by filename suffix (not directory), so tests stay co-located:
//   unit        -> src/**/*.test.ts        (excluding *.integration.test.ts)
//   integration -> src/**/*.integration.test.ts   (needs dockerized PG/Redis/Ollama)
// Run one with `vitest --project <name>`; scripts wire `test` / `test:integration`.
export default defineConfig({
  resolve: {
    alias: {
      // Resolve #src/* against source, overriding the package.json "imports"
      // default condition (which points at compiled dist/).
      '#src': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
        },
      },
    ],
  },
});
