// Fast deep cloner for JSON-serializable engine state (plain objects, arrays,
// and primitives). Engine states never hold Maps, Sets, Dates, RegExps, cyclic
// graphs, or class instances, so a specialized plain-object walk avoids
// structuredClone's general serialization overhead while preserving zero shared
// mutable references.
const hasOwn = Object.prototype.hasOwnProperty

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function cloneValue(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (Array.isArray(value)) {
    const length = value.length
    const copy: unknown[] = new Array<unknown>(length)
    for (let index = 0; index < length; index++) {
      const item = value[index]
      copy[index] = item !== null && typeof item === 'object' ? cloneValue(item) : item
    }
    return copy
  }
  const copy: Record<string, unknown> = {}
  for (const key in value) {
    if (hasOwn.call(value, key)) {
      const entry = value[key]
      copy[key] = entry !== null && typeof entry === 'object' ? cloneValue(entry) : entry
    }
  }
  return copy
}

export function clone<T>(value: T): T {
  return cloneValue(value) as T
}
