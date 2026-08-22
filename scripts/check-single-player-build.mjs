import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const dist = resolve(process.argv[2] ?? 'dist')
const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && ['.css', '.html', '.js'].includes(extname(entry.name)))
  .map((entry) => join(entry.parentPath, entry.name))
const output = files.map((file) => readFileSync(file, 'utf8')).join('\n')

assert(!output.includes('/api/rooms'), 'single-player build still contains the room API')
assert(!output.includes('Play online'), 'single-player build still contains the multiplayer entry')
assert(!output.match(/["'(]\/assets\//), 'single-player build contains a domain-root asset URL')
assert(readFileSync(join(dist, 'index.html'), 'utf8').includes('./assets/'), 'entry assets are not relative')

console.log(`single-player Pages build verified (${files.length} text files)`)
