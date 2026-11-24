import { animationSfxRecipe } from '../combat-sfx.ts'
import { playCombatSound } from '../sfx.ts'

export function EnemyAttackEffects({
  bossAttackPlaying,
  bossArtId,
  bossProjectileArt,
  projectileImpact,
  rangedTargetPlayerIds,
  enemyUid,
  onThrowStart,
}: {
  bossAttackPlaying: boolean
  bossArtId: string
  bossProjectileArt?: string
  projectileImpact?: string
  rangedTargetPlayerIds: readonly string[]
  enemyUid: string
  onThrowStart?: (enemyUid: string) => void
}) {
  return <>
    {bossAttackPlaying && ['sentry', 'giant_head'].includes(bossArtId) ? (
      <span className="elite-attack-effect" aria-hidden="true" />
    ) : null}
    {bossAttackPlaying && bossProjectileArt ? rangedTargetPlayerIds.map((playerId) => (
      <span className="boss-projectile" data-target-player={playerId} key={playerId} aria-hidden="true"
        onAnimationStart={(event) => {
          if (event.animationName === 'cultist-stick-flight') onThrowStart?.(enemyUid)
        }}>
        {bossArtId === 'cultist' ? <>
          <span className="cultist-stick"><img src={bossProjectileArt} alt="" /></span>
          <span className="cultist-stick"><img src={bossProjectileArt} alt="" /></span>
        </> : <img src={bossProjectileArt} alt="" />}
      </span>
    )) : null}

    {bossAttackPlaying && projectileImpact ? rangedTargetPlayerIds.map((playerId) => (
      <span className="enemy-projectile-impact" data-target-player={playerId} key={playerId} aria-hidden="true"
        data-impact-anchor={projectileImpact.endsWith('/turn-poison-impact.webp') ? 'feet' : undefined}>
        <img src={projectileImpact} alt="" />
      </span>
    )) : null}
  </>
}

export function BossHeavyTargets({ targets }: { targets?: readonly string[] }) {
  if (!targets) return null
  return <>
    {targets.map((playerId) => (
      <span className="boss-heavy-target" data-target-player={playerId} key={playerId} aria-hidden="true">
        <span className="boss-heavy-target__beam" />
        <span className="boss-heavy-target__flight" />
        <span className="boss-heavy-target__impact">
          <span className="boss-heavy-target__ring" />
          <span className="boss-heavy-target__burst" />
          <span className="boss-heavy-target__burst boss-heavy-target__burst--echo" />
          <span className="boss-heavy-target__debris" />
        </span>
      </span>
    ))}
  </>
}

export function EnemyPortraitEffects({
  sleeping,
  bossAttackPlaying,
  bossArtId,
  rangedTargetPlayerIds,
  hasHeavy,
  animatedEnemy,
  demonAttacking,
}: {
  sleeping: boolean
  bossAttackPlaying: boolean
  bossArtId: string
  rangedTargetPlayerIds: readonly string[]
  hasHeavy: boolean
  animatedEnemy: boolean
  demonAttacking: boolean
}) {
  return <>
    {sleeping ? <span className="enemy-sleep-zzz" aria-hidden="true"><span>z</span><span>z</span><span>Z</span></span> : null}
    {bossAttackPlaying && bossArtId === 'gremlin_leader' ? <>
      <span className="gremlin-speed-trail" aria-hidden="true" />
      <span className="gremlin-afterimage gremlin-afterimage--first" aria-hidden="true" />
      <span className="gremlin-afterimage gremlin-afterimage--second" aria-hidden="true" />
      {rangedTargetPlayerIds.map((playerId, index) => <span className="boss-projectile gremlin-delayed-slash"
        data-target-player={playerId} key={playerId} aria-hidden="true"
        onAnimationStart={(event) => {
          if (index === 0 && event.animationName === 'gremlin-slash-impact') playCombatSound(animationSfxRecipe('sword-clash'))
        }}><span /></span>)}
    </> : null}
    {bossAttackPlaying && bossArtId === 'reptomancer' ?
      <span className="reptomancer-sigil" aria-hidden="true" /> : null}
    {hasHeavy && animatedEnemy ? <span className="boss-heavy-charge" aria-hidden="true">
      <span className="boss-heavy-charge__aura" />
      <span className="boss-heavy-charge__ring" />
      <span className="boss-heavy-charge__sparks" />
    </span> : null}
    {demonAttacking ? <>
      <span className="boss-demon-ground-splat boss-demon-ground-splat--origin" aria-hidden="true" />
      <span className="boss-demon-ground-splat boss-demon-ground-splat--target" aria-hidden="true" />
    </> : null}
  </>
}
