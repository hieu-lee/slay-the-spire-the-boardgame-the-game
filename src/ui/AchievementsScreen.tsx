import type { CSSProperties } from 'react'
import { ACHIEVEMENTS } from '../game/achievements.ts'
import type { AchievementId } from '../game/achievements.ts'
import type { CampaignProgress } from '../game/campaign.ts'

type Props = {
  progress: Pick<CampaignProgress, 'achievements'>
  onChange: (id: AchievementId, completed: boolean) => void
  onBack: () => void
  readOnly?: boolean
}

const cardStyle: CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto auto 1fr auto',
  minHeight: '13rem',
  padding: '1rem',
  border: '2px solid #6b5944',
  borderRadius: '0.55rem',
  color: '#eee6d2',
  background: 'linear-gradient(155deg, rgb(73 31 38 / 0.97), rgb(27 23 23 / 0.98))',
  boxShadow: '0 0.55rem 0.75rem rgb(0 0 0 / 0.72), inset 0 0 1.5rem rgb(230 179 74 / 0.08)',
}

export function AchievementsScreen({ progress, onChange, onBack, readOnly = false }: Props) {
  const completed = new Set(progress.achievements)

  return (
    <main className="compendium">
      <aside className="compendium__filters">
        <button type="button" className="compendium__back" onClick={onBack} aria-label="Back to main menu">←</button>
        <h1>Achievements</h1>
        <section className="compendium__filter-block">
          <h2>Campaign record <span aria-hidden="true">✦</span></h2>
          <div className="compendium__checks">
            <strong aria-live="polite">{completed.size} / {ACHIEVEMENTS.length} complete</strong>
            <progress aria-label="Achievement completion" value={completed.size} max={ACHIEVEMENTS.length} />
          </div>
        </section>
        <p>Use this as the physical achievement checklist. The party records each completed challenge.</p>
      </aside>

      <section className="compendium__library" aria-labelledby="achievements-title">
        <header><h2 id="achievements-title">The Spire remembers</h2><span>{ACHIEVEMENTS.length} challenges</span></header>
        <div className="compendium__grid">
          {ACHIEVEMENTS.map((achievement, index) => {
            const checked = completed.has(achievement.id)
            const descriptionId = `achievement-${achievement.id}`
            return (
              <label key={achievement.id} style={{ ...cardStyle, borderColor: checked ? '#d5ae49' : '#6b5944', filter: checked ? 'none' : 'grayscale(0.65)' }}>
                <span aria-hidden="true" style={{ color: checked ? '#f1cf68' : '#9a8c76', fontSize: '1.7rem' }}>{checked ? '◆' : '◇'}</span>
                <strong style={{ color: checked ? '#f5d978' : '#ddd2be', fontSize: '1.08rem' }}>{index + 1}. {achievement.name}</strong>
                <span id={descriptionId} style={{ marginTop: '0.55rem', lineHeight: 1.35 }}>{achievement.text}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', minHeight: '2.75rem', marginTop: '0.7rem', color: '#f2d075' }}>
                  <input type="checkbox" checked={checked} disabled={readOnly}
                    aria-describedby={descriptionId} onChange={(event) => onChange(achievement.id, event.target.checked)}
                    style={{ width: '1.35rem', height: '1.35rem', accentColor: '#d8ad46' }} />
                  {checked ? 'Completed' : readOnly ? 'Not completed' : 'Mark complete'}
                </span>
              </label>
            )
          })}
        </div>
      </section>
    </main>
  )
}
