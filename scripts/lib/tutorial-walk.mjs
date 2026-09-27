// Walks a hero's guided tutorial in a real browser the way a player would:
// Next through explanations, and for every task a click on each ringed control
// in turn. Fights the coach leaves to the player are declared won through the
// debug bridge, and free choices take the plainest option.

const sleep = (page, ms) => page.waitForTimeout(ms)

async function coach(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.tutorial-coach__panel')
    if (!panel) return null
    // Aim at a point inside each ring that something interactive actually
    // covers: an enemy's box is larger than the art that takes the tap.
    const interactive = '[data-enemy-id] .enemy__portrait, .card, button, [data-room], .orbs__target, .prompt__mode'
    const rings = [...document.querySelectorAll('.tutorial-coach__ring')].map((ring) => {
      const box = ring.getBoundingClientRect()
      const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.65], [0.5, 0.35], [0.5, 0.8], [0.35, 0.5], [0.65, 0.5], [0.5, 0.2]]) {
        const point = { x: box.left + box.width * fx, y: box.top + box.height * fy }
        if (document.elementFromPoint(point.x, point.y)?.closest(interactive)) return point
      }
      return centre
    })
    return {
      chapter: panel.getAttribute('data-chapter'),
      step: panel.getAttribute('data-step'),
      title: panel.querySelector('h2')?.textContent ?? '',
      task: panel.classList.contains('tutorial-coach__panel--task'),
      rings,
    }
  })
}

async function freePlay(page) {
  const click = async (selector, text) => {
    const locator = text ? page.locator(selector, { hasText: text }).first() : page.locator(selector).first()
    if (await locator.count() === 0 || !await locator.isVisible()) return false
    // The coach may have spoken up since the check; its shield then wins.
    return locator.click({ timeout: 1500 }).then(() => true, () => false)
  }
  const state = await page.evaluate(() => {
    const run = window.__STS_DEBUG__.getRun()
    return { phase: run.phase, combat: run.combat?.phase, room: run.roomState?.kind ?? null }
  })
  // A window opened by a tap the coach allowed (a full potion belt, say): back out.
  if (await page.locator('dialog[open]').count()) {
    // A card choice (Headbutt, Scry) picks its first card and confirms.
    if (await page.locator('dialog.choice-modal[open]').count()) {
      await click('dialog.choice-modal[open] .choice-modal__cards .card')
      if (await click('dialog.choice-modal[open] .choice-modal__panel > button:not([disabled])')) return 'made a card choice'
    }
    await page.keyboard.press('Escape')
    return 'closed a window'
  }
  // Enemy turns animate; only a quiet player turn is one the coach left to the player.
  if (state.phase === 'combat' && state.combat === 'start' &&
    await click('.combat__end-turn:not([disabled])', 'Resolve start')) return 'resolved the start of turn'
  if (state.phase === 'combat' && state.combat !== 'player') return null
  if (state.phase === 'combat') {
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.combat.phase = 'won'
      for (const enemy of run.combat.enemies) { enemy.hp = 0; enemy.dead = true }
      debug.setRun(run)
    })
    return 'won the fight'
  }
  if (state.phase === 'reward' && await click('.reward-screen__skip')) return 'skipped rewards'
  if (state.phase === 'room' && !state.room) {
    if (await click('.card-picker .card-picker__confirm:not([disabled])')) return 'smithed'
    if (await click('.card-picker__grid .card')) return 'picked a card to smith'
    if (await click('.campfire__choices button:not([disabled])', 'Rest')) return 'rested'
    if (await click('.campfire__choices button:not([disabled])', 'Smith')) return 'chose to smith'
  }
  if (state.phase === 'room' && state.room === 'merchant') {
    if (await click('.merchant-stage .room-proceed')) return 'left the shop'
    if (await click('.merchant-arrival .room-proceed')) return 'proceeded'
  }
  if (state.phase === 'room' && state.room === 'treasure' && await click('.treasure-actions button', 'Skip')) return 'skipped treasure'
  return null
}

