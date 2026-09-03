import { DAILY_MODIFIERS } from '../game/meta.ts'
import type { DailyModifier, DailyModifierId, QuickStartAct } from '../game/meta.ts'

export type MetaRunMode = 'standard' | 'daily' | 'custom'
export type MetaRunAct = 1 | QuickStartAct

export type MetaRunOptionsProps = {
  mode: MetaRunMode
  dailyModifiers: readonly DailyModifier[]
  customModifierIds: readonly DailyModifierId[]
  quickStartAct: MetaRunAct
  actIVUnlocked: boolean
  onModeChange: (mode: MetaRunMode) => void
  onCustomModifierChange: (id: DailyModifierId, enabled: boolean) => void
  onQuickStartActChange: (act: MetaRunAct) => void
  expanded?: boolean
  showMode?: boolean
}

export function MetaRunOptions({
  mode,
  dailyModifiers,
  customModifierIds,
  quickStartAct,
  actIVUnlocked,
  onModeChange,
  onCustomModifierChange,
  onQuickStartActChange,
  expanded = false,
  showMode = true,
}: MetaRunOptionsProps) {
  return <details className="start-menu__meta" open={expanded}>
    <summary>Run mode · {mode === 'daily' ? 'Daily Climb' : mode === 'custom' ? 'Custom' : 'Standard'}</summary>
    <div className="start-menu__meta-panel">
    {showMode ? <label>
      Mode
      <select aria-label="Run mode" value={mode}
        onChange={(event) => onModeChange(event.target.value as MetaRunMode)}>
        <option value="standard">Standard</option>
        <option value="daily">Daily Climb</option>
        <option value="custom">Custom Run</option>
      </select>
    </label> : null}

    {mode === 'daily' ? <section className="start-menu__daily" aria-label="Daily Climb modifiers">
      <p>{dailyModifiers.length ? 'One modifier from each section affects the whole party.' : 'The server rolls one modifier from each section when the run starts.'}</p>
      <ul>{dailyModifiers.map((modifier) => <li key={modifier.id}>
        <strong>{modifier.name}</strong> — {modifier.rule}
      </li>)}</ul>
    </section> : null}

    {mode === 'custom' ? <fieldset className="start-menu__custom">
      <legend>Modifiers <small>Choose any combination.</small></legend>
      {DAILY_MODIFIERS.map((modifier) => <label key={modifier.id} title={modifier.rule}>
        <input type="checkbox" checked={customModifierIds.includes(modifier.id)}
          onChange={(event) => onCustomModifierChange(modifier.id, event.target.checked)} />
        <span><strong>{modifier.name}</strong> — {modifier.rule}</span>
      </label>)}
    </fieldset> : null}

    <label>
      Starting Act
      <select aria-label="Starting Act" value={quickStartAct}
        onChange={(event) => onQuickStartActChange(Number(event.target.value) as MetaRunAct)}>
        <option value={1}>Act I — normal start</option>
        <option value={2}>Act II — Quick Start</option>
        <option value={3}>Act III — Quick Start</option>
        <option value={4} disabled={!actIVUnlocked}>Act IV — Quick Start{actIVUnlocked ? '' : ' — locked'}</option>
      </select>
    </label>
    {quickStartAct > 1 ? <p className="start-menu__quick-start-note">
      Resolve the official Quick Start rewards from top to bottom, one at a time. New players who Catch Up at the start of an Act use the same table; only they visit the Merchant.
    </p> : null}
    </div>
  </details>
}
