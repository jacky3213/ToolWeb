import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { execSync } from 'child_process';
import {defineConfig} from 'vite';

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf-8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig(() => {
  const buildInfo = {
    sha: getGitSha(),
    time: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  };
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    define: {
      __APP_BUILD__: JSON.stringify(buildInfo),
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
