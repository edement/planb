import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/backup.ts'],
  format: ['esm'],
  target: 'node22',
  noExternal: ['@planb/shared'],
  clean: true,
});
