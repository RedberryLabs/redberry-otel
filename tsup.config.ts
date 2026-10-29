import { defineConfig } from 'tsup';

export default defineConfig({
  // index: the exporter, processor and stores (Vercel and anywhere). node: registerRedberry. init: init(), which
  // loads the optional peers context-async-hooks and resources.
  entry: ['src/index.ts', 'src/node.ts', 'src/init.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  platform: 'node',
  // Peers and runtime deps stay external; @vercel/blob is loaded lazily by the vercelBlob() store, and the
  // OpenTelemetry SDK pieces registerRedberry needs are loaded only by the node entry.
  external: [
    '@opentelemetry/api',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-base',
    '@vercel/blob',
    '@vercel/functions',
    'fflate',
  ],
});
