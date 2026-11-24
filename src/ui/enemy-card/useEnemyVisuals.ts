import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Enemy } from '../../game/types.ts'
import { splitAttackAnimationPending } from '../combat-screen/vfx.tsx'

export function useEnemyVisuals({
  cardRef,
  enemy,
  acting,
  splitAttackEvents,
  visualContactMs,
  visualEventSeq,
  visualResetKey,
  stageVisualDamage,
  onReset,
}: {
  cardRef: RefObject<HTMLButtonElement | null>
  enemy: Enemy
  acting: boolean
  splitAttackEvents: { seq: number; damage?: number; weights: readonly number[] }[]
  visualContactMs: number
  visualEventSeq: number
  visualResetKey: string
  stageVisualDamage: boolean
  onReset: () => void
}) {
  const [visibleEnemy, setVisibleEnemy] = useState(enemy)
  const displayTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const pendingVisuals = useRef(new Map<number, {
    eventSeq: number; enemy: Enemy; damage: number; recovery: number; impactEvents: { seq: number; weights: readonly number[] }[]; impacts: Set<string>
  }>())
  const splitHpActive = useRef(false)
  const latestEnemy = useRef(enemy)
  latestEnemy.current = enemy
  const onResetRef = useRef(onReset)
  onResetRef.current = onReset
  const numberTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const nextNumber = useRef(0)
  const [bulletNumbers, setBulletNumbers] = useState<{ id: number; damage: number; x: number; y: number }[]>([])
  const displayBeat = useRef(0)
  const displayedEventSeq = useRef(visualEventSeq)
  const visualSignature = JSON.stringify(enemy)
  const priorActual = useRef({
    signature: visualSignature, eventSeq: visualEventSeq, resetKey: visualResetKey, hp: enemy.hp,
  })
  const resetVisuals = !stageVisualDamage || visualResetKey !== priorActual.current.resetKey

  // HP is the authoritative endpoint plus damage whose visual impacts are still pending.
  // Additive debt keeps overlapping attacks from restoring an older HP snapshot.
  const publishVisual = (snapshot?: Enemy, eventSeq = -1) => {
    const applySnapshot = snapshot && eventSeq >= displayedEventSeq.current
    if (applySnapshot) displayedEventSeq.current = eventSeq
    if (!splitHpActive.current) {
      if (applySnapshot) setVisibleEnemy(snapshot)
      return
    }
    const hp = Math.round(Math.max(0, Math.min(latestEnemy.current.maxHp,
      latestEnemy.current.hp + [...pendingVisuals.current.values()]
        .reduce((total, pending) => total + pending.damage - pending.recovery, 0))) * 1e9) / 1e9
    setVisibleEnemy((previous) => ({
      ...(applySnapshot ? snapshot : previous),
      hp,
      dead: hp > 0 ? false : latestEnemy.current.dead,
    }))
    if (pendingVisuals.current.size === 0) splitHpActive.current = false
  }
  const showBulletNumber = (damage: number, x: number, y: number) => {
    if (damage <= 0) return
    const id = ++nextNumber.current
    setBulletNumbers((numbers) => [...numbers, { id, damage, x, y }])
    numberTimers.current.set(id, setTimeout(() => {
      numberTimers.current.delete(id)
      setBulletNumbers((numbers) => numbers.filter((number) => number.id !== id))
    }, 600))
  }
  const finishVisual = (beat: number) => {
    const pending = pendingVisuals.current.get(beat)
    if (!pending) return
    clearTimeout(displayTimers.current.get(beat))
    displayTimers.current.delete(beat)
    pendingVisuals.current.delete(beat)
    publishVisual(pending.enemy, pending.eventSeq)
  }

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const impact = (event: Event) => {
      const detail = (event as CustomEvent<{ seq: number; shot: string; index: number; x: number; y: number }>).detail
      const entry = [...pendingVisuals.current.entries()].find(([, pending]) => pending.impactEvents.some((impact) => impact.seq === detail.seq))
      if (!entry) return
      const [beat, pending] = entry
      const key = `${detail.seq}:${detail.index}`
      if (pending.impacts.has(key)) return
      const weights = pending.impactEvents.find((impact) => impact.seq === detail.seq)!.weights
      const weight = weights[detail.index]
      if (weight === undefined) return
      const remaining = pending.impactEvents.reduce((sum, impact) => sum + impact.weights.reduce((total, value, index) =>
        total + (pending.impacts.has(`${impact.seq}:${index}`) ? 0 : value), 0), 0)
      const damage = pending.damage * weight / Math.max(weight, remaining)
      pending.impacts.add(key)
      pending.damage = Math.max(0, pending.damage - damage)
      showBulletNumber(damage, detail.x, detail.y)
      if (remaining - weight < 1e-9) finishVisual(beat)
      else publishVisual()
    }
    card.addEventListener('hermit-impact', impact)
    card.addEventListener('staged-impact', impact)
    return () => {
      card.removeEventListener('hermit-impact', impact)
      card.removeEventListener('staged-impact', impact)
    }
  }, [])

  useLayoutEffect(() => {
    const newSplitEvents = splitAttackEvents.filter((event) => event.seq > priorActual.current.eventSeq)
    const changed = visualSignature !== priorActual.current.signature ||
      newSplitEvents.some((event) => (event.damage ?? 0) > 0)
    const newEvent = visualEventSeq > priorActual.current.eventSeq
    if (!resetVisuals && changed && newEvent && visualContactMs < 0) return
    const beforeHp = priorActual.current.hp
    const damage = Math.max(0, beforeHp - enemy.hp)
    priorActual.current = {
      signature: visualSignature, eventSeq: visualEventSeq, resetKey: visualResetKey, hp: enemy.hp,
    }
    if (resetVisuals) {
      for (const timer of displayTimers.current.values()) clearTimeout(timer)
      displayTimers.current.clear()
      pendingVisuals.current.clear()
      splitHpActive.current = false
      for (const timer of numberTimers.current.values()) clearTimeout(timer)
      numberTimers.current.clear()
      setBulletNumbers((numbers) => numbers.length ? [] : numbers)
      onResetRef.current()
      displayedEventSeq.current = visualEventSeq
      setVisibleEnemy(enemy)
      return
    }
    if (!changed) return
    const delay = newEvent ? visualContactMs : 0
    if (delay <= 0) {
      if (splitHpActive.current && newEvent) {
        publishVisual(enemy, visualEventSeq)
        return
      }
      const pendingBeat = [...pendingVisuals.current.keys()].at(-1)
      if (pendingBeat !== undefined) {
        const pending = pendingVisuals.current.get(pendingBeat)!
        pending.eventSeq = Math.max(pending.eventSeq, visualEventSeq)
        pending.enemy = enemy
        pending.damage += damage
        pending.recovery += Math.max(0, enemy.hp - beforeHp)
        publishVisual()
        return
      }
      displayedEventSeq.current = visualEventSeq
      setVisibleEnemy(enemy)
      return
    }
    const known = newSplitEvents.every((event) => event.damage !== undefined)
    const splitDamage = known ? newSplitEvents.reduce((sum, event) => sum + event.damage!, 0) : damage
    const plans: { seq: number; weights: readonly number[] | undefined; damage: number }[] = newSplitEvents.length ? newSplitEvents.map((event) => ({
      seq: event.seq,
      weights: event.weights,
      damage: known ? event.damage! : damage / newSplitEvents.length,
    })) : [{ seq: visualEventSeq, weights: undefined, damage }]
    if (newSplitEvents.length && damage > splitDamage) plans.push({ seq: visualEventSeq, weights: undefined, damage: damage - splitDamage })
    if (newSplitEvents.length) splitHpActive.current = true
    // A defeated phase may revive in the same authoritative update. Reveal that
    // recovery only after its final impact, instead of erasing the damage numbers.
    const recovery = Math.max(0, enemy.hp - beforeHp + plans.reduce((sum, plan) => sum + plan.damage, 0))
    for (const plan of plans) {
      const beat = ++displayBeat.current
      pendingVisuals.current.set(beat, {
        eventSeq: plan.seq,
        enemy,
        damage: plan.damage,
        recovery: plan.seq === newSplitEvents.at(-1)?.seq && plan.weights ? recovery : 0,
        impactEvents: plan.weights ? [{ seq: plan.seq, weights: plan.weights }] : [],
        impacts: new Set(),
      })
      // Actual impacts drive split attacks. A slow replay decode shifts the CSS clock;
      // retain its damage debt while the combo runs, and settle missing art normally.
      const settle = () => {
        const pending = pendingVisuals.current.get(beat)
        if (!pending) return
        if (pending.impactEvents.some((impact) => splitAttackAnimationPending(impact.seq))) {
          displayTimers.current.set(beat, setTimeout(settle, 100))
          return
        }
        finishVisual(beat)
      }
      displayTimers.current.set(beat, setTimeout(settle, delay + (plan.weights ? 2_200 : 0)))
    }
    publishVisual()
  }, [acting, enemy, resetVisuals, visualContactMs, visualEventSeq, visualResetKey, visualSignature])

  useEffect(() => () => {
    for (const timer of displayTimers.current.values()) clearTimeout(timer)
    for (const timer of numberTimers.current.values()) clearTimeout(timer)
    pendingVisuals.current.clear()
  }, [])

  return { visibleEnemy, bulletNumbers, visualSignature, resetVisuals }
}
