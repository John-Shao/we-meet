import type { CSSProperties, ReactNode } from 'react'

import { css, cx } from '@/styled-system/css'

type SkeletonProps = {
  label: string
}

type SkeletonBlockProps = {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  circle?: boolean
  className?: string
}

const SkeletonBlock = ({
  width = '100%',
  height = '0.75rem',
  circle = false,
  className,
}: SkeletonBlockProps) => (
  <span
    aria-hidden="true"
    className={cx(skeletonBlockCss, className)}
    data-circle={circle || undefined}
    style={{ width, height }}
  />
)

const LoadingRegion = ({
  label,
  className,
  children,
}: SkeletonProps & { className: string; children: ReactNode }) => (
  <div className={className} role="status" aria-label={label} aria-busy="true">
    <span className={srOnlyCss}>{label}</span>
    <div className={loadingContentCss} aria-hidden="true">
      {children}
    </div>
  </div>
)

const listWidths = ['58%', '72%', '46%', '64%', '52%', '68%', '45%', '62%']

export const TaskListSkeleton = ({
  label,
  compact = false,
  grouped = false,
}: SkeletonProps & { compact?: boolean; grouped?: boolean }) => {
  const columnCount = compact ? (grouped ? 5 : 6) : grouped ? 7 : 8
  return (
    <LoadingRegion
      label={label}
      className={cx(listSkeletonCss, compact && compactListSkeletonCss)}
    >
      <div
        className={listHeaderCss}
        data-compact={compact || undefined}
        data-grouped={grouped || undefined}
      >
        {Array.from({ length: columnCount }, (_, index) => (
          <SkeletonBlock
            key={index}
            width={listWidths[index]}
            height="0.625rem"
          />
        ))}
      </div>
      {Array.from({ length: 7 }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className={listRowCss}
          data-compact={compact || undefined}
          data-grouped={grouped || undefined}
        >
          <span className={listTitleCellCss}>
            <SkeletonBlock width="1rem" height="1rem" circle />
            <SkeletonBlock
              width={`${52 + ((rowIndex * 11) % 34)}%`}
              height="0.75rem"
            />
          </span>
          <SkeletonBlock width="70%" />
          <SkeletonBlock width="2rem" height="1rem" />
          <SkeletonBlock width="62%" />
          <SkeletonBlock width="66%" />
          {!grouped && <SkeletonBlock width="72%" />}
          {!compact && (
            <>
              <SkeletonBlock width="64%" />
              <SkeletonBlock width="76%" />
            </>
          )}
        </div>
      ))}
    </LoadingRegion>
  )
}

export const TaskBoardSkeleton = ({ label }: SkeletonProps) => (
  <LoadingRegion label={label} className={boardSkeletonCss}>
    {Array.from({ length: 2 }, (_, columnIndex) => (
      <section key={columnIndex} className={boardColumnCss}>
        <span className={boardHeadingCss}>
          <SkeletonBlock width="46%" />
          <SkeletonBlock width="1.25rem" height="1rem" />
        </span>
        {Array.from({ length: columnIndex % 2 ? 2 : 3 }, (_, cardIndex) => (
          <div key={cardIndex} className={boardCardCss}>
            <SkeletonBlock width={`${68 + cardIndex * 8}%`} height="0.875rem" />
            <SkeletonBlock width="42%" height="0.625rem" />
            <span className={boardCardMetaCss}>
              <SkeletonBlock width="2.25rem" height="1rem" />
              <SkeletonBlock width="1.25rem" height="1.25rem" circle />
            </span>
          </div>
        ))}
      </section>
    ))}
  </LoadingRegion>
)

