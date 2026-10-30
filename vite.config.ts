import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';

function gtrPosVersionAndSwPlugin(): Plugin {
  let appVersion = '2.4.2';
  let appBuildTime = Date.now();

  return {
    name: 'gtr-pos-version-and-sw',
    config(_, { command }) {
      const versionPath = path.resolve(__dirname, 'public/version.json');
      try {
        if (fs.existsSync(versionPath)) {
          const raw = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
          if (raw.version) appVersion = String(raw.version);
          if (raw.buildTime) appBuildTime = Number(raw.buildTime);
        }
      } catch {}

      if (command === 'build') {
        appBuildTime = Date.now();
        try {
          const updatedManifest = {
            version: appVersion,
            buildTime: appBuildTime,
            releaseName: 'GTR POS Enterprise — Push Ventas PWA & Sincronización Unificada'
          };
          fs.writeFileSync(versionPath, JSON.stringify(updatedManifest, null, 2) + '\n', 'utf-8');
        } catch {}
      }

      return {
        define: {
          __APP_VERSION__: JSON.stringify(appVersion),
          __APP_BUILD_TIME__: JSON.stringify(appBuildTime)
        }
      };
    },
    closeBundle() {
      try {
        const distSwPath = path.resolve(__dirname, 'dist/sw.js');
        if (fs.existsSync(distSwPath)) {
          let swContent = fs.readFileSync(distSwPath, 'utf-8');
          swContent = swContent.replace(
            /const CACHE_VERSION = ['"][^'"]+['"];/,
            `const CACHE_VERSION = 'gtr-pos-v${appVersion}-${appBuildTime}';`
          );
          fs.writeFileSync(distSwPath, swContent, 'utf-8');
        }
        const distVersionPath = path.resolve(__dirname, 'dist/version.json');
        const versionPayload = {
          version: appVersion,
          buildTime: appBuildTime,
          releaseName: 'GTR POS Enterprise — Push Ventas PWA & Sincronización Unificada'
        };
        fs.writeFileSync(distVersionPath, JSON.stringify(versionPayload, null, 2) + '\n', 'utf-8');
      } catch (err) {
        console.warn('[gtr-pos-version-and-sw] Warning stamping dist/sw.js:', err);
      }
    }
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      gtrPosVersionAndSwPlugin()
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

