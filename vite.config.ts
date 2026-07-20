import { defineConfig } from 'vite';

// Relative base so the built site works when served from any subpath
// (e.g. GitHub Pages project sites).
export default defineConfig({
  base: './',
  server: {
    open: true,
  },
});
