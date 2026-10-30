import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'

const server = await createServer({ logLevel: 'silent', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch()
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(async () => {
      const [React, DOM, Core, { Card }] = await Promise.all([
        import('/@id/react'), import('/@id/react-dom/client'), import('/@id/react-dom'), import('/src/ui/Card.tsx'),
      ])
      document.querySelector('#root').style.display = 'none'
      const host = document.createElement('main')
      host.className = 'sts-scope'
      host.style.padding = '40px'
      document.body.append(host)
      const root = (DOM.createRoot ?? DOM.default.createRoot)(host)
      const createElement = React.createElement ?? React.default.createElement
      const flushSync = Core.flushSync ?? Core.default.flushSync
      const fixture = window.disabledCardFixture = { plays: 0, presses: 0 }
      fixture.render = playable => flushSync(() => root.render(createElement(Card, {
        card: { uid: 'strike', defId: 'strike_ironclad', upgraded: false },
        playable, style: { '--card-width': '180px' },
        onClick: () => { fixture.plays++ },
        onPointerDown: () => { fixture.presses++ },
      })))
      fixture.render(false)
    })
    const card = page.locator('main > .card')
    await card.hover()
    await page.mouse.down()
    assert.equal(await card.evaluate(element => element === document.activeElement), false,
      'a disabled mouse press must not leave the card focused')
    assert.equal(await page.evaluate(() => window.disabledCardFixture.presses), 0,
      'a disabled press must not start a drag handler')
    await page.evaluate(() => window.disabledCardFixture.render(true))
    await page.mouse.up()
    assert.equal(await page.evaluate(() => window.disabledCardFixture.plays), 0,
      'enabling the card between press and release must not play it')
    await card.click()
    assert.equal(await page.evaluate(() => window.disabledCardFixture.plays), 1)
    await page.evaluate(() => window.disabledCardFixture.render(false))
    await card.focus()
    assert(await card.evaluate(element => element === document.activeElement), 'keyboard inspection remains available')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.disabledCardFixture.plays), 1)
    await page.evaluate(() => window.disabledCardFixture.render(true))
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.disabledCardFixture.plays), 2)
    await page.close()
    console.log(`PASS ${viewport.width}: disabled presses, phase-change race and keyboard activation`)
  }
} finally {
  await browser.close()
  await server.close()
}
