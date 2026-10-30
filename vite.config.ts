import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/ZetaAuto-web/',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
