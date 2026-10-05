// Real engine events rendered by the production combat screen; no synthetic attacks.
export async function installKratosFixture() {
  document.querySelector('#root').style.display = 'none'
  document.documentElement.dataset.mobilePerformance = String(innerWidth < 900)
  document.documentElement.dataset.reducedMotion = 'false'
  const node = document.createElement('div')
  node.className = 'app-shell app-shell--combat sts-scope'
  node.style.gridTemplateRows = 'minmax(0, 1fr)'
  document.body.append(node)
  const [R, D, DOM, { CombatScreen }, { createPlayer }, { createCombat, playCard }, { createRng }] = await Promise.all([
    import('/@id/react'), import('/@id/react-dom/client'), import('/@id/react-dom'),
    import('/src/ui/CombatScreen.tsx'), import('/src/game/run.ts'), import('/src/game/combat.ts'),
    import('/src/game/rng.ts'), import('/src/ui/styles.css'), import('/src/ui/chrome.css'),
  ])
  const root = (D.createRoot ?? D.default.createRoot)(node)
  const flushSync = DOM.flushSync ?? DOM.default.flushSync
  const f = window.kratosFixture = { restoration: 0, run: 0, connected: true }
  f.render = () => flushSync(() => root.render((R.createElement ?? R.default.createElement)(CombatScreen, {
    state: structuredClone(f.state), act: 1, viewerId: 'p1', autoAdvance: false,
    authoritativeRestoration: f.restoration, authoritativeConnected: f.connected, onAction: () => {},
  })))
  f.reset = (character = 'kratos') => {
    const rng = createRng(47)
    const player = createPlayer(rng, 'p1', 'ArtTest', character, 0)
    Object.assign(player, { hand: [], draw: [], relics: [], energy: 9, rage: 3 })
    const enemies = [0, 1].map(i => ({ uid: `enemy-${i}`, defId: 'jaw_worm', row: 0, isBoss: false,
      hp: 30, maxHp: 30, block: 0, strength: 0, vulnerable: 0, weak: 0, poison: 0,
      actionIndex: 0, abilityUsed: true, dead: false }))
    f.state = createCombat(rng, [player], enemies, `kratos-art-${++f.run}`)
    f.state.phase = 'player'
    f.state.players[0].energy = 9
    f.state.presentationEvents = []
    f.connected = true
    f.restoration++
    f.render()
  }
  f.attack = (id = 'strike_kratos') => {
    const held = { uid: `art-${f.run}-${f.state.presentationEvents.length}`, defId: id, upgraded: false }
    f.state.players[0].hand.push(held)
    f.state = playCard(f.state, 'p1', held.uid, { enemyUid: 'enemy-0', row: 0 })
    f.render()
    return f.state.presentationEvents.at(-1).seq
  }
  f.reset()
}

// Alpha bounds in rendered CSS pixels, including contain fit and overscan scale.
export function paintedKratosBounds(selector) {
  const image = document.querySelector(selector)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let left = canvas.width, top = canvas.height, right = 0, bottom = 0
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data[(y * canvas.width + x) * 4 + 3] <= 96) continue
    left = Math.min(left, x); right = Math.max(right, x + 1)
    top = Math.min(top, y); bottom = Math.max(bottom, y + 1)
  }
  const rect = image.getBoundingClientRect()
  const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  return { width: (right - left) * fit, height: (bottom - top) * fit,
    ground: rect.bottom - (canvas.height - bottom) * fit,
    source: image.src, canvas: [rect.width, rect.height] }
}
