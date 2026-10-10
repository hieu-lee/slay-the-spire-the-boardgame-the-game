/** Emphasis on native faces; the underlying rules remain exact data text. */
export function KeywordText({ text }: { text: string }) {
  return <span>{text.split(/\b(Block|Weak|Vulnerable|Strength|Energy|Exhaust|Retain|Ethereal|Scry|Poison|Miracles?|Shivs?|Attacks?|Skills?|Powers?)\b/gi)
    .map((part, index) => index % 2
      ? <strong className="rules-keyword" key={index}>{part}</strong>
      : part)}</span>
}
