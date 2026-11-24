import { memo } from 'react'
import { Icon, IconValue } from '../Icon.tsx'
import type { IntentPart } from './intent.ts'

export const EnemyIntentStrip = memo(function EnemyIntentStrip({ dead, intent }: { dead: boolean; intent: readonly IntentPart[] }) {
  return (
    /* A corpse telegraphing an attack it will never make is worse than no
       intent at all — it is read as a threat while choosing a target.
       p.13: the dead are flipped over until the end of combat. */
    <span className="enemy__intent">
      {dead ? (
        // Not the `monster` icon: that same glyph badges LIVING enemies two
        // lines above, so a corpse wearing it still reads as a threat.
        <span className="enemy__defeated" aria-hidden="true">
          ✕
        </span>
      ) : intent.length === 0 ? (
        <span className="enemy__asleep">…</span>
      ) : (
        intent.map((part, i) => (
          <span className="intent" key={`${part.icon}-${i}`}>
            {part.aoe ? <Icon name="aoe" size={20} /> : null}
            <IconValue name={part.icon} value={part.value ?? ''} prefix={part.prefix} size={28} />
            {part.visibleLabel ? <span className="intent__label">{part.visibleLabel}</span> : null}
          </span>
        ))
      )}
    </span>
  )
})
