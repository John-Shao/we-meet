import { Skeleton, SkeletonRegion } from '@/primitives'
import { css, cx } from '@/styled-system/css'

type SkeletonProps = {
  label: string
}

const listWidths = ['58%', '72%', '46%', '64%', '52%', '68%', '45%', '62%']

export const TaskListSkeleton = ({
  label,
  compact = false,
  grouped = false,
}: SkeletonProps & { compact?: boolean; grouped?: boolean }) => {
  const columnCount = compact ? (grouped ? 5 : 6) : grouped ? 7 : 8
  return (
    <SkeletonRegion
      label={label}
      className={cx(listSkeletonCss, compact && compactListSkeletonCss)}
    >
      <div
        className={listHeaderCss}
        data-compact={compact || undefined}
        data-grouped={grouped || undefined}
      >
        {Array.from({ length: columnCount }, (_, index) => (
          <Skeleton key={index} width={listWidths[index]} height="0.625rem" />
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
            <Skeleton width="1rem" height="1rem" shape="circle" />
            <Skeleton
              width={`${52 + ((rowIndex * 11) % 34)}%`}
              height="0.75rem"
            />
          </span>
          <Skeleton width="70%" />
          <Skeleton width="2rem" height="1rem" shape="rectangle" />
          <Skeleton width="62%" />
          <Skeleton width="66%" />
          {!grouped && <Skeleton width="72%" />}
          {!compact && (
            <>
              <Skeleton width="64%" />
              <Skeleton width="76%" />
            </>
          )}
        </div>
      ))}
    </SkeletonRegion>
  )
}

export const TaskBoardSkeleton = ({ label }: SkeletonProps) => (
  <SkeletonRegion label={label} className={boardSkeletonCss}>
    {Array.from({ length: 2 }, (_, columnIndex) => (
      <section key={columnIndex} className={boardColumnCss}>
        <span className={boardHeadingCss}>
          <Skeleton width="46%" />
          <Skeleton width="1.25rem" height="1rem" shape="rectangle" />
        </span>
        {Array.from({ length: columnIndex % 2 ? 2 : 3 }, (_, cardIndex) => (
          <div key={cardIndex} className={boardCardCss}>
            <Skeleton width={`${68 + cardIndex * 8}%`} height="0.875rem" />
            <Skeleton width="42%" height="0.625rem" />
            <span className={boardCardMetaCss}>
              <Skeleton width="2.25rem" height="1rem" shape="rectangle" />
              <Skeleton width="1.25rem" height="1.25rem" shape="circle" />
            </span>
          </div>
        ))}
      </section>
    ))}
  </SkeletonRegion>
)

export const TaskDetailSkeleton = ({ label }: SkeletonProps) => (
  <SkeletonRegion label={label} className={detailSkeletonCss}>
    <span className={detailTitleCss}>
      <Skeleton width="1.25rem" height="1.25rem" shape="circle" />
      <Skeleton width="68%" height="1.125rem" />
    </span>
    <Skeleton width="42%" height="0.625rem" />
    <div className={propertySkeletonCss}>
      {Array.from({ length: 3 }, (_, groupIndex) => (
        <div key={groupIndex} className={propertyGroupSkeletonCss}>
          <Skeleton width="4.5rem" height="0.625rem" />
          {Array.from({ length: groupIndex === 2 ? 2 : 3 }, (_, rowIndex) => (
            <span key={rowIndex} className={propertyRowSkeletonCss}>
              <Skeleton width="1rem" height="1rem" shape="circle" />
              <Skeleton width="4.75rem" />
              <Skeleton width={`${48 + ((groupIndex + rowIndex) % 3) * 14}%`} />
            </span>
          ))}
        </div>
      ))}
    </div>
    <div className={detailSectionSkeletonCss}>
      <Skeleton width="4rem" height="0.75rem" />
      <TaskSubtaskListSkeleton label={label} announce={false} />
    </div>
    <div className={detailSectionSkeletonCss}>
      <Skeleton width="3.5rem" height="0.75rem" />
      <TaskCommentListSkeleton label={label} announce={false} rows={1} />
    </div>
  </SkeletonRegion>
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
          <Skeleton width="1rem" height="1rem" shape="circle" />
          <Skeleton width={`${55 + index * 9}%`} />
          <Skeleton width="3.5rem" height="0.625rem" />
          <Skeleton width="1.25rem" height="1.25rem" shape="circle" />
        </div>
      ))}
    </div>
  )
  return announce ? (
    <SkeletonRegion label={label} className={inlineSkeletonRegionCss}>
      {content}
    </SkeletonRegion>
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
            <Skeleton width="1.25rem" height="1.25rem" shape="circle" />
            <Skeleton width="5rem" height="0.625rem" />
            <Skeleton width="4.5rem" height="0.625rem" />
          </span>
          <Skeleton width={`${82 - index * 13}%`} />
          <Skeleton width={`${56 + index * 8}%`} />
        </div>
      ))}
    </div>
  )
  return announce ? (
    <SkeletonRegion label={label} className={inlineSkeletonRegionCss}>
      {content}
    </SkeletonRegion>
  ) : (
    content
  )
}

export const TaskAttachmentListSkeleton = ({ label }: SkeletonProps) => (
  <SkeletonRegion label={label} className={inlineSkeletonRegionCss}>
    <div className={cardListSkeletonCss}>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className={attachmentCardSkeletonCss}>
          <Skeleton width={`${64 + index * 11}%`} height="0.75rem" />
          <span className={attachmentMetaSkeletonCss}>
            <Skeleton width="1.25rem" height="1.25rem" shape="circle" />
            <Skeleton width="55%" height="0.625rem" />
          </span>
        </div>
      ))}
    </div>
  </SkeletonRegion>
)

export const TaskHistoryListSkeleton = ({ label }: SkeletonProps) => (
  <SkeletonRegion label={label} className={inlineSkeletonRegionCss}>
    <div className={historyListSkeletonCss}>
      {Array.from({ length: 3 }, (_, index) => (
        <span key={index} className={historyRowSkeletonCss}>
          <Skeleton width="1.25rem" height="1.25rem" shape="circle" />
          <Skeleton width={`${70 - index * 8}%`} />
          <Skeleton width="4rem" height="0.625rem" />
        </span>
      ))}
    </div>
  </SkeletonRegion>
)
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
  borderBottom: '1px solid token(colors.border.subtle)',
  backgroundColor: 'surface.canvas',
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
  borderBottom: '1px solid token(colors.border.subtle)',
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
  borderRadius: 'card',
  backgroundColor: 'surface.canvas',
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
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  backgroundColor: 'surface.default',
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
  borderTop: '1px solid token(colors.border.subtle)',
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
  borderTop: '1px solid token(colors.border.subtle)',
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
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  backgroundColor: 'surface.canvas',
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
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'card',
  backgroundColor: 'surface.canvas',
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
