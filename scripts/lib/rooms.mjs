// Room logic for co-op play: seats, reconnection, action authorisation, and
// the per-seat redaction that keeps hidden information hidden.
//
// Deliberately free of any network code so it can be tested as plain function
// calls. The socket layer on top of this is a thin shell: it owns transport,
// this owns every rule about who may see or do what.
//
// Nothing here returns the room object itself except `joinRoom`, which hands a
// seat to the player who just claimed it. `room.seats[].token` is a bearer
// credential for that seat, so it must never travel to anyone else.
//
// The board game is SIMULTANEOUS (p.12): "All players take these steps
// simultaneously." There is no turn order to enforce, so two players can act at
// the same instant. Every mutation therefore goes through `apply`, which is the
// single writer — Node's single thread does the rest.
//
// Public barrel over the layered implementation under `./rooms/`.

export {
  CHARACTERS,
  GIVE_UP_TIMEOUT_MS,
  MAX_SEATS,
  UID_LIMIT,
  findSeat,
  restoreRoom,
  roomCode,
  uidList,
} from './rooms/shared.mjs'
export {
  createRoom,
  createStore,
  repairInterruptedJournals,
  saveStore,
} from './rooms/store.mjs'
export {
  chooseAscension,
  chooseCharacter,
  chooseLastStandRule,
  chooseRelicRule,
  chooseRunMeta,
  joinRoom,
  markDisconnected,
  removeSeat,
  selectCampaign,
  startRun,
} from './rooms/lobby.mjs'
export { apply } from './rooms/apply.mjs'
export { snapshotFor } from './rooms/snapshot.mjs'
