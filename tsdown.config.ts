/**
 * Node-half build (the dsh-llm adapter plugin). It pins the OUTPUT SHAPE:
 *
 *  - `clean: false` so the node and browser halves share one lib/ (the
 *    canonical build, scripts/build.mjs, empties lib/ itself between halves);
 *  - fixed `chunkFileNames` — the adapter imports its pool lazily
 *    (`await import('./pool/admission.ts')`), so the node half splits, and a
 *    content-hashed name would rename every chunk on any source edit and leave
 *    the old files behind. Names follow the source modules, so a rebuild
 *    overwrites exactly the same files.
 *
 * The browser half keeps its own tsdown.client.config.ts.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  clean: false,
  splitting: true,
  outputOptions: {
    chunkFileNames: '[name].js',
  },
})
