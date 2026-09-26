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

    if (!phone) {
      let releaseFetch
      let interceptedFetch
      const pendingFetch = new Promise((resolvePromise) => { interceptedFetch = resolvePromise })
      const heldFetch = new Promise((resolvePromise) => { releaseFetch = resolvePromise })
      await page.route('**/api/mail', async (route) => {
        const response = await route.fetch()
        interceptedFetch()
        await heldFetch
        await route.fulfill({ response })
      }, { times: 1 })
      await envelope.click()
      await pendingFetch
      await page.getByRole('dialog', { name: 'Letters' }).getByRole('button', { name: 'Close' }).click()
      releaseFetch()
      const unreadAfterClose = await api('/api/mail', { method: 'POST', body: JSON.stringify({ token: player.token }) })
      check('desktop: closing during the first fetch does not consume unread personal mail', () =>
        assertEqual(unreadAfterClose.unread, 1))
    }
    await envelope.click()
    const dialog = page.getByRole('dialog', { name: 'Letters' })
    await dialog.locator('.mailbox__letter--developer').first().waitFor()
    await page.locator('.mailbox__badge').waitFor({ state: 'detached' })
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
    const initialMail = await api('/api/mail', { method: 'POST', body: JSON.stringify({ token: mailboxAdmin.token }) })
    await page.waitForFunction((count) => document.querySelector('.mailbox__badge')?.textContent === String(count),
      initialMail.unread + initialMail.personalUnread, { timeout: 10_000 })
    await envelope.click()
    const dialog = page.locator('dialog.mailbox')
    await dialog.getByRole('heading', { name: 'Server mail' }).waitFor()
    const report = dialog.getByRole('button', { name: new RegExp(reporter.username) })
    const firstBefore = await dialog.locator('.mailbox__threads > li:not(.mailbox__personal) > button').first().innerText()
    await page.screenshot({ path: join(output, `${screen}-server-inbox.png`) })
    if (!phone) {
      let releaseThreadFetch
      let interceptedThreadFetch
      const pendingThreadFetch = new Promise((resolvePromise) => { interceptedThreadFetch = resolvePromise })
      const heldThreadFetch = new Promise((resolvePromise) => { releaseThreadFetch = resolvePromise })
      await page.route('**/api/mail/desk', async (route) => {
        const response = await route.fetch()
        interceptedThreadFetch()
        await heldThreadFetch
        await route.fulfill({ response })
      }, { times: 1 })
      const delayedThread = page.waitForResponse((response) => response.url().endsWith('/api/mail/desk') &&
        response.request().postDataJSON()?.username === reporter.username)
      await report.click()
      await pendingThreadFetch
      await dialog.getByRole('button', { name: 'Close' }).click()
      await envelope.click()
      await dialog.getByRole('heading', { name: 'Server mail' }).waitFor()
      releaseThreadFetch()
      await delayedThread
      await page.evaluate(() => new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))))
      const serverThreads = await api('/api/mail/desk', { method: 'POST', body: JSON.stringify({ token: mailboxAdmin.token }) })
      check('desktop: a closed server-thread fetch neither handles unread mail nor reopens a stale thread', () => {
        assertEqual(serverThreads.threads.find((thread) => thread.username === reporter.username)?.unread, 1)
      })
      assertEqual(await dialog.getByRole('heading', { name: 'Server mail' }).count(), 1, 'a stale thread replaced the reopened desk')
    }
    let releaseMark
    let interceptedMark
    let waitForMark
    let stopHoldingMark
    if (phone) {
      const pendingMark = new Promise((resolvePromise) => { interceptedMark = resolvePromise })
      const heldMark = new Promise((resolvePromise) => { releaseMark = resolvePromise })
      const holdMark = async (route) => {
        if (route.request().postDataJSON()?.markRead !== true) return route.continue()
        interceptedMark()
        await heldMark
        await route.continue()
      }
      await page.route('**/api/mail/desk', holdMark)
      waitForMark = pendingMark
      stopHoldingMark = () => page.unroute('**/api/mail/desk', holdMark, { behavior: 'wait' })
    }
    const markedThread = page.waitForResponse((response) => response.url().endsWith('/api/mail/desk') &&
      response.request().postDataJSON()?.username === reporter.username && response.request().postDataJSON()?.markRead === true)
    await report.click()
    await dialog.getByText(`The ${suffix.toLowerCase()} report is ready.`).waitFor()
    if (phone) {
      await waitForMark
      await fetch(`${target}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: reporter.token, body: 'One more detail before you answer.' }) })
      releaseMark()
    }
    const firstReadAt = (await markedThread).request().postDataJSON().readThroughAt
    if (phone) await stopHoldingMark()
    const reply = `Handled from ${screen}.`
    await dialog.getByLabel(`Reply to ${reporter.username}`).fill(reply)
    const updatedRead = phone ? page.waitForResponse((response) => response.url().endsWith('/api/mail/desk') &&
      response.request().postDataJSON()?.username === reporter.username && response.request().postDataJSON()?.markRead === true &&
      response.request().postDataJSON()?.readThroughAt > firstReadAt) : null
    await dialog.getByRole('button', { name: 'Reply' }).click()
    await dialog.locator('.mailbox__letter--developer').filter({ hasText: reply }).waitFor()
    if (updatedRead) await updatedRead
    const fits = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
    })
    await page.screenshot({ path: join(output, `${screen}-server-mail.png`) })
    await dialog.getByRole('button', { name: 'Back to server mail' }).click()
    const answered = dialog.getByRole('button', { name: new RegExp(reporter.username) })
    const answeredText = await answered.innerText()
    const firstThread = await dialog.locator('.mailbox__threads > li:not(.mailbox__personal) > button').first().innerText()
    await page.screenshot({ path: join(output, `${screen}-server-answered.png`) })
    const saved = await api(`/api/mail/admin?username=${reporter.username}`)
    check(`${screen}: an owner-bound account reads server mail and replies to its sender`, () => {
      assert(fits, 'the server mailbox does not fit the screen')
      assert(answeredText.includes(reply) && answeredText.includes('Answered'),
        `the replied thread lost its latest state: ${answeredText}`)
      assert(firstBefore.includes(newer.username), 'the ordering fixture did not begin with the newer thread')
      assert(firstThread.includes(reporter.username), 'the replied thread did not move to the newest position')
      assert(saved.threads[0].letters.some((letter) => letter.from === 'developer' && letter.body === reply),
        'the delegated reply did not reach the sender thread')
    })
    if (!phone) {
      await dialog.getByRole('button', { name: new RegExp(newer.username) }).click()
      await dialog.getByText(`A newer ${suffix.toLowerCase()} report.`).waitFor()
      let releaseReply
      let interceptedReply
      const pendingReply = new Promise((resolvePromise) => { interceptedReply = resolvePromise })
      const heldReply = new Promise((resolvePromise) => { releaseReply = resolvePromise })
      await page.route('**/api/mail/desk/reply', async (route) => {
        const response = await route.fetch()
        interceptedReply()
        await heldReply
        await route.fulfill({ response })
      }, { times: 1 })
      const delayedReply = page.waitForResponse((response) => response.url().endsWith('/api/mail/desk/reply'))
      await dialog.getByLabel(`Reply to ${newer.username}`).fill('Handled the other report.')
      await dialog.getByRole('button', { name: 'Reply' }).click()
      await pendingReply
      const blockedBack = await dialog.getByRole('button', { name: 'Back to server mail' }).isDisabled()
      const blockedClose = await dialog.getByRole('button', { name: 'Close' }).isDisabled()
      await page.keyboard.press('Escape')
      const stayedOpen = await dialog.evaluate((element) => element.open)
      releaseReply()
      await delayedReply
      await dialog.getByText('Handled the other report.').waitFor()
      await dialog.getByRole('button', { name: 'Back to server mail' }).click()
      await dialog.getByRole('button', { name: new RegExp(newer.username) }).waitFor()
      check('desktop: navigation waits for a pending reply to finish', () => {
        assert(blockedBack && blockedClose && stayedOpen, 'sending allowed navigation away from an unacknowledged reply')
      })
      await fetch(`${target}/api/mail/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: newer.token, body: 'Arrived after the desk loaded.' }) })
      const lateRead = page.waitForResponse((response) => response.url().endsWith('/api/mail/desk') &&
        response.request().postDataJSON()?.username === newer.username && response.request().postDataJSON()?.markRead === true)
      await dialog.getByRole('button', { name: new RegExp(newer.username) }).click()
      await dialog.getByText('Arrived after the desk loaded.').waitFor()
      await lateRead
      const refreshedThread = await api('/api/mail/desk', { method: 'POST',
        body: JSON.stringify({ token: mailboxAdmin.token, username: newer.username }) })
      check('desktop: opening a thread reads mail newer than the desk preview', () => {
        assertEqual(refreshedThread.threads[0].unread, 0)
      })
      await dialog.getByRole('button', { name: 'Back to server mail' }).click()
      await dialog.getByRole('button', { name: new RegExp(newer.username) }).waitFor()
    }
    const composerOnDesk = await dialog.locator('.mailbox__compose').count()
    const ownThreadOnDesk = await dialog.getByRole('button', { name: new RegExp(mailboxAdmin.username) }).count()
    check(`${screen}: delegated accounts read and reply without composing a personal letter`, () => {
      assertEqual(composerOnDesk, 0)
      assertEqual(ownThreadOnDesk, 0, 'the owner\'s historic letter appeared in their own desk')
      assert(initialMail.admin, 'the owner-bound account lost server-mail access')
    })
    await api('/api/mail/admin/reply', { method: 'POST', body: JSON.stringify({ username: mailboxAdmin.username, body: `Personal reply for ${screen}.` }) })
    await dialog.getByRole('button', { name: /Your letters/ }).click()
    await dialog.getByRole('heading', { name: 'Your letters' }).waitFor()
    await dialog.getByText(`Personal reply for ${screen}.`).waitFor()
    const personalComposer = await dialog.locator('.mailbox__compose').count()
    const personalReply = await dialog.getByText(`Personal reply for ${screen}.`).count()
    const personalFits = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1
    })
    await page.screenshot({ path: join(output, `${screen}-personal-mail.png`) })
    await dialog.getByRole('button', { name: 'Back to server mail' }).click()
    await dialog.getByRole('heading', { name: 'Server mail' }).waitFor()
    check(`${screen}: personal letters are readable but admins cannot send them`, () => {
      assertEqual(personalComposer, 0)
      assertEqual(personalReply, 1)
      assert(personalFits, 'the personal mailbox does not fit the screen')
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
