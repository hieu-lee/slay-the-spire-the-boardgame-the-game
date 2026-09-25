#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium, setTestUsername } from './lib/profile-browser.mjs'
import { suite, check, assert, assertDeepEqual, assertEqual, report } from './lib/harness.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/compendium-browser')
mkdirSync(output, { recursive: true })
const cardArtDir = join(root, 'public/assets/cards')
const GENERATED_STATUS_SCANS = new Set(['curses__daze.webp', 'curses__burn.webp', 'curses__slimed.webp'])
const artSynced = existsSync(cardArtDir) && readdirSync(cardArtDir).some((file) => !GENERATED_STATUS_SCANS.has(file))

suite('compendium browser')
const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`) })
const labels = () => page.locator('.compendium-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
const search = page.getByRole('searchbox', { name: 'Search cards' })
// The title element grows with its text, so a two-line title is measured
// against the face's first grid row, the band it has to stay inside.
const titleBandOverflow = () => page.locator('.compendium-card .card-face').first().evaluate((face) => {
  const title = face.querySelector('.card-face__title')
  const original = title.textContent
  title.textContent = 'Advancing Guard+'
  const band = parseFloat(getComputedStyle(face).gridTemplateRows)
  const overflow = title.getBoundingClientRect().height - band
  title.textContent = original
  return overflow
})
const headerOverlaps = () => page.locator('.compendium__library header').evaluate((header) => {
  const parts = [...header.querySelectorAll(':scope > h2, :scope > span, .compendium__toggles > *')].map((element) => [element, element.getBoundingClientRect()])
  const overlaps = []
  for (const [index, [a, first]] of parts.entries()) {
    for (const [b, second] of parts.slice(index + 1)) {
      if (first.left < second.right - 1 && first.right > second.left + 1 && first.top < second.bottom - 1 && first.bottom > second.top + 1) overlaps.push(`${a.textContent} / ${b.textContent}`)
    }
  }
  return { overlaps, fits: header.scrollWidth <= header.clientWidth + 1 }
})

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'networkidle' })
  await setTestUsername(page, 'Archivist')
  await page.getByRole('button', { name: 'Compendium', exact: true }).click()
  await page.locator('.compendium').waitFor()

  const allCardCount = await page.locator('.compendium-card').count()
  const poolIconView = await page.locator('.compendium__pools button').evaluateAll((buttons) => buttons.map((button) => {
    const image = button.querySelector('img')
    const style = getComputedStyle(button)
    return {
      source: image?.getAttribute('src'),
      loaded: Boolean(image?.complete && image.naturalWidth > 0),
      border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
    }
  }))
  const headings = await page.locator('.compendium__filters h2').allTextContents()
  await page.getByRole('button', { name: '0 energy', exact: true }).click()
  const allZeroCostLabels = await labels()
  await page.getByRole('button', { name: 'All energy costs' }).click()
  const slimeTypeButton = page.getByRole('button', { name: 'Slime cards' })
  const slimeTypeIcon = await slimeTypeButton.locator('img').evaluate((image) => ({
    source: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0,
    width: image.naturalWidth, height: image.naturalHeight,
  }))
  await slimeTypeButton.click()
  const slimeCardTypes = await page.locator('.compendium-card .card-face__type').allTextContents()
  await page.getByRole('button', { name: 'All card types' }).click()
  await page.getByRole('button', { name: 'Ironclad' }).click()
  const ironcladCardCount = await page.locator('.compendium-card').count()
  await page.getByRole('button', { name: 'Power cards' }).click()
  const powerCardLabels = await labels()
  await page.getByRole('button', { name: 'All card types' }).click()
  const rare = page.getByRole('checkbox', { name: 'rare', exact: true })
  await rare.check()
  const rareCardLabels = await labels()
  const rarePillLit = await page.locator('.compendium__rarity--rare').evaluate((pill) => getComputedStyle(pill).backgroundImage.includes('rgb(255, 228, 135)'))
  await rare.uncheck()
  await page.getByRole('button', { name: '0 energy', exact: true }).click()
  const zeroCostCount = await page.locator('.compendium-card').count()
  await page.getByRole('button', { name: 'All energy costs' }).click()
  const firstAscending = await page.locator('.compendium-card').first().getAttribute('aria-label')
  await page.getByRole('button', { name: 'Sorted A–Z' }).click()
  const firstDescending = await page.locator('.compendium-card').first().getAttribute('aria-label')
  await page.getByRole('button', { name: 'Sorted Z–A' }).click()
  await search.fill('Bash')
  const bashCards = await labels()
  await page.getByLabel('View upgrades').check()
  const upgradedBashSource = await page.locator('.compendium-card img').first().getAttribute('src')
  await page.locator('.compendium-card').first().click()
  const detailOpen = await page.locator('.compendium__detail').count()
  const detailModal = await page.locator('.compendium__detail').evaluate((dialog) => dialog.matches(':modal'))
  await shot('card-detail')
  await page.keyboard.press('Escape')
  await page.locator('.compendium__detail').waitFor({ state: 'detached' })
  await search.fill('Havoc')
  await page.getByRole('button', { name: '0 energy', exact: true }).click()
  const upgradedZeroCostNames = await labels()
  await page.getByRole('button', { name: 'All energy costs', exact: true }).click()
  await page.getByLabel('View upgrades').uncheck()
  await search.fill('')
  await page.getByRole('button', { name: 'Guardian' }).click()
  await search.fill('Crystal Edge')
  const guardianGemLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
  const guardianGemFallbackType = await page.locator('.compendium-card .card-face__type').first().textContent()
  await search.fill('Amber')
  const amberTint = await page.waitForFunction(() => {
    const card = document.querySelector('.compendium-card')
    const image = card?.querySelector(':scope > img')
    if (!card || !(image instanceof HTMLImageElement) || image.style.visibility !== 'visible') return null
    return { tint: card.style.getPropertyValue('--gem'), layer: getComputedStyle(card, '::before').content, blend: getComputedStyle(image).mixBlendMode }
  }, undefined, { timeout: artSynced ? 10000 : 1 }).then((handle) => handle.jsonValue(), () => null)
  await page.emulateMedia({ forcedColors: 'active' })
  const forcedGemBlend = await page.locator('.compendium-card > img').first().evaluate((image) => getComputedStyle(image).mixBlendMode)
  const forcedBackdrop = await page.locator('.compendium').evaluate((root) => getComputedStyle(root).backgroundImage)
  await page.emulateMedia({ forcedColors: 'none' })
  await search.fill('Strike')
  const plainCardBlend = await page.locator('.compendium-card > img').first().evaluate((image) => getComputedStyle(image).mixBlendMode)
  await page.getByRole('button', { name: 'Curses' }).click()
  await search.fill('Scorn')
  const hermitCurseLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
  const countLabel = await page.locator('.compendium__library header span').textContent()
  const curse = page.getByRole('checkbox', { name: 'curse', exact: true })
  await curse.check()
  const curseRarityLabels = await labels()
  await curse.uncheck()
  await page.getByLabel('View upgrades').check()
  await search.fill('Clumsy')
  const curseUpgradeSource = await page.locator('.compendium-card img').first().getAttribute('src')
  await page.getByLabel('View upgrades').uncheck()
  // Waited for, not sampled: the grid reads the 448px thumbnail tier and the
  // zoom reads the full scan, so a bare read races `revealDecodedImage`.
  const scanIsPainted = async (selector) => {
    if (!artSynced) return true
    return page.waitForFunction((target) => {
      const image = document.querySelector(target)
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 &&
        getComputedStyle(image).visibility === 'visible'
    }, selector).then(() => true, () => false)
  }
  const curseImageVisible = await scanIsPainted('.compendium-card > img')
  await page.getByRole('button', { name: 'Statuses' }).click()
  await search.fill('Daze')
  const dazeLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
  await page.locator('.compendium-card').first().click()
  await page.locator('.compendium__detail-card').waitFor()
  await scanIsPainted('.compendium__detail-card > img')
  const statusDetailAsset = await page.locator('.compendium__detail-card').evaluate((card) => {
    const image = card.querySelector(':scope > img')
    return {
      source: image?.getAttribute('src'),
      visible: Boolean(image?.complete && image.naturalWidth > 0 && getComputedStyle(image).visibility === 'visible'),
      text: card.querySelector('.card-face')?.textContent ?? '',
    }
  })
  await page.keyboard.press('Escape')
  await search.fill('Slimed')
  const slimedLabel = await page.locator('.compendium-card').first().getAttribute('aria-label')
  await search.fill('')
  await page.getByRole('button', { name: 'All cards' }).click()
  await shot('desktop')

  check('the compendium filters the real card catalog and opens card detail', () => {
    assertEqual(poolIconView.length, 12, 'one painted icon per card pool')
    assert(poolIconView.every((entry) => entry.loaded && entry.source?.includes('/assets/menu/compendium-icons/')),
      `compendium pool icons did not load: ${JSON.stringify(poolIconView)}`)
    assert(poolIconView.every((entry) => entry.border.every((width) => width === '0px')),
      `the old circular pool frames remain: ${JSON.stringify(poolIconView)}`)
    assertDeepEqual(headings, ['Type', 'Rarity', 'Cost'], 'filter headings carry only their names')
    assertDeepEqual(slimeTypeIcon, { source: '/assets/status-icons/slime.png', loaded: true, width: 256, height: 256 })
    assert(slimeCardTypes.length > 0 && slimeCardTypes.every((type) => type === 'Slime'),
      `Slime type filter leaked other card types: ${JSON.stringify(slimeCardTypes)}`)
    assert(allCardCount > ironcladCardCount && ironcladCardCount > 0,
      `pool filtering did not narrow the catalog: ${allCardCount} / ${ironcladCardCount}`)
    assert(allZeroCostLabels.length > 0 && allZeroCostLabels.every((label) => !label?.includes('unplayable')),
      `the 0-Energy filter included unplayable cards: ${allZeroCostLabels.join(' / ')}`)
    assert(powerCardLabels.length > 0 && powerCardLabels.every((label) => label?.includes(', power,')),
      `card-type filtering leaked: ${powerCardLabels.join(' / ')}`)
    assert(rareCardLabels.length > 0 && rareCardLabels.every((label) => label?.endsWith(', rare')),
      `rarity filtering leaked: ${rareCardLabels.join(' / ')}`)
    assert(rarePillLit, 'a checked rarity pill does not light up')
    assert(zeroCostCount > 0 && zeroCostCount < ironcladCardCount,
      `cost filtering did not narrow the catalog: ${zeroCostCount} / ${ironcladCardCount}`)
    assert(firstAscending !== firstDescending, 'A–Z sort did not reverse the card order')
    assertEqual(bashCards.length, 1)
    assert(bashCards[0]?.startsWith('Bash, cost 2, attack') && bashCards[0]?.endsWith(', starter'), bashCards[0])
    assert(upgradedBashSource?.endsWith('ironclad__starter__bash+.webp'), upgradedBashSource)
    assert(upgradedZeroCostNames.some((label) => label?.startsWith('Havoc+, cost 0,')),
      `upgraded cost filter omitted Havoc+: ${upgradedZeroCostNames.join(' / ')}`)
    assert(guardianGemLabel?.includes(', Gem Attack,'), guardianGemLabel)
    assertEqual(guardianGemFallbackType, 'Gem Attack')
    assert(hermitCurseLabel?.startsWith('Scorn') && hermitCurseLabel.includes(', unplayable, curse,'), hermitCurseLabel)
    assertEqual(countLabel, '1 card')
    assert(curseRarityLabels.length > 0 && curseRarityLabels.every((label) => label?.endsWith(', curse')),
      `curse rarity filtering leaked: ${curseRarityLabels.join(' / ')}`)
    assertEqual(detailOpen, 1)
    assert(detailModal, 'card detail should use native modal semantics')
    assert(curseUpgradeSource?.endsWith('curses__clumsy.webp') && !curseUpgradeSource.includes('clumsy+'),
      `non-upgradable curse requested the wrong face: ${curseUpgradeSource}`)
    assert(curseImageVisible, 'the curse scan stayed hidden after changing filters')
    assert(statusDetailAsset.source?.endsWith('curses__daze.webp') && statusDetailAsset.visible &&
      statusDetailAsset.text.includes('Daze') && statusDetailAsset.text.includes('unplayable') &&
      statusDetailAsset.text.includes('ethereal'),
    `Daze status scan did not render: ${JSON.stringify(statusDetailAsset)}`)
    assert(dazeLabel?.includes('unplayable') && dazeLabel.includes('ethereal'), dazeLabel)
    assert(slimedLabel?.includes('cost 1'), slimedLabel)
  })
  check('a clear Guardian Gem is tinted with its stone once its scan paints', () => {
    if (artSynced) assertDeepEqual(amberTint, { tint: '#f3b440', layer: '""', blend: 'multiply' })
    assertEqual(plainCardBlend, 'normal', 'ordinary cards picked up the Gem blend')
    assertEqual(forcedGemBlend, 'normal', 'forced colours drop the Gem colour layer, so the scan must stop multiplying')
    assertEqual(forcedBackdrop, 'none', 'the archive photo stays under forced-colour controls')
  })

  await page.setViewportSize({ width: 1280, height: 800 })
  const compact = await page.locator('.compendium').evaluate((root) => {
    const box = (element) => {
      const rect = element?.getBoundingClientRect()
      return rect && { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const controls = [...root.querySelectorAll('.compendium__filters :is(button, .compendium__rarity, .compendium__upgrade, input[type="search"])')]
    const overlaps = []
    const boxes = controls.map((element) => [element, element.getBoundingClientRect()])
    for (const [index, [a, first]] of boxes.entries()) {
      for (const [b, second] of boxes.slice(index + 1)) {
        if (a.contains(b) || b.contains(a)) continue
        if (first.left < second.right - 1 && first.right > second.left + 1 && first.top < second.bottom - 1 && first.bottom > second.top + 1) {
          overlaps.push(`${a.className || a.tagName} / ${b.className || b.tagName}`)
        }
      }
    }
    return {
      viewport: box(root),
      filters: box(root.querySelector('.compendium__filters')),
      library: box(root.querySelector('.compendium__library')),
      filtersScroll: root.querySelector('.compendium__filters').scrollHeight - root.querySelector('.compendium__filters').clientHeight,
      cardWidth: root.querySelector('.compendium-card')?.getBoundingClientRect().width,
      wrappedPills: [...root.querySelectorAll('.compendium__rarity')]
        .filter((label) => label.scrollWidth > label.clientWidth + 1).map((label) => label.textContent),
      pillHeights: [...root.querySelectorAll('.compendium__rarity')].map((label) => label.getBoundingClientRect().height),
      unstretchedToggles: [...root.querySelectorAll('.compendium__rarity, .compendium__upgrade')].filter((label) => {
        const input = label.querySelector('input').getBoundingClientRect()
        return Math.abs(label.clientWidth - input.width) > 1 || Math.abs(label.clientHeight - input.height) > 1
      }).map((label) => label.textContent),
      overlaps,
      backBeforeSearch: Boolean(root.querySelector('.compendium__back')?.compareDocumentPosition(
        root.querySelector('input[type="search"]')) & Node.DOCUMENT_POSITION_FOLLOWING),
    }
  })
  const compactTitleOverflow = await page.locator('.compendium-card .card-face__title').first().evaluate(async (title) => {
    const { CARDS: definitions, faceOf } = await import('/src/game/cards.ts')
    const original = title.textContent
    const clipped = []
    for (const def of Object.values(definitions)) {
      for (const upgraded of [false, true]) {
        const shown = faceOf(def, upgraded && Boolean(def.upgrade))
        title.textContent = shown.name
        if (title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1) {
          clipped.push(`${shown.name}${upgraded && def.upgrade ? '+' : ''}`)
        }
      }
    }
    title.textContent = original
    return clipped
  })
  const compactTitleBand = await titleBandOverflow()
  const compactHeader = await headerOverlaps()
  await shot('compact-desktop')
  check('the compendium fits a minimum desktop viewport without crowding its controls', () => {
    assert(compact.filters && compact.library, `compact desktop compendium columns are missing: ${JSON.stringify(compact)}`)
    assert(compact.filters.left >= compact.viewport.left - 1 && compact.library.right <= compact.viewport.right + 1,
      `compact desktop compendium leaves the viewport: ${JSON.stringify(compact)}`)
    assertEqual(compact.filtersScroll, 0, 'the desktop filter column has to be scrolled')
    assert((compact.cardWidth ?? 0) >= 100, `compact desktop cards became unreadably small: ${compact.cardWidth}`)
    assertDeepEqual(compact.wrappedPills, [], 'rarity pills clip their labels')
    assert(compact.pillHeights.every((height) => height >= 24), `rarity targets are too short: ${compact.pillHeights}`)
    assertDeepEqual(compact.unstretchedToggles, [], 'a toggle checkbox does not cover its pill')
    assertDeepEqual(compact.overlaps, [], 'compendium filter controls overlap')
    assertDeepEqual(compactTitleOverflow, [], 'compact desktop compendium title clipping')
    assert(compactTitleBand <= 1, `a two-line title spills out of its band by ${compactTitleBand}px`)
    assertDeepEqual(compactHeader, { overlaps: [], fits: true }, 'the library header crowds its controls')
    assert(compact.backBeforeSearch, 'Back must precede Search in keyboard and source order')
  })

  await page.keyboard.press('Shift')
  await page.locator('.compendium__back').focus()
  await page.waitForTimeout(250)
  const backRing = await page.evaluate(() => {
    const back = document.querySelector('.compendium__back')
    const style = getComputedStyle(back)
    return { filter: style.filter, outline: style.outlineStyle, matched: back.matches(':focus-visible') }
  })
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  check('the compendium back arrow uses the shared unclipped keyboard glow', () => {
    assert(backRing.matched, 'the back arrow did not match :focus-visible when focused')
    assertEqual(backRing.outline, 'none', 'the back arrow restored the clipped outline')
    assert(backRing.filter.includes('brightness(1.2)') && backRing.filter.includes('drop-shadow'),
      `the back arrow lost its shared focus glow: ${JSON.stringify(backRing)}`)
  })

  for (const viewport of [{ width: 844, height: 390 }, { width: 568, height: 320 }]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(200)
    const phone = await page.locator('.compendium').evaluate((root) => {
      const filters = root.querySelector('.compendium__filters').getBoundingClientRect()
      const library = root.querySelector('.compendium__library').getBoundingClientRect()
      const back = root.querySelector('.compendium__back').getBoundingClientRect()
      const search = root.querySelector('input[type="search"]').getBoundingClientRect()
      return {
        besideRail: library.left >= filters.right - 1 && Math.abs(library.top - filters.top) < 1,
        back: { top: back.top, bottom: back.bottom, height: back.height, inRail: back.top >= filters.top - 1 && back.bottom <= filters.bottom + 1 },
        searchHeight: search.height,
        cardWidth: root.querySelector('.compendium-card')?.getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        railScroll: root.querySelector('.compendium__filters').scrollHeight - root.querySelector('.compendium__filters').clientHeight,
        clippedPills: [...root.querySelectorAll('.compendium__rarity')].filter((label) => label.scrollWidth > label.clientWidth + 1).map((label) => label.textContent),
      }
    })
    const phoneTitleBand = await titleBandOverflow()
    const phoneHeader = await headerOverlaps()
    await shot(`phone-${viewport.width}x${viewport.height}`)
    check(`the compendium keeps its filter rail beside the cards at ${viewport.width}x${viewport.height}`, () => {
      assert(phone.besideRail, `the filters stacked over the library: ${JSON.stringify(phone)}`)
      assert(phone.back.inRail && phone.back.height >= 40, `the Back ribbon is clipped or collapsed: ${JSON.stringify(phone)}`)
      assert(phone.searchHeight <= 36, `the search box is oversized: ${phone.searchHeight}`)
      assert((phone.cardWidth ?? 0) >= 100, `phone cards became unreadably small: ${phone.cardWidth}`)
      assert(!phone.overflow, 'the compendium scrolls sideways')
      assertEqual(phone.railScroll, 0, 'the filter rail has to be scrolled')
      assertDeepEqual(phone.clippedPills, [], 'rarity pills clip their labels')
      assert(phoneTitleBand <= 1, `a two-line title spills out of its band by ${phoneTitleBand}px`)
      assertDeepEqual(phoneHeader, { overlaps: [], fits: true }, 'the library header crowds its controls')
    })
  }
  check('the compendium raised no page errors', () => assertDeepEqual(errors, []))
} finally {
  await browser.close()
  await server.close()
}
report('compendium browser')
