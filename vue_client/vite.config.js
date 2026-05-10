import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import mkcert from 'vite-plugin-mkcert';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBase = env.VITE_API_BASE || 'http://localhost:8010';
  // WebAuthn requires HTTPS for any non-localhost hostname. mkcert generates a
  // locally-trusted cert so the dev hostname (mapped to 127.0.0.1 in /etc/hosts)
  // works without browser warnings.
  const host = env.VITE_DEV_HOST || 'irc.local.bradroot.me';

  return {
    plugins: [vue(), mkcert()],
    server: {
      host,
      port: 5173,
      proxy: {
        '/api': {
          target: apiBase,
          changeOrigin: true,
        },
        '/ws': {
          target: apiBase.replace(/^http/, 'ws'),
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
