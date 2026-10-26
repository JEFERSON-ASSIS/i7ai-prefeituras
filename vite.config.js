import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Production is served at https://<sgdm>/i7ai/ next to the SGDM web app.
  // VITE_BASE_PATH=/i7ai/ also in dev for the local SGDM proxy (scripts/local-sgdm-proxy.cjs).
  base: process.env.VITE_BASE_PATH || (command === 'build' ? '/i7ai/' : '/'),
  server: {
    watch: {
      // Generated reports and backend artifacts can be locked by OneDrive.
      ignored: ['**/output/**', '**/backend/**'],
    },
  },
}));