export const TaskDetailSkeleton = ({ label }: SkeletonProps) => (
  <LoadingRegion label={label} className={detailSkeletonCss}>
    <span className={detailTitleCss}>
      <SkeletonBlock width="1.25rem" height="1.25rem" circle />
      <SkeletonBlock width="68%" height="1.125rem" />
    </span>
    <SkeletonBlock width="42%" height="0.625rem" />
    <div className={propertySkeletonCss}>
      {Array.from({ length: 3 }, (_, groupIndex) => (
        <div key={groupIndex} className={propertyGroupSkeletonCss}>
          <SkeletonBlock width="4.5rem" height="0.625rem" />
          {Array.from({ length: groupIndex === 2 ? 2 : 3 }, (_, rowIndex) => (
            <span key={rowIndex} className={propertyRowSkeletonCss}>
              <SkeletonBlock width="1rem" height="1rem" circle />
              <SkeletonBlock width="4.75rem" />
              <SkeletonBlock
                width={`${48 + ((groupIndex + rowIndex) % 3) * 14}%`}
              />
            </span>
          ))}
        </div>
      ))}
    </div>
    <div className={detailSectionSkeletonCss}>
      <SkeletonBlock width="4rem" height="0.75rem" />
      <TaskSubtaskListSkeleton label={label} announce={false} />
    </div>
    <div className={detailSectionSkeletonCss}>
      <SkeletonBlock width="3.5rem" height="0.75rem" />
      <TaskCommentListSkeleton label={label} announce={false} rows={1} />
    </div>
  </LoadingRegion>
)

export const TaskSubtaskListSkeleton = ({
  label,
  announce = true,
  rows = 3,
}: SkeletonProps & { announce?: boolean; rows?: number }) => {
  const content = (
    <div className={subtaskSkeletonCss}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={subtaskRowSkeletonCss}>
          <SkeletonBlock width="1rem" height="1rem" circle />
          <SkeletonBlock width={`${55 + index * 9}%`} />
          <SkeletonBlock width="3.5rem" height="0.625rem" />
          <SkeletonBlock width="1.25rem" height="1.25rem" circle />
        </div>
      ))}
    </div>
  )
  return announce ? (
    <LoadingRegion label={label} className={inlineSkeletonRegionCss}>
      {content}
    </LoadingRegion>
  ) : (
    content
  )
}

export const TaskCommentListSkeleton = ({
  label,
  announce = true,
  rows = 2,
}: SkeletonProps & { announce?: boolean; rows?: number }) => {
  const content = (
    <div className={cardListSkeletonCss}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={commentCardSkeletonCss}>
          <span className={commentMetaSkeletonCss}>
            <SkeletonBlock width="1.25rem" height="1.25rem" circle />
            <SkeletonBlock width="5rem" height="0.625rem" />
            <SkeletonBlock width="4.5rem" height="0.625rem" />
          </span>
          <SkeletonBlock width={`${82 - index * 13}%`} />
          <SkeletonBlock width={`${56 + index * 8}%`} />
        </div>
      ))}
    </div>
  )
  return announce ? (
    <LoadingRegion label={label} className={inlineSkeletonRegionCss}>
      {content}
    </LoadingRegion>
  ) : (
    content
  )
}

export const TaskAttachmentListSkeleton = ({ label }: SkeletonProps) => (
  <LoadingRegion label={label} className={inlineSkeletonRegionCss}>
    <div className={cardListSkeletonCss}>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className={attachmentCardSkeletonCss}>
          <SkeletonBlock width={`${64 + index * 11}%`} height="0.75rem" />
          <span className={attachmentMetaSkeletonCss}>
            <SkeletonBlock width="1.25rem" height="1.25rem" circle />
            <SkeletonBlock width="55%" height="0.625rem" />
          </span>
        </div>
      ))}
    </div>
  </LoadingRegion>
)

export const TaskHistoryListSkeleton = ({ label }: SkeletonProps) => (
  <LoadingRegion label={label} className={inlineSkeletonRegionCss}>
    <div className={historyListSkeletonCss}>
      {Array.from({ length: 3 }, (_, index) => (
        <span key={index} className={historyRowSkeletonCss}>
          <SkeletonBlock width="1.25rem" height="1.25rem" circle />
          <SkeletonBlock width={`${70 - index * 8}%`} />
          <SkeletonBlock width="4rem" height="0.625rem" />
        </span>
      ))}
    </div>
  </LoadingRegion>
)

