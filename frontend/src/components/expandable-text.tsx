import { useState, type ReactElement } from 'react'
import { truncateText } from '../lib/format'

export function ExpandableText({ text, limit }: { text: string; limit: number }): ReactElement {
  const [expanded, setExpanded] = useState(false)

  return (
    <span className="expandable-text">
      {expanded ? text : truncateText(text, limit)}
      {text.length > limit ? (
        <>{' '}<button type="button" className="text-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button></>
      ) : null}
    </span>
  )
}
