import { css } from '@/styled-system/css'

import { parseRichText } from './richText'

/**
 * `rich-text` bubble contents (机器人经 webhook 发来的富文本)。
 *
 * Rendered **inside** the ordinary bubble rather than as its own card row, so
 * it inherits reactions, read receipts, the context menu, multi-select, the
 * timestamp title and the avatar for free. The card components each had to
 * reimplement all of that; there is no reason to do it a fourth time for
 * something that is, after all, just formatted text.
 */
export const RichTextBody = ({
  raw,
  isOwn,
  selfMentionNames = [],
}: {
  raw: string
  isOwn: boolean
  /** 名字命中就高亮成「@我」,与 renderBody 的口径一致。 */
  selfMentionNames?: string[]
}) => {
  const body = parseRichText(raw)
  // Bad data must not blank the bubble — same degradation as the cards.
  if (!body) return <>{raw}</>

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      })}
    >
      {body.title && (
        <div className={css({ fontWeight: 'bold' })}>{body.title}</div>
      )}
      {body.content.map((paragraph, pi) => (
        <p key={pi} className={css({ margin: 0, whiteSpace: 'pre-wrap' })}>
          {paragraph.map((tag, ti) => {
            if (tag.tag === 'text') return <span key={ti}>{tag.text}</span>
            if (tag.tag === 'a')
              return (
                <a
                  key={ti}
                  href={tag.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: isOwn ? '#dbeafe' : '#2563eb',
                    textDecoration: 'underline',
                  }}
                >
                  {tag.text}
                </a>
              )
            const isSelf =
              tag.uid === 'all' || selfMentionNames.includes(tag.name)
            return (
              <span
                key={ti}
                style={
                  isSelf
                    ? {
                        backgroundColor: '#fde68a',
                        color: '#92400e',
                        borderRadius: '3px',
                        padding: '0 2px',
                        fontWeight: 700,
                      }
                    : { fontWeight: 700, color: isOwn ? '#dbeafe' : '#2563eb' }
                }
              >
                @{tag.name}
              </span>
            )
          })}
        </p>
      ))}
    </div>
  )
}
