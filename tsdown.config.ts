/**
 * Node-half build (the dsh-llm adapter plugin). tsdown's default config read
 * package.json "main"/"exports"; this config exists to pin the OUTPUT SHAPE:
 *
 *  - `clean: false` so the node and browser halves can share one lib/ (the
 *    canonical build, scripts/build.mjs, empties lib/ itself between halves);
 *  - fixed `chunkFileNames` — tsdown's default hashes every dynamic-import
 *    chunk (`admission-<8hex>.js`), and the hash digests the chunk's own
 *    content, so any source edit renames every chunk and a rebuild leaves
 *    the old files behind. The adapter imports its pool lazily
 *    (`await import('./pool/admission.ts')` etc.), which is why the node
 *    half splits at all; the names here follow the source modules, so a
 *    rebuild overwrites exactly the same files.
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