const skeletonBlockCss = css({
  display: 'block',
  flexShrink: 0,
  borderRadius: '4px',
  backgroundColor: 'greyscale.200',
  animation: 'task-skeleton-pulse 900ms ease-in-out infinite alternate',
  '&[data-circle]': { borderRadius: '999px' },
})
const srOnlyCss = css({
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
})
const loadingContentCss = css({ display: 'contents' })
const listSkeletonCss = css({ minWidth: '58rem', color: 'transparent' })
const compactListSkeletonCss = css({ minWidth: '48rem' })
const listGridColumns =
  'minmax(16rem, 2.5fr) minmax(7rem, 1fr) 5rem 6rem 6rem minmax(7rem, 1fr) minmax(7rem, 1fr) minmax(8rem, 1fr)'
const compactListGridColumns =
  'minmax(15rem, 2.5fr) minmax(7rem, 1fr) 5rem 6rem 6rem minmax(7rem, 1fr)'
const compactGroupedListGridColumns =
  'minmax(15rem, 2.5fr) minmax(7rem, 1fr) 5rem 6rem 6rem'
const groupedListGridColumns =
  'minmax(16rem, 2.5fr) minmax(7rem, 1fr) 5rem 6rem 6rem minmax(7rem, 1fr) minmax(8rem, 1fr)'
const listHeaderCss = css({
  minHeight: '2.25rem',
  display: 'grid',
  gridTemplateColumns: listGridColumns,
  alignItems: 'center',
  gap: '1.5rem',
  paddingX: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.50',
  '&[data-compact]': { gridTemplateColumns: compactListGridColumns },
  '&[data-grouped]': { gridTemplateColumns: groupedListGridColumns },
  '&[data-compact][data-grouped]': {
    gridTemplateColumns: compactGroupedListGridColumns,
  },
})
const listRowCss = css({
  minHeight: '2.625rem',
  display: 'grid',
  gridTemplateColumns: listGridColumns,
  alignItems: 'center',
  gap: '1.5rem',
  paddingX: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '&[data-compact]': { gridTemplateColumns: compactListGridColumns },
  '&[data-grouped]': { gridTemplateColumns: groupedListGridColumns },
  '&[data-compact][data-grouped]': {
    gridTemplateColumns: compactGroupedListGridColumns,
  },
})
const listTitleCellCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
})
const boardSkeletonCss = css({
  minWidth: '44rem',
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(20rem, 1fr))',
  gap: '0.75rem',
  padding: '1rem',
})
const boardColumnCss = css({
  minHeight: '18rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.75rem',
  borderRadius: '8px',
  backgroundColor: 'greyscale.50',
})
const boardHeadingCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '0.125rem',
})
const boardCardCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.000',
})
const boardCardMetaCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
})
const detailSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1.25rem 1.25rem 1.5rem',
})
const detailTitleCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
})
const propertySkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})
const propertyGroupSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  paddingTop: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const propertyRowSkeletonCss = css({
  minHeight: '2rem',
  display: 'grid',
  gridTemplateColumns: '1.5rem 5.5rem minmax(0, 1fr)',
  alignItems: 'center',
  gap: '0.5rem',
})
const detailSectionSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  paddingTop: '1rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})
const inlineSkeletonRegionCss = css({ width: '100%' })
const subtaskSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
})
const subtaskRowSkeletonCss = css({
  minHeight: '2rem',
  display: 'grid',
  gridTemplateColumns: '1rem minmax(5rem, 1fr) auto 1.25rem',
  alignItems: 'center',
  gap: '0.5rem',
  paddingX: '0.5rem',
})
const cardListSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
})
const commentCardSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.50',
})
const commentMetaSkeletonCss = css({
  display: 'grid',
  gridTemplateColumns: '1.25rem 1fr auto',
  alignItems: 'center',
  gap: '0.5rem',
})
const attachmentCardSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'greyscale.50',
})
const attachmentMetaSkeletonCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
})
const historyListSkeletonCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})
const historyRowSkeletonCss = css({
  display: 'grid',
  gridTemplateColumns: '1.25rem minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: '0.5rem',
})
