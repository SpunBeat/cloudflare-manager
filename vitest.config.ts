import { defineConfig } from 'vitest/config';

// Config propia para Vitest: sin esto toma vite.config.ts, cuyo `root` apunta
// a src/web (el frontend) y hace que no encuentre ningun test.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
