import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams, useSearchParams } from 'wouter'
import {
  RiArrowLeftLine,
  RiCheckLine,
  RiDownloadLine,
  RiRefreshLine,
} from '@remixicon/react'

import { PageState } from '@/components/PageState'
import { Button } from '@/primitives/Button'
import { css, cx } from '@/styled-system/css'
import { workTaskArtifactContentUrl } from '../api/client'
import {
  useAcceptWorkTask,
  useWorkArtifactContent,
  useWorkArtifactWorkspace,
} from '../api/queries'
import { useIdempotencyKey } from '../hooks/useIdempotencyKey'
import { useReadOnlyViewport } from '../hooks/useReadOnlyViewport'
import { ArtifactPreview } from '../components/ArtifactPreview'
import { TaskStatusBadge } from '../components/TaskStatusBadge'
import { card, errorText, muted, notice, page, row, sectionTitle } from '../ui'

const downloadLink = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'xxs',
  color: 'text.link',
  textStyle: 'bodyMedium',
  fontWeight: 'semibold',
  textDecoration: 'none',
  paddingX: 'sm',
  paddingY: 'xs',
  borderRadius: 'control',
  _hover: { backgroundColor: 'surface.canvas' },
})

const versionList = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  marginTop: 'sm',
  display: 'flex',
  flexDirection: 'column',
  gap: 'xxs',
})

const versionButton = css({
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'sm',
  paddingX: 'sm',
  paddingY: 'xs',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  backgroundColor: 'surface.default',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: { backgroundColor: 'surface.canvas' },
})

const versionButtonActive = css({
  borderColor: 'border.strong',
  backgroundColor: 'surface.canvas',
  fontWeight: 'semibold',
})

const acceptedBadge = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'xxs',
  color: 'status.success.container-text',
  textStyle: 'bodyMedium',
  fontWeight: 'semibold',
})

