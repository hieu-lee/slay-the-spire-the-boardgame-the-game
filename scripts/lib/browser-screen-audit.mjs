import { strict as assert } from 'node:assert'

export function installScreenAudit(page) {
  const screenshot = page.screenshot.bind(page)
  page.screenshot = async (options = {}) => {
    const label = options.path ?? 'unnamed screenshot'
    if (options.fullPage) await page.locator('img[loading="lazy"]').evaluateAll((images) => {
      for (const image of images) image.loading = 'eager'
    })
    try {
      await page.waitForFunction(() => [...document.images].every((image) => {
        const style = getComputedStyle(image)
        const box = image.getBoundingClientRect()
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0
        return !visible || image.complete && image.naturalWidth > 0
      }), undefined, { timeout: 15_000 })
    } catch (error) {
      const pending = await page.locator('img').evaluateAll((images) => images
        .filter((image) => {
          const style = getComputedStyle(image)
          const box = image.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0 && (!image.complete || image.naturalWidth === 0)
        })
        .map((image) => image.currentSrc || image.src))
      throw new Error(`${label}: visible images did not load: ${pending.join(', ')}`, { cause: error })
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const issues = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0
      }
      const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      const problems = []
      const supportedDesktop = innerWidth >= 1024 && innerHeight >= 700
      if (supportedDesktop && document.documentElement.scrollWidth > innerWidth + 2) {
        problems.push(`document overflows horizontally: ${document.documentElement.scrollWidth} > ${innerWidth}`)
      }
      for (const image of document.querySelectorAll('img')) {
        if (visible(image) && (!image.complete || image.naturalWidth === 0)) problems.push(`broken visible image: ${image.getAttribute('src')}`)
      }
      const panels = supportedDesktop
        ? document.querySelectorAll('dialog:modal, .neow-action, .quick-setup, .reward-screen, .room-screen')
        : []
      for (const panel of panels) {
        if (!visible(panel)) continue
        const style = getComputedStyle(panel)
        if (style.overflowY === 'hidden' && panel.scrollHeight > panel.clientHeight + 2) {
          problems.push(`clipped panel: ${panel.className}`)
        }
      }
      const endTurn = document.querySelector('.combat__end-turn')
      const piles = document.querySelector('.hand-area__stats')
      const combat = document.querySelector('.app-shell--combat .combat')
      if (supportedDesktop && combat && visible(combat) && combat.getBoundingClientRect().bottom < innerHeight - 2) {
        problems.push(`combat stage leaves ${Math.round(innerHeight - combat.getBoundingClientRect().bottom)}px blank below it`)
      }
      if (endTurn && piles && visible(endTurn) && visible(piles) && overlap(endTurn.getBoundingClientRect(), piles.getBoundingClientRect())) {
        problems.push('end-turn control overlaps pile counts')
      }
      if (endTurn && visible(endTurn)) {
        const endTurnBox = endTurn.getBoundingClientRect()
        const coveredPilePart = [...document.querySelectorAll('.hand-area .pile__stack, .hand-area .pile__count, .hand-area .pile__top')].find((part) =>
          visible(part) && overlap(endTurnBox, part.getBoundingClientRect()))
        if (coveredPilePart) {
          const partBox = coveredPilePart.getBoundingClientRect()
          problems.push(`end-turn control overlaps ${coveredPilePart.closest('.pile')?.getAttribute('title') ?? 'a pile count'} (${Math.round(endTurnBox.left)},${Math.round(endTurnBox.top)}-${Math.round(endTurnBox.right)},${Math.round(endTurnBox.bottom)} vs ${Math.round(partBox.left)},${Math.round(partBox.top)}-${Math.round(partBox.right)},${Math.round(partBox.bottom)})`)
        }
        for (const bar of document.querySelectorAll('.enemy .bar')) {
          if (visible(bar) && overlap(endTurnBox, bar.getBoundingClientRect())) {
            problems.push('end-turn control overlaps an enemy health bar')
            break
          }
        }
      }
      for (const strip of document.querySelectorAll('.seat__status-strip')) {
        const bar = strip.parentElement?.querySelector('.seat > .bar')
        if (visible(strip) && bar && visible(bar) && overlap(strip.getBoundingClientRect(), bar.getBoundingClientRect())) {
          problems.push('character status strip overlaps its health bar')
        }
      }
      const reward = document.querySelector('.neow-action--offer')
      if (supportedDesktop && reward && visible(reward) && /Card Reward|Choose a Card/i.test(reward.textContent ?? '')) {
        const shownCards = [...reward.querySelectorAll('.card')].filter(visible)
        if (shownCards.length === 0) problems.push('card reward announces cards but none are visible')
        const fullyVisible = shownCards.some((card) => {
          const box = card.getBoundingClientRect()
          return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
        })
        if (!fullyVisible) problems.push('card reward has no complete card inside the viewport')
      }
      const forbidden = [...document.querySelectorAll('button, label')].filter(visible)
        .map((element) => element.textContent?.trim() ?? '')
        .filter((text) => /^(Resolve enemies|Start turn \d+|Mark complete)$/.test(text))
      if (forbidden.length) problems.push(`developer or redundant controls visible: ${forbidden.join(', ')}`)
      return problems
    })
    assert.deepEqual(issues, [], `${label}: ${issues.join('; ')}`)
    return screenshot(options)
  }
  return page
}
