import type { StatsQuery } from './stats.ts'

export type CardChoice = { id: string; label: string; upgraded: boolean | null }

export function joinQueries(op: 'and' | 'or', nodes: StatsQuery[]): StatsQuery | null {
  if (!nodes.length) return null
  if (nodes.length === 1) return nodes[0]!
  const middle = Math.floor(nodes.length / 2)
  return { op, left: joinQueries(op, nodes.slice(0, middle))!, right: joinQueries(op, nodes.slice(middle))! }
}

export function validateStatsQuery(query: StatsQuery | null): void {
  if (!query) return
  let nodes = 0
  const inspect = (node: StatsQuery, depth: number): void => {
    if (depth > 12 || ++nodes > 40) throw new Error('Use fewer card filters or fewer nested operators (40 parts, 12 levels maximum).')
    if (node.op === 'not') inspect(node.value, depth + 1)
    else if (node.op !== 'card') { inspect(node.left, depth + 1); inspect(node.right, depth + 1) }
  }
  inspect(query, 0)
  if (JSON.stringify(query).length > 2048) throw new Error('That expression is too long. Try fewer cards.')
}

export function parseStatsExpression(source: string, choices: readonly CardChoice[]): StatsQuery | null {
  if (!source.trim()) return null
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|[()]|[^\s()]+/g) ?? []
  let position = 0
  const is = (word: string) => tokens[position]?.toLowerCase() === word
  const consume = (word: string) => { if (is(word)) { position += 1; return true } return false }
  const term = (): StatsQuery => {
    if (consume('not')) return { op: 'not', value: term() }
    if (consume('(')) {
      const nested = disjunction()
      if (!consume(')')) throw new Error('Add a closing parenthesis.')
      return nested
    }
    const name = []
    while (position < tokens.length && !['and', 'or', ')', '('].includes(tokens[position]!.toLowerCase())) {
      name.push(tokens[position++]!)
    }
    if (!name.length) throw new Error('Choose a card after the operator.')
    const label = name.join(' ').replace(/^"|"$/g, '').trim().replace(/^Explosive Corps(?=\+?$)/i, 'Corpse Explosion')
    if (label.startsWith('@')) {
      const id = label.slice(1)
      if (!choices.some((choice) => choice.id === id)) throw new Error(`Unknown card “${label}”. Choose a card from the suggestions or check its spelling.`)
      return { op: 'card', id, upgraded: null }
    }
    const found = choices.filter((choice) => choice.label.toLowerCase() === label.toLowerCase())
    if (!found.length) throw new Error(`Unknown card “${label}”. Choose a card from the suggestions or check its spelling.`)
    return joinQueries('or', found.map((choice) => ({ op: 'card', id: choice.id, upgraded: choice.upgraded })))!
  }
  const conjunction = (): StatsQuery => {
    const parts = [term()]
    while (consume('and')) parts.push(term())
    return joinQueries('and', parts)!
  }
  const disjunction = (): StatsQuery => {
    const parts = [conjunction()]
    while (consume('or')) parts.push(conjunction())
    return joinQueries('or', parts)!
  }
  const result = disjunction()
  if (position !== tokens.length) throw new Error(`Unexpected “${tokens[position]}”. Use AND, OR, NOT and parentheses.`)
  return result
}
