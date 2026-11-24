import { lazy, Suspense, useEffect, useState } from 'react'
import { CAMPAIGN_EVENT, campaignKey, syncAccountAscension } from '../campaign-storage.ts'
import { preloadImages, releasePreloadedImages } from '../game/assets.ts'
import { hasRoomSession, validRoomSessions } from '../multiplayer/useRoomSession.ts'
import { onProfileChange, PROFILE_KEY, savedProfile } from '../profile.ts'
import { ACCOUNT_WALLETS, syncAccountWallet } from '../wallet-storage.ts'
import { LocalGame } from './app/LocalGame.tsx'
import { useGameSettings } from './game-settings.ts'
import { installSoundEffects } from './sfx.ts'
import { SkinProvider } from './skin-context.tsx'
import { useWebMcp } from './useWebMcp.ts'

const SINGLE_PLAYER_ONLY = import.meta.env.VITE_SINGLE_PLAYER === 'true'
const OnlineGame = SINGLE_PLAYER_ONLY ? null : lazy(() => import('./OnlineGame.tsx').then((module) => ({ default: module.OnlineGame })))
const COMBAT_VFX = [
  'combat/vfx/hit-burst.webp', 'combat/vfx/death-ash.webp', 'combat/vfx/death-ring.webp',
  ...[
    'awakened-blue-fire', 'awakened-claw-scratch', 'watcher-calm-aura', 'watcher-wrath-aura',
    'guard-bloom', 'hexaghost-flame-impact', 'hexaghost-flame', 'dark-channel', 'defect-face-orb',
    'frost-channel', 'ironclad-bash', 'ironclad-strike', 'lightning-channel', 'turn-lightning-strike',
    'magic-burst', 'potion-burst', 'silent-knife', 'silent-poison', 'silent-shiv', 'watcher-pray',
    'watcher-meteor-impact', 'watcher-meteor', 'defect-lightning-beam', 'defect-dark-beam', 'speed-trail',
  ].map((name) => `combat/vfx/actions/${name}.webp`),
]

