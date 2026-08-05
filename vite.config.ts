import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Built output lands in /docs so GitHub Pages can serve it straight from the
// default branch. base is relative so the same bundle works from a project
// page (lp177.github.io/mountainfighters/) and from a local file preview.
export default defineConfig({
  base: './',
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
