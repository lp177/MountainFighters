import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Writes the service worker, with the list of files it should precache baked
 * into it.
 *
 * The list cannot be written by hand: every chunk is content-hashed, so the
 * names change on every build that changes anything. The worker template lives
 * in `src/pwa/sw.template.js` — plain JS, deliberately outside the app's own
 * module graph, because a service worker runs in a different global scope and
 * must not accidentally pull the game in with it.
 *
 * The build id is a hash of the precache list, which means it changes exactly
 * when the shipped bytes change. A rebuild that emits identical files emits an
 * identical worker, so the browser sees no update and nobody is asked to reload
 * for nothing.
 */
function serviceWorker(): Plugin {
  return {
    name: 'mountainfighters-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => !name.endsWith('.map'))
        .map((name) => `./${name}`)
        .sort();

      // Two things are not in the bundle and have to be named.
      //
      // The scope root, because a cold offline visit lands on the directory,
      // not on index.html — and the file itself, because a visitor who typed
      // the full path deserves the same answer. And everything copied out of
      // public/, which never passes through the bundle at all: without the
      // manifest and its icons an installed copy has no identity offline.
      const extras = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-maskable.svg'];
      const precache = [...new Set([...extras, ...assets])];
      const buildId = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);

      const template = readFileSync(
        fileURLToPath(new URL('./src/pwa/sw.template.js', import.meta.url)),
        'utf8',
      );
      // replaceAll, not replace: both markers are named in the template's own
      // doc comment, so a first-occurrence-only substitution rewrites the prose
      // and leaves the constants underneath it untouched.
      const source = template
        .replaceAll('__BUILD_ID__', buildId)
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// Built output lands in /docs so GitHub Pages can serve it straight from the
// default branch. base is relative so the same bundle works from a project
// page (lp177.github.io/MountainFighters/) and from a local file preview.
export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          peer: ['peerjs'],
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
