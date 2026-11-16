import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The API lives in the Node process; the built app is served by it in production.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4570', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
