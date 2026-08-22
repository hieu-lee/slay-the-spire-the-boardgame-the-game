import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.VITE_SINGLE_PLAYER === 'true' ? './' : '/',
  plugins: [react()],
  server: {
    // Vite 7 rejects requests whose Host header it does not recognise, which
    // blocks the whole point of a tunnel. Allow the tunnel domains explicitly.
    allowedHosts: ['.trycloudflare.com', '.cfargotunnel.com'],
    // ponytail: room server is a separate process; proxy keeps one origin for tunnels
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true, changeOrigin: true },
    },
  },
})
