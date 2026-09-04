import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'artifacts/loot-browser')
mkdirSync(out, { recursive: true })
const vite = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not report a port')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const browserErrors = []
page.on('pageerror', (error) => browserErrors.push(String(error)))
page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })

try {
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Single Player', exact: true }).click()
  await page.getByRole('button', { name: 'Standard', exact: true }).click()
  await page.getByRole('button', { name: 'Ironclad', exact: true }).click()
  await page.getByRole('button', { name: 'Embark', exact: true }).click()
  await page.getByRole('heading', { name: 'Neow’s Blessing' }).waitFor()

  const stage = async () => {
    await page.evaluate(() => {
      const debug = window.__STS_DEBUG__
      const run = structuredClone(debug.getRun())
      run.phase = 'reward'
      run.combat = null
      run.rewardDestination = 'map'
      run.players[0].potions = []
      run.rewards = [{
        playerId: run.players[0].id,
        cardReward: true,
        choices: null,
        upgraded: false,
        gold: 8,
        potion: 'weak_potion',
        relic: false,
        bossRelics: false,
      }]
      debug.setRun(run)
    })
    await page.waitForFunction(() => {
      const run = window.__STS_DEBUG__.getRun()
      return run.phase === 'reward' && run.rewards[0]?.cardReward && run.rewards[0].choices === null &&
        run.rewards[0].potion === 'weak_potion' && run.players[0].potions.length === 0
    })
  }
  const settle = async () => {
    await page.locator('.reward-screen--loot').waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(250)
  }

  await stage()
  await settle()
  const cardLoot = page.getByRole('button', { name: 'Add a card to your deck.' })
  assert(await cardLoot.isEnabled(), 'card loot is disabled by an unrelated item')
  const normalCardIcon = await cardLoot.locator('img').evaluate((image) => ({ src: image.src, width: image.naturalWidth }))
  assert(normalCardIcon.src.endsWith('/assets/icons/card-reward.png') && normalCardIcon.width === 512,
    `normal Card Reward icon is not the generated asset: ${JSON.stringify(normalCardIcon)}`)
  const goldIcon = await page.getByRole('button', { name: '8 Gold' }).locator('img').evaluate((image) => ({
    src: image.src, width: image.naturalWidth, height: image.naturalHeight,
  }))
  assert(goldIcon.src.endsWith('/assets/icons/gold.png') && goldIcon.width === 512 && goldIcon.height === 512,
    `loot did not render the generated single-Coin asset: ${JSON.stringify(goldIcon)}`)
  assert.equal(await page.getByRole('button', { name: /^Skip .*Potion$/ }).count(), 0,
    'an individual Potion skip is still rendered')
  const row = page.locator('.loot-choice').first()
  await row.hover()
  assert.equal(await row.evaluate((button) => getComputedStyle(button, '::after').opacity), '1',
    'hovering loot does not reveal its corner brackets')
  const desktop = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect()
    return { panel: box('.reward-screen__players'), row: box('.loot-choice'), skip: box('.reward-screen__skip') }
  })
  assert(desktop.panel.width <= 420 && desktop.panel.height >= 430, 'desktop loot sheet lost its compact tall silhouette')
  assert(desktop.row.height >= 52 && desktop.row.height <= 76, 'desktop loot row no longer matches the compact reference')
  assert(desktop.skip.left > desktop.panel.right && desktop.skip.bottom <= 900, 'global Skip is not outside the panel at bottom-right')
  await page.screenshot({ path: join(out, 'desktop-loot-hover.png') })

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.rewards[0].cardSource = 'rare'
    debug.setRun(run)
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.loot-choice img')]
    .some((image) => image.src.endsWith('/assets/icons/rare-card-reward.png')))
  assert.equal(await cardLoot.locator('img').evaluate((image) => image.naturalWidth), 512, 'rare Card Reward icon is not high resolution')

  const deckBefore = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].deck.length)
  await cardLoot.click()
  await page.getByRole('heading', { name: 'Choose a Card' }).waitFor()
  await page.keyboard.press('Shift+Tab')
  assert(await page.getByRole('button', { name: 'Skip', exact: true }).evaluate((button) => document.activeElement === button),
    'Shift+Tab escaped behind the initially focused Card Reward dialog')
  const card = page.locator('.reward-screen__cards .card').first()
  const resting = await card.boundingBox()
  await card.hover()
  await page.waitForTimeout(180)
  const hovered = await card.boundingBox()
  assert(resting && hovered && hovered.width > resting.width * 1.05, 'hovering a reward card does not enlarge it')
  await page.screenshot({ path: join(out, 'desktop-card-hover.png') })
  await card.click()
  await page.getByRole('heading', { name: 'Loot!' }).waitFor()
  const independent = await page.evaluate(() => {
    const run = window.__STS_DEBUG__.getRun()
    return { offer: run.rewards[0], deck: run.players[0].deck.length }
  })
  assert.equal(independent.offer.potion, 'weak_potion', 'choosing a card collected or skipped the Potion')
  assert.equal(independent.offer.cardReward, false, 'the chosen card reward did not disappear')
  assert.equal(independent.deck, deckBefore + 1, 'the chosen card was not added')

  await stage()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players[0].potions = ['liquid_memories', 'fairy_in_a_bottle', 'distilled_chaos']
    run.rewards[0].potion = 'distilled_chaos'
    debug.setRun(run)
  })
  await settle()
  const fullPotionRows = page.getByRole('button', { name: /^Distilled Chaos — replace / })
  assert.equal(await fullPotionRows.count(), 3, 'local loot did not render one replacement row per occupied Potion slot')
  const fullCardReward = page.getByRole('button', { name: 'Add a card to your deck.' })
  assert.equal(await fullCardReward.count(), 1, `a full Potion inventory hid the independent Card Reward: ${JSON.stringify(
    await page.evaluate(() => window.__STS_DEBUG__.getRun().rewards[0]))}`)
  assert(await fullCardReward.isEnabled(), 'a full Potion inventory disabled the independent Card Reward')
  await page.screenshot({ path: join(out, 'desktop-full-potion-loot.png') })
  await page.getByRole('button', { name: 'Distilled Chaos — replace Liquid Memories' }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().rewards[0].potion === false)
  assert.equal(await fullPotionRows.count(), 0, 'choosing a Potion replacement left sibling replacement rows visible')

  await stage()
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players[0].potions = ['liquid_memories', 'fairy_in_a_bottle']
    run.rewards[0].potion = 'distilled_chaos'
    debug.setRun(run)
  })
  await page.getByRole('button', { name: 'Distilled Chaos', exact: true }).waitFor()
  assert.equal(await fullPotionRows.count(), 0, 'freeing a Potion slot left replacement rows visible in local loot')

  await stage()
  await settle()
  const goldBefore = await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].gold)
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().phase === 'map')
  assert.equal(await page.evaluate(() => window.__STS_DEBUG__.getRun().players[0].gold), goldBefore,
    'global Skip collected unclaimed Gold')

  await stage()
  await page.setViewportSize({ width: 844, height: 390 })
  await settle()
  const phone = await page.evaluate(() => {
    const panel = document.querySelector('.reward-screen__players').getBoundingClientRect()
    const skip = document.querySelector('.reward-screen__skip').getBoundingClientRect()
    return { panel, skip, width: innerWidth, height: innerHeight }
  })
  assert(phone.panel.top >= 0 && phone.panel.bottom <= phone.height, 'loot sheet leaves the horizontal-phone viewport')
  assert(phone.skip.left >= 0 && phone.skip.right <= phone.width && phone.skip.bottom <= phone.height,
    'global Skip leaves the horizontal-phone viewport')
  await page.screenshot({ path: join(out, 'horizontal-phone-loot.png') })

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.players[0].potions = ['liquid_memories', 'fairy_in_a_bottle', 'distilled_chaos']
    run.rewards[0].potion = 'distilled_chaos'
    debug.setRun(run)
  })
  const phonePotionRows = page.getByRole('button', { name: /^Distilled Chaos — replace / })
  await phonePotionRows.first().waitFor()
  assert.equal(await phonePotionRows.count(), 3, 'horizontal-phone loot lost a Potion replacement row')
  const phoneCardReward = page.getByRole('button', { name: 'Add a card to your deck.' })
  assert(await phoneCardReward.isEnabled(), 'horizontal-phone full Potion inventory disabled the independent Card Reward')
  for (const choice of [...await phonePotionRows.all(), phoneCardReward]) {
    await choice.scrollIntoViewIfNeeded()
    const visible = await choice.evaluate((button) => {
      const row = button.getBoundingClientRect()
      const panel = button.closest('.reward-screen__players').getBoundingClientRect()
      return row.top >= panel.top && row.bottom <= panel.bottom
    })
    assert(visible, 'horizontal-phone loot choice cannot be reached inside the scrolling panel')
  }
  await page.screenshot({ path: join(out, 'horizontal-phone-full-potion-loot.png') })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.rewards[0] = {
      ...run.rewards[0], cardReward: true, cardSource: 'card', gold: false, potion: false, relic: false, bossRelics: false,
      choices: ['anger', 'cleave', 'bash', 'shrug_it_off', 'twin_strike'],
    }
    debug.setRun(run)
  })
  await page.getByRole('button', { name: 'Add a card to your deck.' }).click()
  const fiveCardReward = page.locator('.reward-screen--card-choice')
  await fiveCardReward.waitFor()
  assert.equal(await fiveCardReward.locator('.reward-screen__cards > .card').count(), 5,
    'a five-card reward did not use the shared Card Reward picker')
  await page.setViewportSize({ width: 1024, height: 768 })
  const compactCards = await fiveCardReward.locator('.reward-screen__cards > .card').evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect()).map((box) => ({ left: box.left, right: box.right })))
  assert(compactCards.every((box) => box.left >= 0 && box.right <= 1024),
    `five-card reward clips compact desktop: ${JSON.stringify(compactCards)}`)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reducedCard = fiveCardReward.locator('.reward-screen__cards > .card').first()
  await reducedCard.hover()
  assert.deepEqual(await reducedCard.evaluate((card) => ({
    transform: getComputedStyle(card).transform,
    duration: getComputedStyle(card).transitionDuration,
  })), { transform: 'none', duration: '0s' }, 'Card Reward hover ignores reduced motion')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.equal(await fiveCardReward.getByRole('button', { name: /Confirm/ }).count(), 0,
    'Card Reward picker added a second confirmation phase')
  if (await page.locator('.card-morph').count()) await page.locator('.card-morph').waitFor({ state: 'detached' })
  await page.mouse.move(10, 100)
  await page.waitForTimeout(180)
  await page.screenshot({ path: join(out, 'desktop-five-card-reward.png') })
  await fiveCardReward.getByRole('button', { name: 'Skip' }).click()

  await page.evaluate(() => window.__STS_DEBUG__.reset(2, 'orrery-remount'))
  await page.waitForFunction(() => window.__STS_DEBUG__.getRun().players.length === 2)
  const relicState = await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.phase = 'map'
    run.rewards = []
    run.rewardDestination = null
    run.players[0].cardRewards = [
      'anger', 'cleave', 'bash', 'shrug_it_off', 'twin_strike', 'armaments',
      'body_slam', 'clash', 'clothesline', 'combust', 'dark_embrace', 'flex',
    ]
    run.players[0].relics.push({ defId: 'orrery', spent: false, pending: true })
    debug.setRun(run)
    return { deck: run.players[0].deck.length, ownerId: run.players[0].id, teammateId: run.players[1].id }
  })
  const relicLoot = page.locator('.reward-screen--loot')
  await relicLoot.waitFor()
  await relicLoot.getByRole('button', { name: 'Add a card to your deck.' }).first().click()
  await page.locator('.reward-screen--card-choice .card').first().click()
  await relicLoot.waitFor()
  assert.equal(await relicLoot.getByRole('button', { name: 'Add a card to your deck.' }).count(), 3,
    'claiming one Orrery reward did not remove exactly one loot row')
  await page.evaluate((viewerId) => window.__STS_DEBUG__.setViewer(viewerId), relicState.teammateId)
  await page.getByRole('status').filter({ hasText: 'Waiting for' }).waitFor()
  await page.evaluate((viewerId) => window.__STS_DEBUG__.setViewer(viewerId), relicState.ownerId)
  await relicLoot.waitFor()
  assert.equal(await relicLoot.getByRole('button', { name: 'Add a card to your deck.' }).count(), 3,
    'remounting resurrected an already claimed Orrery reward')
  await relicLoot.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().players[0].relics.some((relic) => relic.pending))
  assert.equal(await page.evaluate((ownerId) => window.__STS_DEBUG__.getRun().players.find((player) => player.id === ownerId).deck.length, relicState.ownerId), relicState.deck + 1,
    'global Skip discarded an already claimed Orrery card')

  const restoredEnchiridion = await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    const owner = run.players[0]
    const chosen = owner.rareRewards[1]
    owner.relics.push({ defId: 'enchiridion', spent: false, pending: true, pendingRewardIndices: { 0: 1 } })
    debug.setRun(run)
    return { chosen, ownerId: owner.id }
  })
  await relicLoot.waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Choose a Card' }).count(), 0,
    'remounting reopened an already claimed Enchiridion reward')
  await relicLoot.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.waitForFunction(() => !window.__STS_DEBUG__.getRun().players[0].relics.some((relic) => relic.pending))
  assert(await page.evaluate(({ ownerId, chosen }) => window.__STS_DEBUG__.getRun().players
    .find((player) => player.id === ownerId).deck.some((card) => card.defId === chosen), restoredEnchiridion),
  'restored Enchiridion choice was not applied')

  await page.evaluate(() => {
    const debug = window.__STS_DEBUG__
    const run = structuredClone(debug.getRun())
    run.phase = 'room'
    run.neow = null
    run.combat = null
    run.players[0].gold = 12
    run.roomState = {
      kind: 'merchant', relics: ['anchor', 'happy_flower', 'akabeko'],
      potions: ['fire_potion', 'swift_potion', 'blood_potion'], colorless: [],
      cards: { [run.players[0].id]: { choices: run.players[0].cardRewards.slice(0, 3), cardsDrawn: [], raresDrawn: [] } },
      removalUsed: [], purchasedCards: {},
    }
    debug.setRun(run)
  })
  await page.getByRole('button', { name: 'Enter merchant shop' }).click()
  const merchantCoin = page.locator('.merchant-stage .room-price img').first()
  await merchantCoin.waitFor()
  const merchantIcon = await merchantCoin.evaluate((image) => ({ src: image.src, width: image.naturalWidth, height: image.naturalHeight }))
  assert(merchantIcon.src.endsWith('/assets/icons/gold.png') && merchantIcon.width === 512 && merchantIcon.height === 512,
    `merchant did not use the shared single-Coin asset: ${JSON.stringify(merchantIcon)}`)
  await page.screenshot({ path: join(out, 'desktop-merchant-single-coin.png') })

  await page.setContent('<main id="online-reward-test"></main>')
  await page.evaluate(async () => {
    const [React, ReactDomClient, { OnlineRewardScreen }, { RelicResolvePanel }, { OnlineCampfireScreen }, { NeowScreen }] = await Promise.all([
      import('/@id/react'), import('/@id/react-dom/client'), import('/src/ui/OnlineRewardScreen.tsx'),
      import('/src/ui/RelicResolvePanel.tsx'), import('/src/ui/OnlineCampfireScreen.tsx'), import('/src/ui/NeowScreen.tsx'),
    ])
    const createElement = React.createElement ?? React.default.createElement
    const StrictMode = React.StrictMode ?? React.default.StrictMode
    const createRoot = ReactDomClient.createRoot ?? ReactDomClient.default.createRoot
    const root = createRoot(document.querySelector('#online-reward-test'))
    const run = {
      act: 1, ascension: 0,
      players: [{ id: 'p1', name: 'Ironclad', relics: [], potions: [], deck: [] }],
      rewards: [{ playerId: 'p1', cardReward: true, choices: ['anger', 'cleave', 'bash'], upgraded: false,
        gold: false, potion: false, relic: false, bossRelics: false }],
    }
    window.__ONLINE_REWARD_ACTIONS__ = []
    const onAction = (action) => {
      window.__ONLINE_REWARD_ACTIONS__.push(action)
      return new Promise((resolve) => { window.__RESOLVE_ONLINE_REWARD__ = resolve })
    }
    window.__ACK_ONLINE_REWARD__ = () => root.render(createElement(OnlineRewardScreen, {
      run, viewerId: 'p1', decided: ['p1'], confirmed: [],
      onAction,
    }))
    window.__SHOW_UNREVEALED_REWARD__ = () => {
      window.__ONLINE_REWARD_ACTIONS__ = []
      root.render(createElement(OnlineRewardScreen, {
        key: 'unrevealed', run: { ...run, rewards: [{ ...run.rewards[0], choices: null }] },
        viewerId: 'p1', decided: [], confirmed: [], onAction,
      }))
    }
    window.__SHOW_RELIC_REWARD__ = () => {
      window.__ONLINE_REWARD_ACTIONS__ = []
      root.render(createElement(RelicResolvePanel, {
        key: 'relic-reward', pending: { relicId: 'orrery', rewardChoices: [['anger', 'cleave', 'bash']] }, deck: [],
        onRewardChoice: (reward, choice) => {
          window.__ONLINE_REWARD_ACTIONS__.push({ kind: 'relicReward', reward, choice })
          return new Promise((resolve) => { window.__RESOLVE_RELIC_REWARD__ = resolve })
        }, onResolve: () => {},
      }))
    }
    window.__SHOW_RELIC_SKIP__ = () => {
      window.__ONLINE_REWARD_ACTIONS__ = []
      root.render(createElement(RelicResolvePanel, {
        key: 'relic-skip', pending: { relicId: 'orrery', rewardChoices: [['anger', 'cleave', 'bash']], rewardIndices: { 0: -1 } }, deck: [],
        onRewardChoice: () => {}, onResolve: (cardUids, rewardIndices) => onAction({ kind: 'resolveRelic', cardUids, rewardIndices }),
      }))
    }
    window.__SHOW_MULTI_LOOT__ = ({ full = true, potion = true } = {}) => {
      window.__ONLINE_REWARD_ACTIONS__ = []
      root.render(createElement(OnlineRewardScreen, {
        key: `multi-loot-${full}-${potion}`, run: { ...run,
          players: [{ ...run.players[0], potions: full
            ? ['liquid_memories', 'fairy_in_a_bottle', 'distilled_chaos']
            : ['liquid_memories', 'fairy_in_a_bottle'] }],
          rewards: [{ ...run.rewards[0], cardReward: false, choices: null, gold: 8, potion: potion ? 'distilled_chaos' : false }] },
        viewerId: 'p1', decided: [], confirmed: [], onAction,
      }))
    }
    window.__SHOW_CONFIRM_REWARD__ = () => {
      window.__ONLINE_REWARD_ACTIONS__ = []
      root.render(createElement(StrictMode, null, createElement(OnlineRewardScreen, {
        key: 'confirm-reward', run: { ...run,
          players: [...run.players, { id: 'p2', name: 'Silent', relics: [], potions: [], deck: [] }],
          rewards: [...run.rewards, { ...run.rewards[0], playerId: 'p2' }] },
        viewerId: 'p1', decided: ['p1'], confirmed: [], onAction,
      })))
    }
    window.__SHOW_ONLINE_CAMPFIRE__ = () => {
      window.__ONLINE_REWARD_ACTIONS__ = []
      root.render(createElement(OnlineCampfireScreen, {
        key: 'campfire', player: { id: 'p1', name: 'Ironclad', hp: 10, maxHp: 10, deck: [], relics: [] },
        decided: [], seats: [{ playerId: 'p1', name: 'Ironclad', character: 'ironclad', connected: true }], onAction,
      }))
    }
    window.__SHOW_NEOW_REWARD__ = () => {
      window.__ONLINE_REWARD_ACTIONS__ = []
      const player = { id: 'p1', name: 'Ironclad', character: 'ironclad', hp: 10, maxHp: 10, gold: 0, potions: [], relics: [], deck: [] }
      root.render(createElement(NeowScreen, {
        key: 'neow', players: [player], viewerId: 'p1', ascension: 0,
        progress: { p1: { redGoldPending: false, redRewardPending: true,
          redReward: { kind: 'card', choices: ['anger', 'cleave', 'bash'], cardsDrawn: [], raresDrawn: [] },
          blueOption: null, pendingEffect: null, rewardKind: null, reward: null, done: false } },
        onGold: () => {}, onReveal: () => {}, onEffect: () => {}, onChoose: () => {},
        onReward: (_playerId, choice) => onAction({ kind: 'neowReward', choice }),
      }))
    }
    root.render(createElement(OnlineRewardScreen, {
      run, viewerId: 'p1', decided: [], confirmed: [],
      onAction,
    }))
  })
  await page.getByRole('button', { name: 'Add a card to your deck.' }).click()
  await page.evaluate(() => {
    const card = document.querySelector('.reward-screen--card-choice .card')
    card.click()
    card.click()
  })
  await page.getByRole('status').filter({ hasText: 'Claiming card…' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Skip', exact: true }).count(), 0,
    'global Skip can overwrite a card choice before the server acknowledges it')
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [{ kind: 'cardReward', choice: 0 }])
  await page.evaluate(() => window.__RESOLVE_ONLINE_REWARD__({ status: 'refused' }))
  await page.locator('.reward-screen--card-choice .card').first().waitFor()
  await page.locator('.reward-screen--card-choice .card').first().click()
  await page.getByRole('status').filter({ hasText: 'Claiming card…' }).waitFor()
  await page.evaluate(() => {
    window.__ACK_ONLINE_REWARD__()
    window.__RESOLVE_ONLINE_REWARD__({ status: 'accepted', snapshot: { rewardDecided: ['p1'], run: null } })
  })
  await page.getByRole('status').filter({ hasText: 'Waiting for teammates…' }).waitFor()
  await page.evaluate(() => window.__SHOW_UNREVEALED_REWARD__())
  await page.evaluate(() => {
    const reward = document.querySelector('.loot-choice')
    reward.click()
    reward.click()
  })
  await page.getByRole('status').filter({ hasText: 'Revealing cards…' }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [{ kind: 'cardReward', choice: 'reveal' }],
    'double-clicking card reveal dispatched it more than once')
  await page.evaluate(() => window.__RESOLVE_ONLINE_REWARD__({ status: 'refused' }))
  await page.getByRole('heading', { name: 'Loot!' }).waitFor()
  await page.getByRole('button', { name: 'Add a card to your deck.' }).waitFor()
  await page.evaluate(() => window.__SHOW_RELIC_REWARD__())
  await page.getByRole('button', { name: 'Add a card to your deck.' }).click()
  await page.evaluate(() => {
    const card = document.querySelector('.reward-screen--card-choice .card')
    card.click()
    card.click()
  })
  await page.getByRole('status').filter({ hasText: 'Claiming card…' }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [
    { kind: 'relicReward', reward: 0, choice: 0 },
  ], 'double-clicking a Relic card reward dispatched it more than once')
  await page.evaluate(() => window.__RESOLVE_RELIC_REWARD__({ status: 'refused' }))
  await page.locator('.reward-screen--card-choice .card').first().waitFor()

  await page.evaluate(() => window.__SHOW_RELIC_SKIP__())
  await page.evaluate(() => {
    const skip = document.querySelector('.reward-screen__skip')
    skip.click()
    skip.click()
  })
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [
    { kind: 'resolveRelic', cardUids: [], rewardIndices: [-1] },
  ], 'double-clicking Relic resolution dispatched it more than once')

  await page.evaluate(() => window.__SHOW_MULTI_LOOT__())
  const replacementRows = page.getByRole('button', { name: /^Distilled Chaos — replace / })
  assert.equal(await replacementRows.count(), 3, 'a full Potion inventory did not render one loot row per occupied slot')
  for (const name of ['Liquid Memories', 'Fairy in a Bottle', 'Distilled Chaos']) {
    assert(await page.getByRole('button', { name: `Distilled Chaos — replace ${name}` }).isVisible(),
      `Potion replacement row for ${name} is not mouse-accessible`)
  }
  await page.getByRole('button', { name: 'Distilled Chaos — replace Liquid Memories' }).click()
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [
    { kind: 'potionReward', choice: 'replace', potionId: 'liquid_memories' },
  ], 'Potion replacement did not resolve the offered Potion against the selected slot')
  await page.evaluate(() => window.__SHOW_MULTI_LOOT__({ potion: false }))
  await page.waitForFunction(() => ![...document.querySelectorAll('.loot-choice strong')]
    .some((label) => label.textContent.includes('replace')))
  assert.equal(await replacementRows.count(), 0, 'Potion replacement rows remained after the offer resolved')

  await page.evaluate(() => window.__SHOW_MULTI_LOOT__({ full: false }))
  await page.getByRole('button', { name: 'Distilled Chaos', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Distilled Chaos', exact: true }).count(), 1,
    'freeing a Potion slot did not collapse replacement rows into one normal gain row')
  assert.equal(await replacementRows.count(), 0, 'replacement rows remained after a Potion slot became free')

  await page.evaluate(() => window.__SHOW_MULTI_LOOT__())
  const lootSkip = page.getByRole('button', { name: 'Skip', exact: true })
  await lootSkip.waitFor()
  await page.evaluate(() => {
    const skip = document.querySelector('.reward-screen__skip')
    skip.click()
    skip.click()
  })
  assert.equal((await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__)).length, 2,
    'double-clicking global Skip dispatched the two loot actions more than once')

  await page.evaluate(() => window.__SHOW_CONFIRM_REWARD__())
  await page.waitForFunction(() => window.__ONLINE_REWARD_ACTIONS__.length > 0)
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [{ kind: 'cardReward', choice: 'confirm' }],
    'Strict Mode dispatched the automatic card confirmation more than once')
  await page.getByRole('status').filter({ hasText: 'Waiting for teammates…' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Skip', exact: true }).count(), 0,
    'a player with no remaining loot received an inert Skip button')

  await page.evaluate(() => window.__SHOW_ONLINE_CAMPFIRE__())
  const rest = page.getByRole('button', { name: /Rest/ })
  await rest.waitFor()
  await page.evaluate(() => {
    const restButton = document.querySelector('.campfire__choices button')
    restButton.click()
    restButton.click()
  })
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [
    { kind: 'campfire', choices: { p1: { choice: 'rest' } } },
  ], 'double-clicking a campfire choice dispatched it more than once')

  await page.evaluate(() => window.__SHOW_NEOW_REWARD__())
  await page.locator('.neow-action--offer .card').first().waitFor()
  await page.evaluate(() => {
    const card = document.querySelector('.neow-action--offer .card')
    card.click()
    card.click()
  })
  assert.deepEqual(await page.evaluate(() => window.__ONLINE_REWARD_ACTIONS__), [
    { kind: 'neowReward', choice: 0 },
  ], 'double-clicking a Neow card reward dispatched it more than once')

  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join('\n')}`)
  console.log('✓ loot browser: flow, desktop, and horizontal phone passed')
} finally {
  await browser.close()
  await vite.close()
}
