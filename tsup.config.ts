import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  platform: 'node',
  // Peers and runtime deps stay external; @vercel/blob is loaded lazily by the vercelBlob() store.
  external: ['@opentelemetry/api', '@opentelemetry/sdk-trace-base', '@vercel/blob', '@vercel/functions', 'fflate'],
});
