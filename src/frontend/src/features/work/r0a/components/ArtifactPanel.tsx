import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'
import {
  RiArrowRightLine,
  RiDownloadLine,
  RiEyeLine,
  RiEyeOffLine,
} from '@remixicon/react'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'
import { useWorkArtifactContent } from '../api/queries'
import { workTaskArtifactContentUrl } from '../api/client'
import { card, errorText, muted, row, sectionTitle } from '../ui'
import { ArtifactPreview } from './ArtifactPreview'

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

type Props = {
  taskId: string
  artifactId: string
  versionNo: number
  contentHash: string
  readOnly?: boolean
}

export const ArtifactPanel = ({
  taskId,
  artifactId,
  versionNo,
  contentHash,
  readOnly = false,
}: Props) => {
  const { t } = useTranslation('work')
  const [open, setOpen] = useState(false)
  const contentQ = useWorkArtifactContent(taskId, artifactId, versionNo, open)

  return (
    <section className={card}>
      <h2 className={sectionTitle}>{t('task.latestArtifact')}</h2>
      <p className={muted}>
        {t('task.artifactDetail', {
          version: versionNo,
          hash: contentHash.slice(0, 16),
        })}
      </p>
      <div className={css({ marginTop: 'sm' })}>
        <div className={row}>
          <Button
            size="dense"
            variant="secondary"
            icon={
              open ? (
                <RiEyeOffLine size={16} aria-hidden="true" />
              ) : (
                <RiEyeLine size={16} aria-hidden="true" />
              )
            }
            onPress={() => setOpen((value) => !value)}
          >
            {open ? t('task.hideArtifact') : t('task.viewArtifact')}
          </Button>
          <a
            className={downloadLink}
            href={workTaskArtifactContentUrl(
              taskId,
              artifactId,
              versionNo,
              'attachment'
            )}
          >
            <RiDownloadLine size={16} aria-hidden="true" />
            {t('task.downloadArtifact')}
          </a>
        </div>
        <Link
          href={`/work/items/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}?version=${versionNo}`}
          className={downloadLink}
        >
          <RiArrowRightLine size={16} aria-hidden="true" />
          {t('artifact.openWorkspace')}
        </Link>
      </div>
      {open ? (
        contentQ.isLoading ? (
          <p className={muted}>{t('task.artifactLoading')}</p>
        ) : contentQ.isError ? (
          <div className={css({ marginTop: 'sm' })}>
            <p className={errorText}>{t('task.artifactLoadError')}</p>
            {readOnly ? null : (
              <Button
                size="dense"
                variant="secondary"
                onPress={() => void contentQ.refetch()}
              >
                {t('retry')}
              </Button>
            )}
          </div>
        ) : !contentQ.data ? (
          <p className={muted}>{t('task.artifactLoading')}</p>
        ) : (
          <ArtifactPreview
            text={contentQ.data.text}
            mediaType={contentQ.data.mediaType}
          />
        )
      ) : null}
    </section>
  )
}
