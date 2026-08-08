import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Node strips a leading `#!` shebang when it loads a script from disk, but the
 * vm-based runner does not, so an executable build script imported by a test
 * blows up with "Invalid or unexpected token". Remove it before transform.
 */
function stripShebang(): Plugin {
  return {
    name: 'strip-shebang',
    enforce: 'pre',
    transform(code, id) {
      if (code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*/, ''), map: null };
      }
      return null;
    }
  };
}

export default defineConfig({
  plugins: [stripShebang()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts']
  }
});
