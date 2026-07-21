import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Config comes from the repository-root .env, the same file the server and
 * worker read, so there is one place to configure the stack.
 *
 * /api is proxied to the Express server, so the browser only ever talks
 * same-origin and the backend needs no CORS middleware.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');

  return {
    plugins: [react()],
    envDir: projectRoot,
    server: {
      port: Number.parseInt(env.CLIENT_PORT ?? '3000', 10) || 3000,
      proxy: {
        '/api': {
          target: env.VITE_API_BASE_URL ?? 'http://localhost:4000',
          changeOrigin: true
        }
      }
    }
  };
});