export function App() {
  useWebMcp()
  const [account, setAccount] = useState(() => savedProfile()?.token)
  // Refresh account coins and Ascension on visits, account changes and reconnects.
  useEffect(() => {
    let active = true
    const settle = () => {
      if (active && document.visibilityState !== 'hidden') {
        void syncAccountWallet().catch(() => {})
        void syncAccountAscension().catch(() => {})
      }
    }
    if (!ACCOUNT_WALLETS) return () => { active = false }
    settle()
    const changedAccount = () => {
      const next = savedProfile()?.token
      if (next !== account) setAccount(next)
      settle()
    }
    const stop = onProfileChange(changedAccount)
    const storage = (event: StorageEvent) => { if (event.key === PROFILE_KEY || event.key === null) changedAccount(); else if (event.key === campaignKey()) settle() }
    const timer = window.setInterval(settle, 15_000)
    window.addEventListener(CAMPAIGN_EVENT, settle)
    window.addEventListener('focus', settle)
    window.addEventListener('online', settle)
    window.addEventListener('storage', storage)
    document.addEventListener('visibilitychange', settle)
    return () => {
      active = false; stop(); window.clearInterval(timer)
      window.removeEventListener(CAMPAIGN_EVENT, settle)
      window.removeEventListener('focus', settle)
      window.removeEventListener('online', settle)
      window.removeEventListener('storage', storage)
      document.removeEventListener('visibilitychange', settle)
    }
  }, [account])
  const [seedText, setSeedText] = useState<string>(() => crypto.randomUUID())
  const [online, setOnline] = useState<boolean | null>(() => !SINGLE_PLAYER_ONLY && hasRoomSession() ? null : false)
  useEffect(() => {
    if (SINGLE_PLAYER_ONLY || online !== null) return
    let active = true
    void validRoomSessions().then((valid) => {
      if (active) setOnline(valid.length > 0)
    }, () => { if (active) setOnline(false) })
    return () => { active = false }
  }, [online])
  const [settings, setSettings] = useGameSettings()
  useEffect(() => settings.sfxVolume > 0 ? installSoundEffects(true) : undefined, [settings.sfxVolume])
  useEffect(() => {
    if (document.querySelector('link[data-combat-vfx]')) return
    void preloadImages(COMBAT_VFX, { fetchPriority: 'low' })
    return () => releasePreloadedImages(COMBAT_VFX)
  }, [])
  useEffect(() => {
    let shiftHeld = false
    let preferFocus = false
    let pointerActive = false
    let active: HTMLElement | null = null
    let pinned: HTMLElement | null = null
    let dismissed: HTMLElement | null = null
    let repositionFrame = 0
    let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined
    const cardOf = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>('[data-keyword-help-id]') : null
    const tooltipOf = (card: HTMLElement) => document.getElementById(card.dataset.keywordHelpId ?? '')
    const cardForTooltip = (target: EventTarget | null) => {
      const tooltip = target instanceof Element ? target.closest<HTMLElement>('.card-keyword-tips') : null
      return tooltip?.id
        ? document.querySelector<HTMLElement>(`[data-keyword-help-id="${CSS.escape(tooltip.id)}"]`)
        : null
    }
    const place = (card: HTMLElement, tooltip: HTMLElement) => {
      tooltip.setAttribute('data-open', '')
      const cardBox = (card.querySelector('.enemy__hit-area') ?? card).getBoundingClientRect()
      const width = tooltip.offsetWidth
      const height = tooltip.offsetHeight
      const gap = 9
      const margin = 8
      const right = cardBox.right + gap
      const left = cardBox.left - width - gap
      const centered = cardBox.left + (cardBox.width - width) / 2
      const candidates: [number, number][] = window.innerWidth <= 700
        ? [[centered, cardBox.top - height - gap], [centered, cardBox.bottom + gap]]
        : [[right, cardBox.bottom - height], [left, cardBox.bottom - height],
            [right, cardBox.top - height - gap], [left, cardBox.top - height - gap],
            [centered, cardBox.top - height - gap], [centered, cardBox.bottom + gap]]
      for (const x of [margin, (window.innerWidth - width) / 2, window.innerWidth - width - margin]) {
        for (const y of [margin, (window.innerHeight - height) / 2, window.innerHeight - height - margin]) {
          candidates.push([x, y])
        }
      }
      const anchors = [...document.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [role="button"]',
      )]
        // Controls inside a closed <details> keep layout boxes that nobody can see.
        .filter((element) => !element.closest('details:not([open])') || element.closest('summary'))
        .map((element) => (element.querySelector('.enemy__hit-area') ?? element).getBoundingClientRect())
        .filter((box) => box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight)
      const powerZoom = document.querySelector<HTMLElement>('.power__zoom')?.getBoundingClientRect()
      const positioned = candidates.map(([candidateLeft, candidateTop]) => {
        const x = Math.max(margin, Math.min(candidateLeft, window.innerWidth - width - margin))
        const y = Math.max(margin, Math.min(candidateTop, window.innerHeight - height - margin))
        const overlap = anchors.reduce((total, box) => total +
          Math.max(0, Math.min(x + width, box.right) - Math.max(x, box.left)) *
          Math.max(0, Math.min(y + height, box.bottom) - Math.max(y, box.top)), 0)
        const powerOverlap = powerZoom
          ? Math.max(0, Math.min(x + width, powerZoom.right) - Math.max(x, powerZoom.left)) *
            Math.max(0, Math.min(y + height, powerZoom.bottom) - Math.max(y, powerZoom.top))
          : 0
        return { x, y, overlap, powerOverlap }
      }).sort((a, b) => Number(a.powerOverlap > 0) - Number(b.powerOverlap > 0) ||
        a.powerOverlap - b.powerOverlap || a.overlap - b.overlap)[0]!
      tooltip.style.left = `${positioned.x}px`
      tooltip.style.top = `${positioned.y}px`
      tooltip.toggleAttribute('data-overlaps-card', positioned.overlap > 0)
    }
    const hide = () => {
      if (active) tooltipOf(active)?.removeAttribute('data-open')
      active = null
    }
    const show = (card: HTMLElement | null) => {
      if ((!shiftHeld && !card?.hasAttribute('data-help-on-hover')) || pointerActive) return hide()
      if (!card) {
        dismissed = null
        return hide()
      }
      if (card === dismissed) return hide()
      dismissed = null
      if (active !== card) hide()
      active = card
      const tooltip = tooltipOf(card)
      if (!tooltip) {
        (card as HTMLElement & { mountKeywordHelp?: () => void }).mountKeywordHelp?.()
        return
      }
      place(card, tooltip)
      if (pinned === card) tooltip.setAttribute('data-pinned', '')
    }
    const current = () => {
      const focus = document.querySelector<HTMLElement>(':focus-visible[data-keyword-help-id]')
      const hover = document.querySelector<HTMLElement>(':hover[data-keyword-help-id]')
        ?? cardForTooltip(document.querySelector('.card-keyword-tips[data-open]:hover'))
      return preferFocus ? focus ?? hover : hover ?? focus
    }
    const unpin = () => {
      if (pinned) tooltipOf(pinned)?.removeAttribute('data-pinned')
      pinned?.removeAttribute('data-keyword-help')
      pinned = null
    }
    const pin = (target: EventTarget | null) => {
      const card = cardOf(target)
      if (!card) return
      if (card === pinned) return show(card)
      unpin()
      pinned = card
      pinned.setAttribute('data-keyword-help', '')
      show(card)
      tooltipOf(card)?.setAttribute('data-pinned', '')
    }
    const keydown = (event: KeyboardEvent) => {
      if (active && (!active.isConnected || !tooltipOf(active)?.hasAttribute('data-open'))) active = null
      if (event.key === 'Escape' && active) {
        dismissed = active
        hide()
        event.preventDefault()
        return
      }
      dismissed = null
      preferFocus = true
      if (event.key !== 'Shift') {
        if (!shiftHeld || !pinned) return
        if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
        const tooltip = tooltipOf(pinned)
        if (!tooltip) return
        const amount = event.key === 'ArrowDown' ? 40 : event.key === 'ArrowUp' ? -40
          : event.key === 'PageDown' ? tooltip.clientHeight * 0.8
            : event.key === 'PageUp' ? tooltip.clientHeight * -0.8 : null
        if (amount !== null) tooltip.scrollBy({ top: amount })
        else if (event.key === 'Home') tooltip.scrollTop = 0
        else if (event.key === 'End') tooltip.scrollTop = tooltip.scrollHeight
        else return
        event.preventDefault()
        return
      }
      shiftHeld = true
      pin(current())
    }
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') return
      shiftHeld = false
      unpin()
      show(current())
    }
    const pointerover = (event: PointerEvent) => {
      const card = cardOf(event.target)
      if (card || cardForTooltip(event.target)) clearTimeout(hoverCloseTimer)
      if (event.pointerType !== 'touch' && card !== dismissed && cardForTooltip(event.target) !== dismissed) dismissed = null
      preferFocus = false
      if (!card || (card === active && tooltipOf(card)?.hasAttribute('data-open'))) return
      if (shiftHeld) pin(card)
      else show(card)
    }
    const pointerdown = (event: PointerEvent) => {
      if (!cardOf(event.target)) {
        if (active?.hasAttribute('data-help-on-hover') && !cardForTooltip(event.target)) hide()
        return
      }
      pointerActive = true
      hide()
    }
    const pointerend = (event: PointerEvent) => {
      if (!pointerActive) return
      pointerActive = false
      if (event.pointerType === 'touch') {
        const card = cardOf(event.target)
        if (card?.hasAttribute('data-help-on-hover')) {
          dismissed = null
          return show(card)
        }
        dismissed = card
        return hide()
      }
      queueMicrotask(() => show(pinned ?? current()))
    }
    const pointerout = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const card = cardOf(event.target) ?? cardForTooltip(event.target)
      if (!card || cardOf(event.relatedTarget) === card || cardForTooltip(event.relatedTarget) === card || pinned === card) return
      if (card.hasAttribute('data-help-on-hover')) {
        clearTimeout(hoverCloseTimer)
        hoverCloseTimer = setTimeout(() => show(current()), 200)
      } else queueMicrotask(() => show(current()))
    }
    const ready = (event: Event) => {
      const card = cardOf(event.target)
      if (card && (card === active || card === pinned || card === current())) show(card)
    }
    const focusin = (event: FocusEvent) => {
      const card = cardOf(event.target)
      if (!card) return
      if (shiftHeld) pin(card)
      else show(card)
    }
    const focusout = () => {
      queueMicrotask(() => pinned ? show(pinned) : show(current()))
    }
    const reset = () => {
      clearTimeout(hoverCloseTimer)
      shiftHeld = false
      preferFocus = false
      pointerActive = false
      dismissed = null
      unpin()
      hide()
    }
    const reposition = () => {
      if (!active || repositionFrame) return
      repositionFrame = requestAnimationFrame(() => {
        repositionFrame = 0
        if (active) show(active)
      })
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('keyup', keyup)
    document.addEventListener('pointerover', pointerover)
    document.addEventListener('pointerdown', pointerdown)
    document.addEventListener('pointerup', pointerend)
    document.addEventListener('pointercancel', pointerend)
    document.addEventListener('pointerout', pointerout)
    document.addEventListener('card-keyword-help-ready', ready)
    document.addEventListener('card-keyword-help-reposition', reposition)
    document.addEventListener('focusin', focusin)
    document.addEventListener('focusout', focusout)
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('blur', reset)
    return () => {
      cancelAnimationFrame(repositionFrame)
      reset()
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('keyup', keyup)
      document.removeEventListener('pointerover', pointerover)
      document.removeEventListener('pointerdown', pointerdown)
      document.removeEventListener('pointerup', pointerend)
      document.removeEventListener('pointercancel', pointerend)
      document.removeEventListener('pointerout', pointerout)
      document.removeEventListener('card-keyword-help-ready', ready)
      document.removeEventListener('card-keyword-help-reposition', reposition)
      document.removeEventListener('focusin', focusin)
      document.removeEventListener('focusout', focusout)
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return (
    <SkinProvider>
    <Suspense fallback={<main className="app-loading" role="status">Loading…</main>}>
      {online === null ? <main className="app-loading" role="status">Loading…</main> : <>
      <div className="game-mode" hidden={online}>
        <LocalGame key={account} onOnline={SINGLE_PLAYER_ONLY ? undefined : () => setOnline(true)}
          settings={settings} onSettings={setSettings} active={!online}
          seedText={seedText} setSeedText={setSeedText} />
      </div>
      {online && OnlineGame ? <OnlineGame onLocal={() => setOnline(false)} settings={settings} onSettings={setSettings} /> : null}
      </>}
    </Suspense>
    </SkinProvider>
  )
}
