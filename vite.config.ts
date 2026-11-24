import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const localServer = {
  // Let the room server answer the Pages origin's preflight through the proxy.
  cors: false,
  // The room server is a separate process; the proxy keeps local development on one origin.
  proxy: {
    '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    '/ws': { target: 'ws://127.0.0.1:8787', ws: true, changeOrigin: true },
  },
}

function manualChunks(id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/')
  if (normalized.includes('/node_modules/react/')
    || normalized.includes('/node_modules/react-dom/')
    || normalized.includes('/node_modules/scheduler/')) {
    return 'react-vendor'
  }
  if (normalized.includes('/src/ui/tutorial/')) {
    return 'tutorial-data'
  }
  if (!normalized.includes('/src/game/')) return undefined
  if ((normalized.includes('/src/game/downfall/') && !normalized.endsWith('/src/game/downfall/slime-boss.ts'))
    || normalized.endsWith('/src/game/types.ts')
    || normalized.endsWith('/src/game/rng.ts')) {
    return 'game-downfall'
  }
  if (normalized.endsWith('/src/game/skin-card-faces.ts') || normalized.endsWith('/src/game/skins.ts')) {
    return 'game-skins'
  }
  if (normalized.endsWith('/src/game/cards.ts')
    || normalized.includes('/src/game/slayer/')
    || normalized.endsWith('/src/game/downfall/slime-boss.ts')) {
    return 'game-cards'
  }
  if (normalized.endsWith('/src/game/enemies.ts')
    || normalized.endsWith('/src/game/enemy-types.ts')
    || normalized.endsWith('/src/game/events.ts')
    || normalized.endsWith('/src/game/relics.ts')
    || normalized.endsWith('/src/game/neow.ts')) {
    return 'game-enemies'
  }
  return 'game-engine'
}

export default defineConfig(({ mode }) => {
  const singlePlayer = (process.env.VITE_SINGLE_PLAYER ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_SINGLE_PLAYER) === 'true'
  const hostedSession = (process.env.VITE_HOSTED_SESSION ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_HOSTED_SESSION) === 'true'
  return {
    base: singlePlayer || hostedSession ? './' : '/',
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks,
        },
      },
    },
    server: localServer,
    preview: localServer,
  }
})
