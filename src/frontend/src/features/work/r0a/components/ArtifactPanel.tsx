import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { RiDownloadLine, RiEyeLine, RiEyeOffLine } from '@remixicon/react'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'
import { useWorkArtifactContent } from '../api/queries'
import { workArtifactContentUrl } from '../api/client'
import { card, errorText, muted, row, sectionTitle } from '../ui'

const markdownBody = css({
  marginTop: 'sm',
  padding: 'md',
  borderRadius: 'control',
  backgroundColor: 'surface.canvas',
  textStyle: 'bodyMedium',
  lineHeight: 1.7,
  overflowWrap: 'anywhere',
  '& h1, & h2, & h3, & h4': {
    marginTop: 'md',
    marginBottom: 'xs',
    fontWeight: 'bold',
    lineHeight: 1.35,
  },
  '& h1': { textStyle: 'titleLarge' },
  '& h2': { textStyle: 'titleMedium' },
  '& p, & ul, & ol': { marginY: 'xs' },
  '& ul, & ol': { paddingLeft: 'lg' },
  '& li': { marginY: 'xxs' },
  '& code': {
    fontFamily: 'mono',
    backgroundColor: 'surface.default',
    paddingX: 'xxs',
    borderRadius: 'control',
  },
  '& pre': {
    backgroundColor: 'surface.default',
    padding: 'sm',
    borderRadius: 'control',
    overflowX: 'auto',
  },
  '& pre code': { backgroundColor: 'transparent', padding: 0 },
  '& blockquote': {
    borderLeft: '3px solid token(colors.border.subtle)',
    paddingLeft: 'sm',
    color: 'text.secondary',
    marginY: 'sm',
  },
  '& a': { color: 'text.link' },
})

const plainBody = css({
  marginTop: 'sm',
  padding: 'md',
  borderRadius: 'control',
  backgroundColor: 'surface.canvas',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: 'mono',
  textStyle: 'bodyMedium',
})

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
  artifactId: string
  versionNo: number
  contentHash: string
}

export const ArtifactPanel = ({ artifactId, versionNo, contentHash }: Props) => {
  const { t } = useTranslation('work')
  const [open, setOpen] = useState(false)
  const contentQ = useWorkArtifactContent(artifactId, versionNo, open)

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
            href={workArtifactContentUrl(artifactId, versionNo, 'attachment')}
          >
            <RiDownloadLine size={16} aria-hidden="true" />
            {t('task.downloadArtifact')}
          </a>
        </div>
      </div>
      {open ? (
        contentQ.isLoading ? (
          <p className={muted}>{t('task.artifactLoading')}</p>
        ) : contentQ.isError ? (
          <div className={css({ marginTop: 'sm' })}>
            <p className={errorText}>{t('task.artifactLoadError')}</p>
            <Button
              size="dense"
              variant="secondary"
              onPress={() => void contentQ.refetch()}
            >
              {t('retry')}
            </Button>
          </div>
        ) : !contentQ.data ? (
          <p className={muted}>{t('task.artifactLoading')}</p>
        ) : contentQ.data.mediaType === 'text/plain' ? (
          <pre className={plainBody}>{contentQ.data.text}</pre>
        ) : (
          <div className={markdownBody}>
            <ReactMarkdown>{contentQ.data.text}</ReactMarkdown>
          </div>
        )
      ) : null}
    </section>
  )
}
