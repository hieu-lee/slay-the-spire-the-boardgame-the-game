import { MAX_BOSS_AWARDS, MAX_BOSS_AWARD_COINS } from '../../src/game/coins.ts'
import { normalizeCardPacks } from '../../src/game/packs.ts'
import { normalizeSkins } from '../../src/game/skins.ts'
import { buyPack, buySkin, createWallet, creditBossCoins, MAX_WALLET_COINS, MAX_RUN_KEY_LENGTH, parseWallet, spentCoins } from '../../src/wallet.ts'
import { grantFor, grantNameKey } from './coin-grants.mjs'

const invalid = () => { throw Object.assign(new Error('Invalid wallet request'), { status: 400 }) }

// Browser wallets predate account storage. Merge their lifetime earnings by
// maximum, not addition: two devices may hold the same past-runs grant. Packs and
// skins count as spent earnings, so migrating a purchase never restores its price.
export function syncAccountWallet(store, profile, body) {
  const migration = body.migration
  const credits = body.credits ?? []
  if (!Array.isArray(credits) || credits.length > 64) invalid()
  if (migration && (typeof migration.id !== 'string' || !/^[0-9a-f-]{36}$/.test(migration.id))) invalid()
  for (const credit of credits) {
    if (!credit || typeof credit.runKey !== 'string' || !/^(solo|online):/.test(credit.runKey) || credit.runKey.length > MAX_RUN_KEY_LENGTH ||
      !Array.isArray(credit.awards) || credit.awards.length > MAX_BOSS_AWARDS ||
      !Number.isInteger(credit.joinedAfter) || credit.joinedAfter < 0 || credit.joinedAfter > MAX_BOSS_AWARDS ||
      credit.awards.some((award) => !award || ![1, 2, 3, 4].includes(award.act) || !Number.isInteger(award.coins) ||
        award.coins < 0 || award.coins > MAX_BOSS_AWARD_COINS)) invalid()
  }
  if (!profile.wallet) {
    const grant = grantFor(store, profile.username)
    profile.wallet = { ...createWallet(), coins: grant.coins, credited: { [`legacy:${grantNameKey(profile.username)}`]: 1 } }
    profile.walletImports = []
    profile.walletPaid = {}
    // Old clients must not claim the grant again after it becomes account money.
    grant.claimedAt ??= Date.now()
    store.walletsDirty = true
  }
  profile.wallet = parseWallet(profile.wallet)
  if (migration && !profile.walletImports.includes(migration.id)) {
    if (profile.walletImports.length >= 256) invalid()
    const local = parseWallet(migration.wallet)
    const packs = normalizeCardPacks([...profile.wallet.packs, ...local.packs])
    const skins = normalizeSkins([...profile.wallet.skins, ...local.skins])
    const earned = Math.max(profile.wallet.coins + spentCoins(profile.wallet), local.coins + spentCoins(local))
    profile.wallet = { ...profile.wallet, packs, skins,
      coins: Math.min(MAX_WALLET_COINS, Math.max(0, earned - spentCoins({ ...profile.wallet, packs, skins }))) }
    for (const [key, count] of Object.entries(local.credited)) {
      profile.walletPaid[key] = Math.max(profile.walletPaid[key] ?? 0, count)
    }
    profile.walletImports.push(migration.id)
    store.walletsDirty = true
  }
  for (const credit of credits) {
    const seeded = { ...profile.wallet, credited: { ...profile.wallet.credited, [credit.runKey]: profile.walletPaid[credit.runKey] ?? 0 } }
    const result = creditBossCoins(seeded, credit.runKey, credit.awards, credit.joinedAfter)
    if (result.wallet !== seeded) {
      profile.wallet = result.wallet
      profile.walletPaid[credit.runKey] = credit.awards.length
      store.walletsDirty = true
    }
  }
  // One purchase per request: a pack or a skin.
  const buy = body.pack !== undefined ? buyPack : body.skin !== undefined ? buySkin : undefined
  let purchase
  if (buy) {
    purchase = buy(profile.wallet, body.pack ?? body.skin)
    if (purchase.ok) { profile.wallet = purchase.wallet; store.walletsDirty = true }
    // A retried purchase after a lost reply has already succeeded.
    else if (purchase.reason === 'owned') purchase = { ok: true }
  }
  return { wallet: profile.wallet, ...(purchase ? { purchase: purchase.ok ? { ok: true } : { ok: false, reason: purchase.reason } } : {}) }
}
