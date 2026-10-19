import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react';
export default defineConfig({ base: process.env.VITE_BASE_PATH ?? '/v2/', plugins: [react()], server: { proxy: { '/api': 'http://127.0.0.1:5082', '/hubs': { target: 'http://127.0.0.1:5082', ws: true } } }, build: { outDir: 'dist', emptyOutDir: true } });
