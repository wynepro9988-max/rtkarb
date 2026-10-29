import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Logo diimpor dari folder brand/ di root repositori (satu sumber untuk web & Android).
    fs: { allow: [path.resolve(root, '..')] },
    proxy: { '/api': { target: 'http://127.0.0.1:3000' } },
  },
});
