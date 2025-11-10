import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8000,
    // Disable auto-open since we're running in Coder Desktop
    // open: '/examples/sgr-demo.html',
    allowedHosts: ['.coder'],
  },
  build: {
    lib: {
      entry: 'lib/index.ts',
      name: 'GhosttyTerminal',
      fileName: 'ghostty-terminal',
    },
  },
});
