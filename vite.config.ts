import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

/** Every file under public/, relative to it. These are copied verbatim to the root. */
function listPublic(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join(posix.sep));
    }
  };
  try {
    walk(dir);
  } catch {
    /* no public dir; nothing to copy */
  }
  return out.sort();
}

/**
 * Writes the service worker, with everything it cannot know for itself baked in.
 *
 * Three such things. The precache list, because every chunk is content-hashed
 * and the names change with the contents. The set of files safe to cache
 * forever, which is exactly the hashed ones — inferring that from the SHAPE of a
 * filename gets it wrong the day somebody adds `public/data-2024.json`, and gets
 * it wrong permanently, because the whole point of the set is that its members
 * are never revalidated. And the build id, which decides when a player is told
 * there is something new.
 *
 * The build id hashes the shipped BYTES, not the file names. Hashing names looks
 * equivalent — a changed chunk gets a changed name — but nothing under public/
 * is hashed at all, so a corrected manifest or a redrawn icon would have shipped
 * to precisely nobody.
 *
 * The template lives in `src/pwa/sw.template.js`: plain JS, deliberately outside
 * the app's module graph, because a service worker runs in a different global
 * scope and must not drag the game in with it.
 */
function serviceWorker(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const publicDir = join(root, 'public');

  return {
    name: 'mountainfighters-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const digest = createHash('sha256');

      const bundled: string[] = [];
      const immutable: string[] = [];
      for (const name of Object.keys(bundle).sort()) {
        if (name.endsWith('.map')) continue;
        const entry = bundle[name];
        const bytes = entry.type === 'chunk' ? entry.code : entry.source;
        digest.update(name).update('\0');
        digest.update(typeof bytes === 'string' ? bytes : Buffer.from(bytes));
        bundled.push(`./${name}`);
        // index.html is in the bundle but is NOT content-hashed, so it must
        // never join the cache-forever set.
        if (name.startsWith('assets/')) immutable.push(`./${name}`);
      }

      // public/ never passes through the bundle, so it is enumerated here or it
      // is invisible to both the precache and the build id. Enumerated rather
      // than listed by hand: a list by hand drifts the moment public/ changes.
      const publics: string[] = [];
      for (const rel of listPublic(publicDir)) {
        // Not a resource; it exists to tell Pages not to run Jekyll.
        if (rel === '.nojekyll') continue;
        publics.push(`./${rel}`);
        digest.update(rel).update('\0').update(readFileSync(join(publicDir, rel)));
      }

      // The scope root is precached alongside index.html: a cold offline visit
      // lands on the directory, and somebody who typed the full path deserves
      // the same answer.
      const precache = [...new Set(['./', './index.html', ...publics, ...bundled])].sort();
      const buildId = digest.digest('hex').slice(0, 12);

      const template = readFileSync(join(root, 'src', 'pwa', 'sw.template.js'), 'utf8');
      // replaceAll, not replace: the markers are named in the template's own doc
      // comment, so a first-occurrence-only substitution rewrites the prose and
      // leaves the constants underneath it untouched.
      const source = template
        .replaceAll('__BUILD_ID__', buildId)
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2))
        .replaceAll('__IMMUTABLE__', JSON.stringify(immutable.sort(), null, 2));

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