export const ArtifactWorkspacePage = () => {
  const { t } = useTranslation('work')
  const { taskId, artifactId } = useParams<{
    taskId: string
    artifactId: string
  }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const workspaceQ = useWorkArtifactWorkspace(taskId, artifactId)
  const readOnly = useReadOnlyViewport()
  const acceptMutation = useAcceptWorkTask(taskId ?? '')
  const acceptKey = useIdempotencyKey()
  const [actionError, setActionError] = useState<string | null>(null)

  const versions = workspaceQ.data?.artifact.versions ?? []
  const requestedVersion = Number(searchParams.get('version'))
  const selected =
    versions.find((version) => version.version_no === requestedVersion) ??
    versions[0]
  const versionFallback =
    requestedVersion > 0 &&
    !versions.some((version) => version.version_no === requestedVersion)
  const selectedVersionNo = selected?.version_no
  const contentQ = useWorkArtifactContent(
    taskId,
    artifactId,
    selectedVersionNo,
    !!selected
  )

  if (workspaceQ.isLoading) {
    return (
      <div className={page}>
        <p className={muted}>{t('loading')}</p>
      </div>
    )
  }
  if (workspaceQ.isError || !workspaceQ.data || !selected) {
    return (
      <div className={page}>
        <PageState
          state="error"
          icon={<RiRefreshLine size={20} aria-hidden="true" />}
          title={t('artifact.loadErrorTitle')}
          description={t('artifact.loadErrorDescription')}
          action={
            <div className={row}>
              <Link
                href={
                  taskId
                    ? `/work/items/${encodeURIComponent(taskId)}`
                    : '/work/items?view=all'
                }
              >
                <Button variant="secondary" size="dense">
                  {t('artifact.backToTask')}
                </Button>
              </Link>
              <Button
                variant="secondary"
                size="dense"
                onPress={() => void workspaceQ.refetch()}
              >
                {t('retry')}
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  const { summary, artifact } = workspaceQ.data
  const acceptedVersionNo = artifact.accepted_version_no
  const canAccept =
    !readOnly &&
    summary.task_state === 'awaiting_acceptance' &&
    acceptedVersionNo !== selected.version_no

  const selectVersion = (versionNo: number) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('version', String(versionNo))
        return next
      },
      { replace: true }
    )
  }

  const acceptVersion = async () => {
    setActionError(null)
    try {
      await acceptMutation.mutateAsync({
        client_request_id: acceptKey.key,
        expected_revision: summary.revision,
        artifact_id: artifact.artifact_id,
        version_no: selected.version_no,
      })
      acceptKey.rotate()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={page}>
      <div
        className={css({ display: 'flex', flexDirection: 'column', gap: 'sm' })}
      >
        <Link
          href={`/work/items/${encodeURIComponent(taskId!)}`}
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'xxs',
            color: 'text.secondary',
            textDecoration: 'none',
            textStyle: 'bodyMedium',
            alignSelf: 'flex-start',
          })}
        >
          <RiArrowLeftLine size={14} aria-hidden="true" />
          {t('artifact.backToTask')}
        </Link>
        {readOnly ? (
          <p className={notice} role="status">
            {t('artifact.readOnly')}
          </p>
        ) : null}
        <div
          className={css({
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'sm',
            flexWrap: 'wrap',
          })}
        >
          <div
            className={css({
              flex: 1,
              minWidth: '16rem',
              display: 'flex',
              flexDirection: 'column',
              gap: 'xs',
            })}
          >
            <span className={muted}>{t('artifact.workspaceTitle')}</span>
            <h1 className={css({ margin: 0, textStyle: 'titleLarge' })}>
              {summary.title}
            </h1>
            <div className={row}>
              <TaskStatusBadge state={summary.display_state} />
              <span className={muted}>
                {t('artifact.versionBadge', { version: selected.version_no })}
              </span>
              {acceptedVersionNo === selected.version_no ? (
                <span className={acceptedBadge}>
                  <RiCheckLine size={16} aria-hidden="true" />
                  {t('artifact.acceptedBadge')}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {actionError ? <p className={errorText}>{actionError}</p> : null}
      </div>

      <div
        className={css({
          display: 'grid',
          gap: 'lg',
          gridTemplateColumns: {
            base: '1fr',
            lg: 'minmax(0, 1.4fr) minmax(18rem, 0.6fr)',
          },
        })}
      >
        <section className={card}>
          <div
            className={css({
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 'sm',
              flexWrap: 'wrap',
            })}
          >
            <h2 className={sectionTitle}>{t('artifact.preview')}</h2>
            <a
              className={downloadLink}
              href={workTaskArtifactContentUrl(
                taskId!,
                artifact.artifact_id,
                selected.version_no,
                'attachment'
              )}
            >
              <RiDownloadLine size={16} aria-hidden="true" />
              {t('artifact.download')}
            </a>
          </div>
          {versionFallback ? (
            <p className={notice} role="status">
              {t('artifact.versionFallback')}
            </p>
          ) : null}
          <p className={muted}>
            {t('artifact.versionMeta', {
              version: selected.version_no,
              hash: selected.content_hash.slice(0, 16),
              bytes: selected.bytes,
            })}
          </p>
          {contentQ.isLoading ? (
            <p className={muted}>{t('artifact.contentLoading')}</p>
          ) : contentQ.isError ? (
            <div className={css({ marginTop: 'sm' })}>
              <p className={errorText}>{t('artifact.contentLoadError')}</p>
              <Button
                size="dense"
                variant="secondary"
                onPress={() => void contentQ.refetch()}
              >
                {t('retry')}
              </Button>
            </div>
          ) : contentQ.data ? (
            <ArtifactPreview
              text={contentQ.data.text}
              mediaType={contentQ.data.mediaType}
            />
          ) : null}
        </section>

        <aside
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: 'lg',
            minWidth: 0,
          })}
        >
          <section className={card}>
            <h2 className={sectionTitle}>{t('artifact.versionList')}</h2>
            <ul className={versionList}>
              {versions.map((version) => (
                <li key={version.version_no}>
                  <button
                    type="button"
                    className={cx(
                      versionButton,
                      version.version_no === selected.version_no
                        ? versionButtonActive
                        : ''
                    )}
                    aria-pressed={version.version_no === selected.version_no}
                    aria-label={t('artifact.selectVersion', {
                      version: version.version_no,
                    })}
                    onClick={() => selectVersion(version.version_no)}
                  >
                    <span
                      className={css({
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'xxs',
                      })}
                    >
                      <span>
                        {t('artifact.versionBadge', {
                          version: version.version_no,
                        })}
                      </span>
                      <span className={muted}>
                        {t('artifact.versionMeta', {
                          version: version.version_no,
                          hash: version.content_hash.slice(0, 12),
                          bytes: version.bytes,
                        })}
                      </span>
                      <span className={muted}>
                        {new Date(
                          version.published_at ?? version.created_at
                        ).toLocaleString()}
                      </span>
                    </span>
                    {acceptedVersionNo === version.version_no ? (
                      <span className={acceptedBadge}>
                        <RiCheckLine size={16} aria-hidden="true" />
                        {t('artifact.acceptedBadge')}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {canAccept ? (
            <section className={card}>
              <h2 className={sectionTitle}>{t('artifact.acceptTitle')}</h2>
              <p className={muted}>{t('artifact.acceptHint')}</p>
              <Button
                size="dense"
                className={css({ marginTop: 'sm' })}
                loading={acceptMutation.isPending}
                onPress={() => void acceptVersion()}
              >
                {t('artifact.confirmAccept', {
                  version: selected.version_no,
                })}
              </Button>
            </section>
          ) : acceptedVersionNo === selected.version_no ? (
            <section className={card}>
              <h2 className={sectionTitle}>{t('artifact.acceptTitle')}</h2>
              <p className={acceptedBadge}>
                <RiCheckLine size={16} aria-hidden="true" />
                {t('artifact.acceptedNotice', {
                  version: acceptedVersionNo,
                })}
              </p>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
