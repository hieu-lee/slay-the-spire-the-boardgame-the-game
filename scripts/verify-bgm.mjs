import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { suite, check, assert, report } from './lib/harness.mjs'

const directory = resolve(import.meta.dirname, '../public/assets/bgm')

suite('background music')
check('music has no large ID3 header before the first playable frame', () => {
  const tracks = readdirSync(directory).filter((file) => file.endsWith('.mp3'))
  assert(tracks.length > 0, 'no background music tracks found')
  for (const track of tracks) {
    const header = Buffer.alloc(10)
    const file = openSync(resolve(directory, track), 'r')
    try {
      assert(readSync(file, header, 0, header.length, 0) === header.length, `${track} is truncated`)
    } finally {
      closeSync(file)
    }
    if (header.toString('ascii', 0, 3) !== 'ID3') continue
    const size = header.subarray(6, 10).reduce((value, byte) => value * 128 + byte, 0)
    assert(size < 16 * 1024, `${track} delays playback with ${size} bytes of ID3 metadata`)
  }
})
report('background music')
