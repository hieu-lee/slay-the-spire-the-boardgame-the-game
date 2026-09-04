import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const tunneledServer = {
  // Vite 7 rejects requests whose Host header it does not recognise, which
  // blocks the whole point of a tunnel. Allow the tunnel domains explicitly.
  allowedHosts: ['.trycloudflare.com', '.cfargotunnel.com'],
  // Let the room server answer the Pages origin's preflight through the proxy.
  cors: false,
  // ponytail: room server is a separate process; proxy keeps one origin for tunnels
  proxy: {
    '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    '/ws': { target: 'ws://127.0.0.1:8787', ws: true, changeOrigin: true },
  },
}

export default defineConfig(({ mode }) => {
  const singlePlayer = (process.env.VITE_SINGLE_PLAYER ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_SINGLE_PLAYER) === 'true'
  const hostedSession = (process.env.VITE_HOSTED_SESSION ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_HOSTED_SESSION) === 'true'
  return {
    base: singlePlayer || hostedSession ? './' : '/',
    plugins: [react()],
    server: tunneledServer,
    preview: tunneledServer,
  }
})
