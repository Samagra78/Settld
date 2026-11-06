import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    // Circle's Web SDK depends on Node built-ins (buffer, util, stream, ...)
    // that browsers lack; this provides browser versions and the Buffer/process globals.
    nodePolyfills(),
  ],
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
})
