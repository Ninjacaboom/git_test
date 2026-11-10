import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Any request starting with /api is forwarded to the .NET backend,
// so the browser never hits CORS problems during development.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
});
