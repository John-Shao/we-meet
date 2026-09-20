import { RiUser3Line } from '@remixicon/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/ApiError'
import { Button } from '@/primitives'
import { css, cx } from '@/styled-system/css'
import { useTranscriptDraft } from '../hooks/useTranscriptDraft'

/**
 * 命中片段的高亮底色。
 *
 * 取 `action.selected.*` 成对使用：浅色是品牌浅蓝底 + 深蓝字（约 6:1），
 * 深色自动翻成深蓝底 + 浅蓝字（约 5.5:1），两套都过 §2.1 的 4.5:1。
 * 不加内边距 —— 行内高亮一旦撑开盒模型，同一条里命中多次时字距会跳。
 */
const markCls = css({
  backgroundColor: 'action.selected.bg',
  color: 'action.selected.text',
  borderRadius: 'field',
})

/**
 * 把 `text` 里所有 `query` 的命中处包进 `<mark>`。
 *
 * 大小写不敏感、按字面量匹配（`indexOf` 而不是正则）—— 搜索词直接来自用户输入，
 * 拼进正则会让 `(`、`*` 这类字符抛异常或误匹配。逐字稿的查询本来就是字面量。
 */
function highlightMatches(text: string, query: string) {
  const needle = query.trim()
  if (!needle) return text
  const haystack = text.toLowerCase()
  const lowered = needle.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let index = haystack.indexOf(lowered)
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(
      <mark key={`${index}-${parts.length}`} className={markCls}>
        {text.slice(index, index + needle.length)}
      </mark>
    )
    cursor = index + needle.length
    index = haystack.indexOf(lowered, cursor)
  }
  parts.push(text.slice(cursor))
  return parts
}

/**
 * One utterance.
 *
 * Editing is offered only when a caller passes `onCorrect`. A record whose
 * source has no revision model (an online meeting transcript) simply omits it,
 * so the row never shows a control that would fail — the server refuses that
 * source, and a button whose only outcome is an error is worse than no button.
 */
