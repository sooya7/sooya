import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.SOOYA_API_TARGET ?? 'http://127.0.0.1:8788';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom'] }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true, ws: false },
      '/health': { target: API_TARGET, changeOrigin: true }
    }
  }
});
