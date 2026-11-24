import { claimProfile, loginProfile, syncAscension } from '../profiles.mjs'
import { claimCoinGrant, confirmCoinGrant } from '../coin-grants.mjs'
import { syncAccountWallet } from '../account-wallets.mjs'
import {
  WELCOME_LETTER,
  announceToPlayers,
  developerInbox,
  developerUnread,
  ownerOf,
  playerInbox,
  sendDeveloperReply,
  sendPlayerLetter,
} from '../mail.mjs'
import {
  addLeaderboardRun,
  dailyLeaderboard,
  leaderboardSnapshot,
  personalStats,
  winningDecksPage,
} from '../leaderboard.mjs'
import { creditRecordedDailyCoins } from '../daily-coins.mjs'
import { randomDeck, statsSnapshot } from '../stats.mjs'
import {
  MAX_RATE_KEYS,
  consume,
  createMailAdminAuth,
  pruneRateMap,
  readJson,
  send,
  sourceOf,
} from './http.mjs'

const MAX_LOGINS_PER_WINDOW = 10
const LOGIN_FAILURE_WINDOW_MS = 10 * 60_000
const MAX_LOGIN_FAILURES_PER_NAME = 8
const MAX_LEADERBOARD_WRITES_PER_WINDOW = 6
const MAX_DECK_READS_PER_WINDOW = 30
const MAX_STATS_READS_PER_WINDOW = 120
const MAX_MAIL_READS_PER_WINDOW = 60
const MAIL_SEND_WINDOW_MS = 10 * 60_000
const MAX_MAIL_SENDS_PER_WINDOW = 5
const MAX_MAIL_SENDS_PER_SOURCE = 20
const MAX_MAIL_ADMIN_REPLIES_PER_WINDOW = 60
const MAX_MAIL_ADMIN_FAILURES_PER_WINDOW = 10
const DECK_PAGE_CACHE_LIMIT = 64
const DECK_QUERY_KEYS = new Set(['sort', 'direction', 'character', 'ascension', 'cursor'])

