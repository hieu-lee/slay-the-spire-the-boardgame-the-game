import { readFileSync } from 'node:fs'

/** Pixel size of a WebP, read from its header rather than by shelling out. */
export function webpSize(file) {
  const bytes = readFileSync(file)
  if (bytes.length < 30) return [0, 0]
  const chunk = bytes.subarray(12, 16).toString()
  if (chunk === 'VP8X') {
    return [(bytes.readUIntLE(24, 3) & 0xffffff) + 1, (bytes.readUIntLE(27, 3) & 0xffffff) + 1]
  }
  if (chunk === 'VP8 ') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
  if (chunk === 'VP8L') {
    const packed = bytes.readUInt32LE(21)
    return [(packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1]
  }
  return [0, 0]
}
