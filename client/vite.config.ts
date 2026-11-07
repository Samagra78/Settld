import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Dev: /api is proxied to the backend so the session cookie stays same-origin.
// Default is the live Railway backend; set VITE_API_PROXY=http://localhost:3000 in client/.env.local
// to use a server running on this laptop instead.
const RAILWAY = 'https://settld-backend-production.up.railway.app'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_API_PROXY || RAILWAY
  return {
    plugins: [
      react(),
      // Circle's Web SDK depends on Node built-ins (buffer, util, stream, ...)
      // that browsers lack; this provides browser versions and the Buffer/process globals.
      nodePolyfills(),
    ],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          secure: true,
          // keep the backend's cookie on this dev origin
          cookieDomainRewrite: '',
        },
      },
      // the deadlock checker and ABIs live in ../shared
      fs: { allow: ['..'] },
    },
  }
})
