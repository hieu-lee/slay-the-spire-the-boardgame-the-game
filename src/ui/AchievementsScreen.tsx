import { ACHIEVEMENTS } from '../game/achievements.ts'

type Props = {
  onBack: () => void
}

export function AchievementsScreen({ onBack }: Props) {
  return (
    <main className="compendium">
      <aside className="compendium__filters">
        <button type="button" className="compendium__back ribbon-back" onClick={onBack} aria-label="Back to main menu"><span aria-hidden="true"></span></button>
        <h1>Achievements</h1>
        <section className="compendium__filter-block">
          <h2>Official challenges <span aria-hidden="true">✦</span></h2>
        </section>
        <p>Reference the physical game’s achievement challenges here.</p>
      </aside>

      <section className="compendium__library" aria-labelledby="achievements-title">
        <header><h2 id="achievements-title">The Spire remembers</h2><span>{ACHIEVEMENTS.length} challenges</span></header>
        <div className="compendium__grid">
          {ACHIEVEMENTS.map((achievement, index) => {
            const descriptionId = `achievement-${achievement.id}`
            return (
              <article key={achievement.id} className="achievement-card" aria-describedby={descriptionId}>
                <strong>{index + 1}. {achievement.name}</strong>
                <span id={descriptionId}>{achievement.text}</span>
              </article>
            )
          })}
        </div>
      </section>
    </main>
  )
}
