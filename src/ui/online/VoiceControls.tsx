import { useEffect, useRef } from 'react'
import type { PublicSeat } from '../../multiplayer/useRoomSession.ts'
import type { useVoiceChat } from '../../multiplayer/useVoiceChat.ts'

export function RemoteAudio({ stream, volume }: { stream: MediaStream; volume: number }) {
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    if (audio.current) {
      audio.current.srcObject = stream
      audio.current.volume = volume / 100
    }
  }, [stream, volume])
  return <audio ref={audio} autoPlay playsInline />
}

export function VoiceControls({ voice, seats, connected, volume, compact = false, showError = true }: {
  voice: ReturnType<typeof useVoiceChat>
  seats: PublicSeat[]
  connected: boolean
  volume: number
  compact?: boolean
  showError?: boolean
}) {
  if (!voice.available) return compact ? null
    : <span className="voice voice--unavailable" data-webmcp-passive>Voice unavailable</span>
  if (!voice.enabled) {
    return (
      <div className={`voice${compact ? ' voice--compact' : ''}`} data-webmcp-passive>
        <button type="button" disabled={!connected || voice.starting} onClick={voice.start}>
          {voice.starting ? 'Opening microphone…' : 'Join voice'}
        </button>
        {showError && voice.error ? <span className="online-error" role="alert">{voice.error}</span> : null}
      </div>
    )
  }
  const connectedPeers = Object.values(voice.peerStates).filter((state) => state === 'connected').length
  return (
    <div className={`voice${compact ? ' voice--compact' : ''}`} aria-label="Party voice" data-webmcp-passive>
      {/* The peer count rides the Leave button rather than sitting beside it as
          a third element: it is a fact ABOUT the voice channel, and three
          separate controls in a row was what crowded this corner. */}
      <button type="button" aria-label={`Leave voice, ${connectedPeers} of ${Math.max(0, seats.length - 1)} peers connected`} onClick={voice.stop}>
        Leave voice <span className="voice__status">{connectedPeers}/{Math.max(0, seats.length - 1)}</span>
      </button>
      <button type="button" aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? 'Unmute' : 'Mute'}</button>
      {showError && voice.error ? <span className="online-error" role="alert">{voice.error}</span> : null}
      {Object.entries(voice.remoteStreams).map(([peerId, stream]) => <RemoteAudio key={peerId} stream={stream} volume={volume} />)}
    </div>
  )
}
