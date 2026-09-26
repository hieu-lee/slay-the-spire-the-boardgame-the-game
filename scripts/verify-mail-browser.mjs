// The main menu's mailbox against a real room server: an unread reply badges
// the envelope, opening it reads the thread and clears the badge, and a letter
// written in the dialog reaches the developer's inbox.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from './lib/profile-browser.mjs'
import { ownerOf } from './lib/mail.mjs'
import { createRoomServer } from './room-server.mjs'
import { suite, check, assert, assertEqual, report } from './lib/harness.mjs'

suite('mailbox browser')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'artifacts/mail-browser')
mkdirSync(output, { recursive: true })
const adminToken = 'mail-browser-admin-token-000000000001'
const player = { username: 'TestPlayer', token: '00000000-0000-4000-8000-000000000001' }
const mailboxAdmin = { username: 'MailboxKeeper', token: '00000000-0000-4000-8000-000000000099' }
const rooms = createRoomServer({ mailAdminToken: adminToken, mailAdminOwners: [ownerOf(mailboxAdmin.token)] })
const roomAddress = await rooms.listen(0)
const target = `http://127.0.0.1:${roomAddress.port}`
const api = async (path, init = {}) => {
  const response = await fetch(`${target}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` } })
  return response.json()
}
for (const profile of [player, mailboxAdmin]) {
  await fetch(`${target}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
}
await api('/api/mail/admin/reply', { method: 'POST', body: JSON.stringify({ username: player.username, body: 'Welcome to the Spire! Tell me what you think.' }) })

process.env.VITE_MAIL = 'true'
const vite = await createServer({ root, logLevel: 'silent', server: {
  host: '127.0.0.1', port: 0, proxy: { '/api': { target } },
} })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('vite did not report a port')
const browser = await chromium.launch()
const errors = []

try {
  for (const [screen, viewport, phone] of [
    ['desktop', { width: 1440, height: 900 }, false],
    ['landscape-phone', { width: 844, height: 390 }, true],
  ]) {
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${screen}: ${error.message}`))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${screen}: ${message.text()}`) })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('.start-menu__nav').waitFor()
    const envelope = page.getByRole('button', { name: /^Mail/ })
    await page.locator('.mailbox__badge').waitFor({ timeout: 10_000 })
    const placement = await envelope.evaluate((button) => {
      const box = button.getBoundingClientRect()
      const nav = document.querySelector('.start-menu__nav').getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return {
        right: innerWidth - box.right, top: box.top, width: box.width,
        clearOfNav: box.bottom < nav.top || box.left > nav.right,
        hittable: Boolean(hit && button.contains(hit)),
      }
    })
    const badge = await page.locator('.mailbox__badge').textContent()
    const label = await envelope.getAttribute('aria-label')
    await page.screenshot({ path: join(output, `${screen}-menu.png`) })
    check(`${screen}: the envelope sits top right and badges an unread reply`, () => {
      assert(placement.right >= 0 && placement.right < 60 && placement.top >= 0 && placement.top < 50,
        `the envelope is not in the top-right corner: ${JSON.stringify(placement)}`)
      assert(placement.width >= 44, 'the envelope is below the 44px touch floor')
      assert(placement.clearOfNav && placement.hittable, 'the envelope overlaps the menu or is covered')
      assertEqual(badge, '1')
      assertEqual(label, 'Mail, 1 unread')
    })

    await envelope.click()
    const dialog = page.getByRole('dialog', { name: 'Letters' })
    await dialog.locator('.mailbox__letter--developer').first().waitFor()
    await page.waitForFunction(() => document.activeElement?.id === 'mailbox-draft', undefined, { timeout: 3_000 }).catch(() => {})
    const opened = {
      letters: await dialog.locator('.mailbox__letter').count(),
      badge: await page.locator('.mailbox__badge').count(),
      focused: await page.evaluate(() => document.activeElement?.id),
    }
    const text = phone ? 'Loving the new dice!' : 'The Lab die animation is great.\nCould Wing Boots show uses?'
    await dialog.getByLabel('Your letter').fill(text)
    await dialog.getByRole('button', { name: 'Send' }).click()
    await dialog.locator('.mailbox__letter--player').filter({ hasText: text.split('\n')[0] }).waitFor()
    const fits = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
    })
    await page.screenshot({ path: join(output, `${screen}-letters.png`) })
    const developer = await api(`/api/mail/admin?username=${player.username}`)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    const after = await page.locator('.mailbox__badge').count()
    check(`${screen}: opening the mailbox reads the reply and a sent letter reaches the developer`, () => {
      assert(opened.letters >= 1, 'the reply did not render')
      assertEqual(opened.badge, 0, 'opening the mailbox left the unread badge up')
      assertEqual(opened.focused, 'mailbox-draft', 'the composer did not take focus')
      assert(fits, 'the letters dialog does not fit the screen')
      assert(developer.threads[0].letters.some((letter) => letter.from === 'player' && letter.body === text),
        'the developer inbox did not receive the letter')
      assertEqual(after, 0, 'the badge returned after closing the mailbox')
    })
    await context.close()
    if (!phone) await api('/api/mail/admin/reply', { method: 'POST', body: JSON.stringify({ username: player.username, body: 'Noted, thanks!' }) })
  }

  for (const [screen, viewport, phone] of [
    ['admin-desktop', { width: 1440, height: 900 }, false],
    ['admin-landscape-phone', { width: 844, height: 390 }, true],
  ]) {
    const suffix = phone ? 'Phone' : 'Desktop'
    const reporter = { username: `Reporter${suffix}`, token: `00000000-0000-4000-8000-0000000000${phone ? '03' : '02'}` }
    const newer = { username: `Newer${suffix}`, token: `00000000-0000-4000-8000-0000000000${phone ? '05' : '04'}` }
    for (const profile of [reporter, newer]) {
      await fetch(`${target}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) })
    }
    await fetch(`${target}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: reporter.token, body: `The ${suffix.toLowerCase()} report is ready.` }) })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    await fetch(`${target}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: newer.token, body: `A newer ${suffix.toLowerCase()} report.` }) })

    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${screen}: ${error.message}`))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${screen}: ${message.text()}`) })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.evaluate((profile) => localStorage.setItem('sts-profile', JSON.stringify(profile)), mailboxAdmin)
    await page.reload()
    await page.locator('.start-menu__nav').waitFor()
    const envelope = page.getByRole('button', { name: /^Mail/ })
    await page.locator('.mailbox__badge').waitFor({ timeout: 10_000 })
    await envelope.click()
    const dialog = page.locator('dialog.mailbox')
    await dialog.getByRole('heading', { name: 'Server mail' }).waitFor()
    const report = dialog.getByRole('button', { name: new RegExp(reporter.username) })
    const firstBefore = await dialog.locator('.mailbox__threads > li > button').first().innerText()
    await page.screenshot({ path: join(output, `${screen}-server-inbox.png`) })
    await report.click()
    await dialog.getByText(`The ${suffix.toLowerCase()} report is ready.`).waitFor()
    if (phone) await fetch(`${target}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: reporter.token, body: 'One more detail before you answer.' }) })
    const reply = `Handled from ${screen}.`
    await dialog.getByLabel(`Reply to ${reporter.username}`).fill(reply)
    await dialog.getByRole('button', { name: 'Reply' }).click()
    await dialog.locator('.mailbox__letter--developer').filter({ hasText: reply }).waitFor()
    const fits = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
    })
    await page.screenshot({ path: join(output, `${screen}-server-mail.png`) })
    await dialog.getByRole('button', { name: 'Back to server mail' }).click()
    const answered = dialog.getByRole('button', { name: new RegExp(reporter.username) })
    const answeredText = await answered.innerText()
    const firstThread = await dialog.locator('.mailbox__threads > li > button').first().innerText()
    await page.screenshot({ path: join(output, `${screen}-server-answered.png`) })
    const saved = await api(`/api/mail/admin?username=${reporter.username}`)
    check(`${screen}: an owner-bound account reads server mail and replies to its sender`, () => {
      assert(fits, 'the server mailbox does not fit the screen')
      assert(answeredText.includes(reply) && answeredText.includes(phone ? '1 new' : 'Answered'),
        'the replied thread lost its latest state')
      assert(firstBefore.includes(newer.username), 'the ordering fixture did not begin with the newer thread')
      assert(firstThread.includes(reporter.username), 'the replied thread did not move to the newest position')
      assert(saved.threads[0].letters.some((letter) => letter.from === 'developer' && letter.body === reply),
        'the delegated reply did not reach the sender thread')
    })
    await context.close()
  }
  check('the mailbox raised no page or console errors', () => assertEqual(errors.join('\n'), ''))
} finally {
  await browser.close()
  await vite.close()
  await rooms.close()
}
report('mailbox browser')
