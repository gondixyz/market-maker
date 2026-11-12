import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Builds the desktop app into `out/`: main and preload for Node, the renderer for the browser.
 * electron-vite externalizes main's and preload's dependencies by default (`build.externalizeDeps`,
 * https://electron-vite.org/config/#build-externalizedeps), so they load from `node_modules`.
 * The preload is CommonJS because a sandboxed preload cannot load an ES module
 * (https://www.electronjs.org/docs/latest/tutorial/esm#sandboxed-preload-scripts-cant-use-esm-imports).
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'src/desktop/main/index.ts' },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: 'src/desktop/preload/index.ts' },
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/desktop/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: 'src/desktop/renderer/index.html' },
    },
  },
});
