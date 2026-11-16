import { defineConfig } from 'tsup';

export default defineConfig({
  // index: the exporter and its credentials. init: init(), which loads the optional peers context-async-hooks
  // and resources.
  entry: ['src/index.ts', 'src/init.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  platform: 'node',
  // Peers and runtime deps stay external.
  external: [
    '@opentelemetry/api',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-base',
    '@vercel/functions',
  ],
});
