import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    // 4041, pegado al backend, en vez del 5173 por defecto: el rango 5173+ es
    // justo donde viven los proyectos que esta herramienta administra, y Vite
    // camina en silencio al siguiente puerto libre cuando choca. Con
    // strictPort falla de frente en vez de arrancar en un puerto sorpresa.
    port: 4041,
    strictPort: true,
    // En dev el frontend vive en Vite y el backend en 4040; el proxy hace que
    // el navegador vea un solo origen, igual que en produccion.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4040', changeOrigin: true },
    },
  },
});
