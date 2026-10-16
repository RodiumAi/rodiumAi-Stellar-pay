import { defineConfig } from 'vite';

// Served by the API under /c/assets/ with a strict CSP (context §11.3): no inline code,
// hashed file names, a manifest the server reads to emit nonce'd tags.
export default defineConfig({
  base: '/c/assets/',
  build: {
    outDir: 'dist',
    assetsDir: '',
    manifest: true,
    modulePreload: false,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: { input: 'src/main.ts' },
  },
});