export function TranscriptSegment({
  speaker,
  time,
  text,
  onSeek,
  seekLabel,
  segmentId,
  active = false,
  originalText,
  isCorrected = false,
  onCorrect,
  onRevert,
  correcting = false,
  editFailed = false,
  correctionRevision = 0,
  highlight,
}: {
  speaker: string
  time: string
  text: string
  onSeek?: () => void
  seekLabel?: string
  /** Identifies this row to the list that scrolls it into view. */
  segmentId: string
  /**
   * True while playback is inside this row. Passed in rather than derived here
   * so the row stays a leaf: the list decides which row is active and which row
   * gets scrolled, exactly once per change.
   */
  active?: boolean
  /** What the recogniser produced, shown when it differs from `text`. */
  originalText?: string
  isCorrected?: boolean
  correctionRevision?: number
  /**
   * 当前搜索词：正文里命中的片段会被标出来。
   *
   * 高亮落在正文里而不是只做「筛掉不匹配的行」—— 服务端把整份逐字稿按关键词过滤后
   * 返回，读者仍需在每条里找到**是哪个词**命中的，尤其是一条里出现多次时。
   */
  highlight?: string
  onCorrect?: (
    segmentId: string,
    text: string,
    expectedRevision: number
  ) => Promise<unknown> | void
  onRevert?: (
    segmentId: string,
    expectedRevision: number
  ) => Promise<unknown> | void
  correcting?: boolean
  editFailed?: boolean
}) {
  const { t } = useTranslation('meetings')
  const editor = useTranscriptDraft(segmentId, text, correctionRevision)
  const {
    editing,
    text: draft,
    revision: editRevision,
    pending,
    failure,
  } = editor.state
  const [showingOriginal, setShowingOriginal] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])

  const trimmed = draft.trim()
  const busy = correcting || pending
  const canSave = !!onCorrect && trimmed.length > 0 && trimmed !== text && !busy

  const startEditing = () => {
    editor.update({
      text,
      revision: correctionRevision,
      failure: null,
      editing: true,
    })
    setShowingOriginal(false)
  }

  const shown =
    showingOriginal && originalText !== undefined ? originalText : text

  const submit = async (restore = false) => {
    if (busy || (restore ? !onRevert : !onCorrect)) return
    editor.update({ pending: true, failure: null })
    try {
      if (restore) await onRevert?.(segmentId, correctionRevision)
      else await onCorrect?.(segmentId, trimmed, editRevision)
      editor.reset()
      setShowingOriginal(false)
    } catch (error) {
      editor.update({
        failure:
          error instanceof ApiError && error.statusCode === 409
            ? 'conflict'
            : 'failed',
      })
    } finally {
      editor.update({ pending: false })
    }
  }

  return (
    <article
      // The list finds the active row by this attribute, so a filtered list can
      // simply not find it instead of needing a second source of truth.
      data-segment-id={segmentId}
      // aria-current is the accessible signal; the left rule is its visual twin.
      aria-current={active ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
      data-corrected={isCorrected ? 'true' : undefined}
      className={cx(
        css({
          padding: '1.25rem 0',
          overflowWrap: 'anywhere',
          borderLeft: '3px solid transparent',
          paddingLeft: 'md',
          marginLeft: '-0.75rem',
          transition: 'background-color 150ms ease',
        }),
        active &&
          css({
            backgroundColor: 'brand.50',
            borderLeftColor: 'brand.500',
          })
      )}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.625rem',
          marginBottom: '0.875rem',
          color: 'text.secondary',
          textStyle: 'bodyMedium',
          flexWrap: 'wrap',
        })}
      >
        <span
          aria-hidden
          className={css({
            display: 'grid',
            placeItems: 'center',
            width: '2xl',
            height: '2xl',
            borderRadius: 'pill',
            backgroundColor: 'action.selected.bg',
            color: 'brand.600',
            flexShrink: 0,
          })}
        >
          <RiUser3Line size={17} />
        </span>
        <span>{speaker}</span>
        <span aria-hidden>·</span>
        {onSeek ? (
          <button
            type="button"
            onClick={onSeek}
            aria-label={seekLabel}
            className={css({
              cursor: 'pointer',
              color: 'text.link',
              borderRadius: 'field',
              padding: 'xs',
              _hover: { backgroundColor: 'surface.canvas' },
              _focusVisible: {
                outline: '2px solid token(colors.border.focus)',
              },
            })}
          >
            {time}
          </button>
        ) : (
          <span>{time}</span>
        )}
        {isCorrected && (
          <span
            className={css({
              padding: 'xxs sm',
              borderRadius: 'control',
              backgroundColor: 'action.selected.bg',
              color: 'text.link',
              textStyle: 'labelMedium',
            })}
          >
            {t('transcriptCorrection.editedBadge')}
          </span>
        )}
        {isCorrected && (
          <button
            type="button"
            onClick={() => setShowingOriginal((value) => !value)}
            className={css({
              cursor: 'pointer',
              color: 'text.link',
              textDecoration: 'underline',
              borderRadius: 'field',
              padding: 'xxs xs',
              // 「显示/隐藏原文」此前 hover 与 focus-visible 都没有 ——
              // 键盘走到它时看不见焦点,是四条手写按钮里唯一完全没状态覆盖的一颗。
              _hover: { backgroundColor: 'surface.canvas' },
              _focusVisible: {
                outline: '2px solid token(colors.border.focus)',
              },
            })}
          >
            {t(
              showingOriginal
                ? 'transcriptCorrection.hideOriginal'
                : 'transcriptCorrection.showOriginal'
            )}
          </button>
        )}
        {!editing && onCorrect && (
          <button
            type="button"
            onClick={startEditing}
            disabled={busy}
            className={css({
              cursor: 'pointer',
              color: 'text.link',
              borderRadius: 'field',
              padding: 'xxs xs',
              _hover: { backgroundColor: 'surface.canvas' },
              _focusVisible: {
                outline: '2px solid token(colors.border.focus)',
              },
            })}
          >
            {t('transcriptCorrection.edit')}
          </button>
        )}
        {!editing && isCorrected && onRevert && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit(true)}
            className={css({
              cursor: 'pointer',
              color: 'text.link',
              borderRadius: 'field',
              padding: 'xxs xs',
              _hover: { backgroundColor: 'surface.canvas' },
              _focusVisible: {
                outline: '2px solid token(colors.border.focus)',
              },
            })}
          >
            {t('transcriptCorrection.restore')}
          </button>
        )}
      </div>

      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSave) return
            void submit()
          }}
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'sm',
          })}
        >
          <textarea
            ref={input}
            aria-label={t('transcriptCorrection.edit')}
            value={draft}
            disabled={busy}
            rows={3}
            maxLength={20_000}
            onChange={(event) => editor.update({ text: event.target.value })}
            className={css({
              width: '100%',
              border: '1px solid token(colors.border.subtle)',
              borderRadius: 'control',
              padding: 'md',
              textStyle: 'bodyLarge',
              lineHeight: 1.7,
              backgroundColor: 'transparent',
              resize: 'vertical',
            })}
          />
          <div className={css({ display: 'flex', gap: 'sm' })}>
            <Button type="submit" size="sm" isDisabled={!canSave}>
              {t(
                busy
                  ? 'transcriptCorrection.saving'
                  : 'transcriptCorrection.save'
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondaryText"
              isDisabled={busy}
              onPress={editor.reset}
            >
              {t('transcriptCorrection.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <p
          className={css({
            whiteSpace: 'pre-wrap',
            textStyle: 'bodyLarge',
            lineHeight: 1.9,
            color: 'text.primary',
          })}
        >
          {highlight ? highlightMatches(shown, highlight) : shown}
        </p>
      )}

      {(failure || editFailed) && (
        <p
          role="alert"
          className={css({ color: 'text.error', marginTop: 'sm' })}
        >
          {t(`transcriptCorrection.${failure ?? 'failed'}`)}
        </p>
      )}
    </article>
  )
}
