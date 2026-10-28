/**
 * Fact text with its [[… __ …]] gaps shown as a highlighted "?" phrase, and TO CONFIRM highlighted.
 * A gap is a number the person still has to give (the Charly Resume Method's bracket prompts).
 */
export function FactText({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\]|TO CONFIRM(?: WITH [A-Z]+)?)/i)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p
        if (p.startsWith('[[')) {
          return <span key={i} className="gap" title="A number to add">{p.slice(2, -2).replace(/__/g, '?')}</span>
        }
        return <span key={i} className="flagged">{p}</span>
      })}
    </>
  )
}