export function createMetaRoutes({
  store,
  attemptSave,
  queueSave,
  scheduleClassification,
  restrictions,
  mailAdminToken,
  mailAdminOwners,
  maxMailCharacters,
  createWindowMs,
  maxProfileClaimsPerWindow,
}) {
  const profileRates = new Map()
  const loginRates = new Map()
  const loginFailures = new Map()
  const leaderboardRates = new Map()
  const deckReadRates = new Map()
  const dailyReadRates = new Map()
  const statsRates = new Map()
  const mailReadRates = new Map()
  const mailSendRates = new Map()
  const mailProfileRates = new Map()
  const mailAdminReplyRates = new Map()

  const deckPages = new Map()
  let deckPagesRevision = store.leaderboardRevision
  let leaderboardSummary
  let leaderboardSummaryRevision = -1
  const dailyBoards = new Map()
  let dailyBoardsRevision = -1

  const {
    mailAdminKey,
    delegatedMailOwners,
    delegatedMailProfile,
    mailAdminAuthorized,
    sweep: sweepMailAdminFailures,
  } = createMailAdminAuth({
    mailAdminToken,
    mailAdminOwners,
    store,
    failureWindowMs: createWindowMs,
    maxFailures: MAX_MAIL_ADMIN_FAILURES_PER_WINDOW,
  })

  const saveMail = (undo) => {
    store.mailDirty = true
    if (attemptSave()) return true
    undo()
    return false
  }

  function sweepRates(now) {
    pruneRateMap(profileRates, createWindowMs, now)
    pruneRateMap(loginRates, createWindowMs, now)
    pruneRateMap(loginFailures, LOGIN_FAILURE_WINDOW_MS, now)
    pruneRateMap(leaderboardRates, createWindowMs, now)
    pruneRateMap(deckReadRates, createWindowMs, now)
    pruneRateMap(dailyReadRates, createWindowMs, now)
    pruneRateMap(statsRates, createWindowMs, now)
    pruneRateMap(mailReadRates, createWindowMs, now)
    pruneRateMap(mailSendRates, MAIL_SEND_WINDOW_MS, now)
    pruneRateMap(mailProfileRates, MAIL_SEND_WINDOW_MS, now)
    pruneRateMap(mailAdminReplyRates, MAIL_SEND_WINDOW_MS, now)
    sweepMailAdminFailures(now)
  }

  async function handle(request, response, url) {
    if (request.method === 'POST' && url.pathname === '/api/profile') {
      if (!consume(profileRates, sourceOf(request), createWindowMs, maxProfileClaimsPerWindow)) {
        send(response, 429, { error: 'Too many name requests. Please try again shortly.' })
        return true
      }
      const body = await readJson(request)
      // A restricted network only loses new accounts; a known token may still set or confirm its password.
      if (restrictions.isRestrictedNetwork(request) && !store.profiles.some((entry) => entry.token === body.token)) {
        restrictions.rejectRestricted()
      }
      const profile = await claimProfile(store.profiles, body)
      if (!attemptSave()) {
        queueSave()
        send(response, 503, { error: 'Could not save your account. Please try again.' })
        return true
      }
      send(response, 200, { username: profile.username })
      return true
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      if (!consume(loginRates, sourceOf(request), createWindowMs, MAX_LOGINS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many log in attempts. Please try again shortly.' })
        return true
      }
      const body = await readJson(request)
      const failureKey = typeof body.username === 'string' ? body.username.normalize('NFKC').trim().toLowerCase().slice(0, 64) : ''
      // Guessing is capped per name as well as per source, so a name can be locked for a
      // while by anyone who knows it. That trade is accepted: the cap is what stops a
      // botnet guessing one account's password.
      // The attempt is counted before the slow hash, so a burst of parallel guesses cannot
      // all pass the check; a login that is not a wrong password gives its slot back.
      const now = Date.now()
      const failures = loginFailures.get(failureKey)
      const attempts = failures && now - failures.startedAt < LOGIN_FAILURE_WINDOW_MS ? failures : { startedAt: now, count: 0 }
      if (attempts.count >= MAX_LOGIN_FAILURES_PER_NAME) {
        send(response, 429, { error: 'Too many wrong passwords for this name. Please try again later.' })
        return true
      }
      // As with mail admin failures, a full table evicts its oldest name instead of skipping the count.
      if (!failures && loginFailures.size >= MAX_RATE_KEYS) loginFailures.delete(loginFailures.keys().next().value)
      attempts.count += 1
      loginFailures.delete(failureKey)
      loginFailures.set(failureKey, attempts)
      let profile
      try { profile = await loginProfile(store.profiles, body) } catch (error) {
        if (error.status !== 401) attempts.count -= 1
        throw error
      }
      loginFailures.delete(failureKey)
      const restricted = restrictions.isRestrictedName(profile.username)
      if (restricted) restrictions.noteRestrictedSource(request)
      send(response, 200, { username: profile.username, token: profile.token, ...(restricted ? { restricted } : {}) })
      return true
    }

    if (request.method === 'POST' && url.pathname === '/api/profile/status') {
      if (!consume(statsRates, `status:${sourceOf(request)}`, createWindowMs, MAX_STATS_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many requests. Please try again shortly.' })
        return true
      }
      const body = await readJson(request)
      const profile = typeof body.token === 'string' ? store.profiles.find((entry) => entry.token === body.token) : undefined
      const restricted = Boolean(profile) && restrictions.isRestrictedName(profile.username)
      if (restricted) restrictions.noteRestrictedSource(request)
      send(response, 200, { restricted })
      return true
    }

    if (request.method === 'POST' && url.pathname === '/api/profile/stats') {
      if (!consume(statsRates, `profile:${sourceOf(request)}`, createWindowMs, MAX_STATS_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many requests. Please try again shortly.' })
        return true
      }
      const body = await readJson(request)
      const profile = typeof body.token === 'string' ? store.profiles.find((entry) => entry.token === body.token) : undefined
      if (!profile) {
        send(response, 409, { error: 'Your name is not registered on this server.', code: 'profile' })
        return true
      }
      send(response, 200, personalStats(store.leaderboardRuns, profile.username))
      return true
    }

    if (request.method === 'POST' && url.pathname === '/api/profile/ascension') {
      if (!consume(statsRates, `ascension:${sourceOf(request)}`, createWindowMs, MAX_STATS_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many requests. Please try again shortly.' })
        return true
      }
      const body = await readJson(request)
      const profile = typeof body.token === 'string' ? store.profiles.find((entry) => entry.token === body.token) : undefined
      if (!profile) {
        send(response, 409, { error: 'Your name is not registered on this server.', code: 'profile' })
        return true
      }
      const previous = profile.highestAscension
      const reply = syncAscension(profile, store.leaderboardRuns, body.highestAscension)
      if (previous !== reply.highestAscension) store.ascensionsDirty = true
      if (store.ascensionsDirty) {
        if (!attemptSave()) {
          queueSave()
          send(response, 503, { error: 'Could not save your Ascension. Please try again.' })
          return true
        }
        store.ascensionsDirty = false
      }
      send(response, 200, reply)
      return true
    }

    if (request.method === 'POST' && url.pathname === '/api/profile/wallet') {
      if (!consume(statsRates, `wallet:${sourceOf(request)}`, createWindowMs, MAX_STATS_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many requests. Please try again shortly.' })
        return true
      }
      const body = await readJson(request)
      const profile = typeof body.token === 'string' ? store.profiles.find((entry) => entry.token === body.token) : undefined
      if (!profile) {
        send(response, 200, { registered: false })
        return true
      }
      const reply = syncAccountWallet(store, profile, body)
      if (store.walletsDirty) {
        if (!attemptSave()) {
          queueSave()
          send(response, 503, { error: 'Could not save your wallet. Please try again.' })
          return true
        }
        store.walletsDirty = false
      }
      send(response, 200, reply)
      return true
    }

    if (request.method === 'POST' && (url.pathname === '/api/profile/coins' || url.pathname === '/api/profile/coins/confirm')) {
      if (!consume(statsRates, `coins:${sourceOf(request)}`, createWindowMs, MAX_STATS_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many requests. Please try again shortly.' })
        return true
      }
      const body = await readJson(request)
      const profile = typeof body.token === 'string' ? store.profiles.find((entry) => entry.token === body.token) : undefined
      // An unregistered or anonymous player simply has no grant: no error for a first visit to log.
      if (!profile) {
        send(response, 200, url.pathname === '/api/profile/coins' ? { coins: 0 } : { claimed: false })
        return true
      }
      const reply = url.pathname === '/api/profile/coins'
        ? claimCoinGrant(store, profile.username, body.claimId)
        : confirmCoinGrant(store, profile.username, body.claimId, body.grantId)
      if (store.coinGrantsChanged) {
        // The reservation or the spend must be on disk before the client acts on it.
        if (!attemptSave()) {
          queueSave()
          send(response, 503, { error: 'Could not save. Please try again.' })
          return true
        }
        store.coinGrantsChanged = false
      }
      send(response, 200, reply)
      return true
    }

    if (request.method === 'POST' && (url.pathname === '/api/mail' || url.pathname === '/api/mail/send')) {
      const sending = url.pathname === '/api/mail/send'
      if (!consume(sending ? mailSendRates : mailReadRates, sourceOf(request), sending ? MAIL_SEND_WINDOW_MS : createWindowMs,
        sending ? MAX_MAIL_SENDS_PER_SOURCE : MAX_MAIL_READS_PER_WINDOW)) {
        send(response, 429, { error: sending ? 'You have sent a lot of letters. Please wait a little.' : 'Too many mail requests' })
        return true
      }
      const body = await readJson(request)
      const profile = typeof body.token === 'string' ? store.profiles.find((entry) => entry.token === body.token) : undefined
      if (!sending) {
        // An unknown profile simply has no letters yet: a first visit reads an
        // empty mailbox rather than an error.
        if (!profile) {
          send(response, 200, { letters: [], unread: 0, admin: false })
          return true
        }
        const admin = delegatedMailOwners.has(ownerOf(profile.token))
        const readOptions = { markRead: body.markRead === true, readThroughAt: body.readThroughAt }
        let inbox = playerInbox(store.mail, profile, readOptions)
        if (!admin && inbox.letters.length === 0) {
          try {
            const { undo } = sendDeveloperReply(store.mail, profile.username, WELCOME_LETTER, store.profiles, { maxCharacters: maxMailCharacters })
            if (saveMail(undo)) inbox = playerInbox(store.mail, profile, readOptions)
          } catch {}
        }
        if (inbox.changed) {
          store.mailDirty = true
          queueSave()
        }
        send(response, 200, {
          letters: inbox.letters,
          unread: admin ? developerUnread(store.mail, profile.username) : inbox.unread,
          personalUnread: inbox.unread,
          admin,
        })
        return true
      }
      if (!profile) {
        send(response, 409, { error: 'Your name is not registered on this server.', code: 'profile' })
        return true
      }
      if (delegatedMailOwners.has(ownerOf(profile.token))) {
        send(response, 403, { error: 'Server mailbox accounts only reply to player letters.' })
        return true
      }
      if (!consume(mailProfileRates, profile.username, MAIL_SEND_WINDOW_MS, MAX_MAIL_SENDS_PER_WINDOW)) {
        send(response, 429, { error: 'You have sent a lot of letters. Please wait a little.' })
        return true
      }
      // A letter that is refused or cannot be saved does not count against the allowance.
      const refund = () => { const rate = mailProfileRates.get(profile.username); if (rate) rate.count -= 1 }
      let sent
      try { sent = sendPlayerLetter(store.mail, profile, body.body, { maxCharacters: maxMailCharacters }) } catch (error) {
        refund()
        throw error
      }
      if (!saveMail(sent.undo)) {
        refund()
        send(response, 503, { error: 'Could not send your letter. Please try again.' })
        return true
      }
      send(response, 201, { letters: sent.letters, unread: sent.unread })
      return true
    }

    if (request.method === 'POST' && (url.pathname === '/api/mail/desk' || url.pathname === '/api/mail/desk/reply')) {
      const source = sourceOf(request)
      if (!consume(url.pathname.endsWith('/reply') ? mailSendRates : mailReadRates, source,
        url.pathname.endsWith('/reply') ? MAIL_SEND_WINDOW_MS : createWindowMs,
        url.pathname.endsWith('/reply') ? MAX_MAIL_SENDS_PER_SOURCE : MAX_MAIL_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many mail requests' })
        return true
      }
      const body = await readJson(request)
      const profile = delegatedMailProfile(body.token)
      if (!profile) {
        send(response, 403, { error: 'This account cannot manage server mail.' })
        return true
      }
      if (url.pathname === '/api/mail/desk') {
        const inbox = developerInbox(store.mail, store.profiles, {
          username: typeof body.username === 'string' ? body.username : undefined,
          markRead: body.markRead === true,
          readThroughAt: body.readThroughAt,
          excludeUsername: profile.username,
        })
        if (inbox.changed) {
          store.mailDirty = true
          queueSave()
        }
        send(response, 200, { threads: inbox.threads, unread: inbox.unread })
        return true
      }
      const incoming = developerInbox(store.mail, store.profiles, { username: body.username, excludeUsername: profile.username }).threads[0]
      if (!incoming?.letters.some((letter) => letter.from === 'player')) {
        send(response, 404, { error: 'No player letter to answer.' })
        return true
      }
      if (!consume(mailAdminReplyRates, ownerOf(profile.token), MAIL_SEND_WINDOW_MS, MAX_MAIL_ADMIN_REPLIES_PER_WINDOW)) {
        send(response, 429, { error: 'You have sent a lot of replies. Please wait a little.' })
        return true
      }
      const { undo, ...reply } = sendDeveloperReply(store.mail, body.username, body.body, store.profiles, { maxCharacters: maxMailCharacters })
      if (!saveMail(undo)) {
        send(response, 503, { error: 'Could not save the reply. Please try again.' })
        return true
      }
      const updated = developerInbox(store.mail, store.profiles, { username: reply.username, excludeUsername: profile.username })
      send(response, 201, { ...reply, threads: updated.threads, unread: updated.unread })
      return true
    }

    if (url.pathname === '/api/mail/admin' || url.pathname === '/api/mail/admin/reply' || url.pathname === '/api/mail/admin/announce') {
      if (!mailAdminKey) {
        send(response, 404, { error: 'Not found' })
        return true
      }
      if (!mailAdminAuthorized(request)) {
        send(response, 401, { error: 'Unauthorized' })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/mail/admin') {
        const inbox = developerInbox(store.mail, store.profiles, {
          username: url.searchParams.get('username') ?? undefined, markRead: url.searchParams.get('markRead') === 'true',
        })
        if (inbox.changed) {
          store.mailDirty = true
          queueSave()
        }
        send(response, 200, { threads: inbox.threads })
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/mail/admin/reply') {
        const body = await readJson(request)
        const { undo, ...reply } = sendDeveloperReply(store.mail, body.username, body.body, store.profiles, { maxCharacters: maxMailCharacters })
        if (!saveMail(undo)) {
          send(response, 503, { error: 'Could not save the reply. Please try again.' })
          return true
        }
        send(response, 201, reply)
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/mail/admin/announce') {
        // One letter to every registered player except the delegated mailbox accounts.
        const body = await readJson(request)
        // A flag that is not a real boolean must not turn a rehearsal into a live send to everyone.
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
          send(response, 400, { error: 'dryRun must be true or false.' })
          return true
        }
        const dryRun = body.dryRun === true
        const { undo, ...announced } = announceToPlayers(store.mail, store.profiles, body.body, {
          excludeOwners: delegatedMailOwners, dryRun, maxCharacters: maxMailCharacters,
        })
        if (announced.sent > 0 && !saveMail(undo)) {
          send(response, 503, { error: 'Could not save the announcement. Please try again.' })
          return true
        }
        send(response, dryRun ? 200 : 201, announced)
        return true
      }
      send(response, 405, { error: 'Method not allowed' })
      return true
    }

    if (request.method === 'GET' && url.pathname === '/api/leaderboard/decks') {
      if (!consume(deckReadRates, sourceOf(request), createWindowMs, MAX_DECK_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many deck requests' })
        return true
      }
      if ([...url.searchParams.keys()].some((name) => !DECK_QUERY_KEYS.has(name) ||
          name !== 'character' && url.searchParams.getAll(name).length > 1)) {
        send(response, 400, { error: 'Invalid winning deck query' })
        return true
      }
      if (deckPagesRevision !== store.leaderboardRevision) {
        deckPages.clear()
        deckPagesRevision = store.leaderboardRevision
      }
      const key = JSON.stringify([url.searchParams.get('sort') ?? 'recordedAt', url.searchParams.get('direction') ?? 'desc',
        url.searchParams.getAll('character').sort(), url.searchParams.get('ascension') ?? 'all', url.searchParams.get('cursor')])
      let page = deckPages.get(key)
      if (!page) {
        page = winningDecksPage(store.leaderboardRuns, url.searchParams)
        if (deckPages.size >= DECK_PAGE_CACHE_LIMIT) deckPages.clear()
        deckPages.set(key, page)
      }
      send(response, 200, page)
      return true
    }

    if (request.method === 'GET' && url.pathname === '/api/stats') {
      if (!consume(statsRates, sourceOf(request), createWindowMs, MAX_STATS_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many stats requests' })
        return true
      }
      send(response, 200, statsSnapshot(store.statsRuns, url.searchParams))
      return true
    }

    if (request.method === 'GET' && url.pathname === '/api/stats/deck') {
      if (!consume(statsRates, sourceOf(request), createWindowMs, MAX_STATS_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many stats requests' })
        return true
      }
      send(response, 200, randomDeck(store.statsRuns, url.searchParams))
      return true
    }

    if (request.method === 'GET' && url.pathname === '/api/leaderboard/daily') {
      if (!consume(dailyReadRates, sourceOf(request), createWindowMs, MAX_DECK_READS_PER_WINDOW)) {
        send(response, 429, { error: 'Too many daily ranking requests' })
        return true
      }
      if ([...url.searchParams.keys()].some((name) => name !== 'date' && name !== 'character') ||
          url.searchParams.getAll('date').length !== 1) {
        send(response, 400, { error: 'Invalid daily ranking query' })
        return true
      }
      const date = url.searchParams.get('date')
      const characters = [...new Set(url.searchParams.getAll('character'))].sort()
      const key = JSON.stringify([date, characters])
      if (dailyBoardsRevision !== store.leaderboardRevision) {
        dailyBoards.clear()
        dailyBoardsRevision = store.leaderboardRevision
      }
      let board = dailyBoards.get(key)
      if (!board) {
        board = dailyLeaderboard(store.leaderboardRuns, date, characters)
        if (dailyBoards.size >= DECK_PAGE_CACHE_LIMIT) dailyBoards.clear()
        dailyBoards.set(key, board)
      }
      send(response, 200, board)
      return true
    }

    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      if (leaderboardSummaryRevision !== store.leaderboardRevision) {
        leaderboardSummary = leaderboardSnapshot(store.leaderboardRuns)
        leaderboardSummaryRevision = store.leaderboardRevision
      }
      send(response, 200, leaderboardSummary)
      return true
    }

    if (request.method === 'POST' && url.pathname === '/api/leaderboard') {
      const source = sourceOf(request)
      if (!consume(leaderboardRates, source, createWindowMs, MAX_LEADERBOARD_WRITES_PER_WINDOW)) {
        send(response, 429, { error: 'Too many leaderboard submissions' })
        return true
      }
      const body = await readJson(request)
      if (typeof body.id === 'string' && body.id.startsWith('room:')) {
        send(response, 400, { error: 'Run id is reserved for room results' })
        return true
      }
      const profile = store.profiles.find((entry) => entry.token === body.profileToken)
      if (body.profileToken && !profile) {
        send(response, 409, { error: 'Profile unavailable' })
        return true
      }
      const { winningDecks: _, ...submission } = body
      const added = addLeaderboardRun(store, { ...submission, username: profile?.username })
      const recorded = store.leaderboardRuns.find((run) => run.id === body.id)
      if (recorded?.dailyDate !== undefined) {
        creditRecordedDailyCoins(store, recorded, profile)
        if (store.walletsDirty) {
          if (!attemptSave()) {
            queueSave()
            send(response, 503, { error: 'Could not save your Daily Climb coins. Please try again.' })
            return true
          }
          store.walletsDirty = false
        }
      }
      if (added) { queueSave(); scheduleClassification() }
      send(response, added ? 201 : 200, { ok: true, added, floorsClearedAccepted: true, finalDeckAccepted: true, profileAccepted: true, dailyDateAccepted: true, dailyCoinsAccepted: true })
      return true
    }

    return false
  }

  return { handle, sweepRates }
}
