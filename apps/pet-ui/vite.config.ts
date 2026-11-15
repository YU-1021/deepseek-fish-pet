import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  define: { 'process.env.VITE_DEV_SERVER_URL': JSON.stringify('http://127.0.0.1:5173') },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
