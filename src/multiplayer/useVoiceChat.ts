import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PublicSeat, VoiceSignal } from './useRoomSession.ts'

type VoiceOptions = {
  roomCode?: string
  playerId?: string
  seats: PublicSeat[]
  connected: boolean
  sendSignal: (to: string, signal: VoiceSignal['signal']) => boolean
  onSignal: (listener: (message: VoiceSignal) => void) => () => void
  loadIceServers: () => Promise<RTCIceServer[]>
}

type Peer = {
  connection: RTCPeerConnection
  pendingCandidates: RTCIceCandidateInit[]
  signals: Promise<void>
}

export function useVoiceChat({ roomCode, playerId, seats, connected, sendSignal, onSignal, loadIceServers }: VoiceOptions) {
  const [enabled, setEnabled] = useState(false)
  const [starting, setStarting] = useState(false)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
  const [peerStates, setPeerStates] = useState<Record<string, RTCPeerConnectionState>>({})
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const enabledRef = useRef(false)
  const startingRef = useRef(false)
  const attempt = useRef(0)
  const mounted = useRef(true)
  const localStream = useRef<MediaStream | null>(null)
  const iceServers = useRef<RTCIceServer[]>([])
  const peers = useRef(new Map<string, Peer>())
  const peerRevisions = useRef(new Map<string, number>())
  const nextPeerRevision = useRef(0)
  const voiceId = useRef<string | undefined>(undefined)
  const remoteVoiceIds = useRef(new Map<string, string>())
  const retiredVoiceIds = useRef(new Map<string, Set<string>>())
  const loadIceServersRef = useRef(loadIceServers)
  const iceRefresh = useRef<Promise<RTCIceServer[]> | null>(null)
  const identity = useRef(roomCode && playerId ? `${roomCode}:${playerId}` : undefined)
  const playerIdRef = useRef(playerId)
  const sendSignalRef = useRef(sendSignal)

  playerIdRef.current = playerId
  sendSignalRef.current = sendSignal
  loadIceServersRef.current = loadIceServers

  const removePeer = useCallback((peerId: string) => {
    const revision = ++nextPeerRevision.current
    peerRevisions.current.set(peerId, revision)
    const connection = peers.current.get(peerId)?.connection
    if (connection) {
      connection.onicecandidate = null
      connection.ontrack = null
      connection.onconnectionstatechange = null
      connection.close()
    }
    peers.current.delete(peerId)
    remoteVoiceIds.current.delete(peerId)
    setPeerStates((current) => {
      const next = { ...current }
      delete next[peerId]
      return next
    })
    setRemoteStreams((current) => {
      const next = { ...current }
      delete next[peerId]
      return next
    })
    return revision
  }, [])

  const signalPeer = useCallback((peerId: string, signal: VoiceSignal['signal']) => {
    if (!voiceId.current) return false
    const toVoiceId = remoteVoiceIds.current.get(peerId)
    return sendSignalRef.current(peerId, { ...signal, voiceId: voiceId.current, ...(toVoiceId ? { toVoiceId } : {}) })
  }, [])

  const refreshIceServers = useCallback(() => {
    if (!iceRefresh.current) {
      const pending = loadIceServersRef.current().finally(() => {
        if (iceRefresh.current === pending) iceRefresh.current = null
      })
      iceRefresh.current = pending
    }
    return iceRefresh.current
  }, [])

  const ensurePeer = useCallback((peerId: string) => {
    const existing = peers.current.get(peerId)
    if (existing) return existing
    if (!localStream.current) return null
    const connection = new RTCPeerConnection({ iceServers: iceServers.current })
    for (const track of localStream.current.getTracks()) connection.addTrack(track, localStream.current)
    const peer: Peer = { connection, pendingCandidates: [], signals: Promise.resolve() }
    peerRevisions.current.set(peerId, ++nextPeerRevision.current)
    peers.current.set(peerId, peer)
    setPeerStates((current) => ({ ...current, [peerId]: connection.connectionState }))
    connection.onicecandidate = (event) => {
      if (event.candidate) signalPeer(peerId, { candidate: event.candidate.toJSON() })
    }
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      setRemoteStreams((current) => ({ ...current, [peerId]: stream }))
    }
    connection.onconnectionstatechange = () => {
      setPeerStates((current) => ({ ...current, [peerId]: connection.connectionState }))
      if (connection.connectionState === 'failed') {
        const failedAttempt = attempt.current
        const failedVoiceId = voiceId.current
        const failedRevision = removePeer(peerId)
        const isCurrentFailure = () => enabledRef.current
          && attempt.current === failedAttempt
          && voiceId.current === failedVoiceId
          && peerRevisions.current.get(peerId) === failedRevision
        if (enabledRef.current) void refreshIceServers().then((servers) => {
          if (!isCurrentFailure()) return
          iceServers.current = servers
          signalPeer(peerId, { ready: true, restart: true })
        }).catch((cause) => {
          if (mounted.current && isCurrentFailure()) setError(cause instanceof Error ? cause.message : 'Voice reconnect failed')
        })
      }
    }
    return peer
  }, [refreshIceServers, removePeer, signalPeer])

  const offer = useCallback(async (peerId: string, peer: Peer) => {
    if (peer.connection.signalingState !== 'stable' || peer.connection.connectionState === 'connected') return
    const description = await peer.connection.createOffer()
    if (peers.current.get(peerId) !== peer) return
    await peer.connection.setLocalDescription(description)
    if (peers.current.get(peerId) !== peer) return
    signalPeer(peerId, { description })
  }, [signalPeer])

  useEffect(() => onSignal((message) => {
    if (!connected || !enabledRef.current || message.from === playerIdRef.current) return
    const senderVoiceId = message.signal.voiceId
    if (!senderVoiceId || (message.signal.toVoiceId && message.signal.toVoiceId !== voiceId.current)) return
    if (retiredVoiceIds.current.get(message.from)?.has(senderVoiceId)) return
    const knownVoiceId = remoteVoiceIds.current.get(message.from)
    const establishesUnknownPeer = !knownVoiceId && (message.signal.ready || message.signal.toVoiceId === voiceId.current)
    const replacesKnownPeer = !!knownVoiceId && knownVoiceId !== senderVoiceId && message.signal.ready
    if (replacesKnownPeer) {
      const retired = retiredVoiceIds.current.get(message.from) ?? new Set<string>()
      retired.add(knownVoiceId)
      retiredVoiceIds.current.set(message.from, retired)
    }
    if (establishesUnknownPeer || replacesKnownPeer || (knownVoiceId === senderVoiceId && message.signal.restart)) {
      removePeer(message.from)
      remoteVoiceIds.current.set(message.from, senderVoiceId)
    }
    if (remoteVoiceIds.current.get(message.from) !== senderVoiceId) return
    if (message.signal.left) {
      const retired = retiredVoiceIds.current.get(message.from) ?? new Set<string>()
      retired.add(senderVoiceId)
      retiredVoiceIds.current.set(message.from, retired)
      return removePeer(message.from)
    }
    const peer = ensurePeer(message.from)
    if (!peer) return
    peer.signals = peer.signals.then(async () => {
      if (peers.current.get(message.from) !== peer) return
      if (message.signal.ready) {
        if ((playerIdRef.current ?? '') < message.from) await offer(message.from, peer)
        else signalPeer(message.from, { ready: true })
        return
      }
      if (message.signal.description) {
        await peer.connection.setRemoteDescription(message.signal.description)
        if (peers.current.get(message.from) !== peer) return
        for (const candidate of peer.pendingCandidates.splice(0)) {
          if (peers.current.get(message.from) !== peer) return
          await peer.connection.addIceCandidate(candidate)
        }
        if (message.signal.description.type === 'offer') {
          const answer = await peer.connection.createAnswer()
          if (peers.current.get(message.from) !== peer) return
          await peer.connection.setLocalDescription(answer)
          if (peers.current.get(message.from) !== peer) return
          signalPeer(message.from, { description: answer })
        }
      } else if (message.signal.candidate) {
        if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(message.signal.candidate)
        else peer.pendingCandidates.push(message.signal.candidate)
      }
    }).catch((cause) => {
      if (mounted.current && peers.current.get(message.from) === peer) {
        setError(cause instanceof Error ? cause.message : 'Voice connection failed')
      }
    })
  }), [connected, ensurePeer, offer, onSignal, removePeer, signalPeer])

  const stop = useCallback(() => {
    attempt.current += 1
    startingRef.current = false
    enabledRef.current = false
    iceRefresh.current = null
    for (const track of localStream.current?.getTracks() ?? []) track.stop()
    localStream.current = null
    for (const peerId of [...peers.current.keys()]) {
      signalPeer(peerId, { left: true })
      removePeer(peerId)
    }
    retiredVoiceIds.current.clear()
    voiceId.current = undefined
    setEnabled(false)
    setStarting(false)
    setMuted(false)
    setError('')
  }, [removePeer, signalPeer])

  useEffect(() => {
    const next = roomCode && playerId ? `${roomCode}:${playerId}` : undefined
    if (identity.current && identity.current !== next) stop()
    identity.current = next
  }, [playerId, roomCode, stop])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      enabledRef.current = false
      iceRefresh.current = null
      for (const track of localStream.current?.getTracks() ?? []) track.stop()
      for (const peerId of [...peers.current.keys()]) {
        signalPeer(peerId, { left: true })
        removePeer(peerId)
      }
      remoteVoiceIds.current.clear()
      retiredVoiceIds.current.clear()
      voiceId.current = undefined
    }
  }, [removePeer, signalPeer])

  const peerKey = useMemo(() => seats
    .filter((seat) => seat.connected && seat.playerId !== playerId)
    .map((seat) => seat.playerId)
    .sort()
    .join(','), [playerId, seats])

  useEffect(() => {
    if (!enabled) return
    if (!connected) {
      for (const peerId of [...peers.current.keys()]) removePeer(peerId)
      return
    }
    const current = new Set(peerKey ? peerKey.split(',') : [])
    for (const peerId of peers.current.keys()) if (!current.has(peerId)) removePeer(peerId)
    for (const peerId of current) signalPeer(peerId, { ready: true })
  }, [connected, enabled, peerKey, removePeer, signalPeer])

  const start = useCallback(async () => {
    if (startingRef.current || enabledRef.current || !playerId) return
    const startedAttempt = ++attempt.current
    startingRef.current = true
    setStarting(true)
    setError('')
    let stream: MediaStream | null = null
    try {
      const servers = await refreshIceServers()
      if (!mounted.current || attempt.current !== startedAttempt) return
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (!mounted.current || attempt.current !== startedAttempt) return stream.getTracks().forEach((track) => track.stop())
      localStream.current = stream
      iceServers.current = servers
      voiceId.current = crypto.randomUUID()
      enabledRef.current = true
      setEnabled(true)
    } catch (cause) {
      for (const track of stream?.getTracks() ?? []) track.stop()
      if (mounted.current && attempt.current === startedAttempt) {
        setError(cause instanceof Error ? cause.message : 'Microphone access failed')
      }
    } finally {
      if (mounted.current && attempt.current === startedAttempt) {
        startingRef.current = false
        setStarting(false)
      }
    }
  }, [playerId, refreshIceServers])

  const toggleMute = useCallback(() => {
    const next = !muted
    for (const track of localStream.current?.getAudioTracks() ?? []) track.enabled = !next
    setMuted(next)
  }, [muted])

  return {
    available: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined',
    enabled,
    starting,
    muted,
    error,
    peerStates,
    remoteStreams,
    start,
    stop,
    toggleMute,
  }
}