/**
 * @param until stops before the first step it accepts
 * @returns {Promise<{ chapters: string[], log: string[], ended?: string, stoppedAt?: object }>}
 */
export async function walkTutorial(page, { onStep, until, maxActions = 600 } = {}) {
  const chapters = []
  const log = []
  let last = ''
  let idle = 0
  let repeats = 0
  for (let action = 0; action < maxActions; action += 1) {
    if (await page.locator('.tutorial-end').count()) return { chapters, log, ended: await page.locator('.tutorial-end h2').textContent() }
    const current = await coach(page)
    if (current) {
      idle = 0
      const key = `${current.chapter}#${current.step}`
      repeats = key === last ? repeats + 1 : 0
      if (repeats > 12) throw Object.assign(new Error(`task ${key} "${current.title}" never completed`), { log })
      if (key !== last) {
        if (until?.(current)) return { chapters, log, stoppedAt: current }
        if (!chapters.includes(current.chapter)) chapters.push(current.chapter)
        log.push(`${key} ${current.task ? 'TASK' : 'say'} ${current.title}`)
        await onStep?.(current)
        last = key
      }
      if (!current.task) {
        await page.locator('.tutorial-coach__next').click()
        await sleep(page, 120)
        continue
      }
      // Let the board settle (stance and card animations swallow early taps).
      await sleep(page, 500)
      let rings = (await coach(page))?.rings ?? current.rings
      for (let wait = 0; rings.length === 0 && wait < 12; wait += 1) {
        await sleep(page, 250)
        rings = (await coach(page))?.rings ?? []
      }
      if (rings.length === 0) throw Object.assign(new Error(`task ${key} "${current.title}" has nothing ringed`), { log })
      // Rings can appear as the move unfolds (a Slime or orb to choose), so
      // reread them after every tap and press the next one.
      const pressed = []
      const seen = [...rings]
      const near = (a, b) => Math.abs(a.x - b.x) < 40 && Math.abs(a.y - b.y) < 40
      for (let index = 0; index < 8; index += 1) {
        // Once every ring has been pressed, a move may still want another tap
        // on its target (each Evoke picks its own enemy): press the last again.
        // A ring that just appeared (a mode or Slime to choose) comes next.
        // A task that offers alternatives (a shelf or Leave) may loop on the
        // first one; after a few tries, take them from the other end.
        const ordered = repeats > 2 ? [...rings].reverse() : rings
        const unpressed = ordered.filter((candidate) => !pressed.some((done) => near(done, candidate)))
        const fresh = unpressed.find((candidate) => !seen.some((old) => near(old, candidate))) ?? unpressed[0]
        seen.push(...rings)
        if (!fresh && pressed.at(-1)?.again) break
        const ring = fresh ?? { ...rings.at(-1), again: true }
        pressed.push(ring)
        if (repeats > 0) log.push(`  tap ${Math.round(ring.x)},${Math.round(ring.y)} of ${rings.map((r) => `${Math.round(r.x)},${Math.round(r.y)}`).join(' ')}`)
        await page.mouse.click(ring.x, ring.y)
        await sleep(page, 900)
        const after = await coach(page)
        if (!after || `${after.chapter}#${after.step}` !== key) break
        if (after.rings.length) rings = after.rings
      }
      continue
    }
    // The coach steps aside while the board animates, so only a lasting
    // silence means the player has been left to play.
    idle += 1
    if (idle < 6) {
      await sleep(page, 250)
      continue
    }
    const did = await freePlay(page)
    if (did) {
      log.push(`free: ${did}`)
      idle = 0
      await sleep(page, 400)
      continue
    }
    if (idle > 60) throw Object.assign(new Error(`tutorial stalled after ${log.at(-1)}`), { log })
    await sleep(page, 250)
  }
  throw Object.assign(new Error(`tutorial did not end: ${log.slice(-5).join(' | ')}`), { log })
}
