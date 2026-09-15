import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import { css } from '@/styled-system/css'

/** Reference the shared after-meeting workspaces from the meeting lobby. */
export function MeetingMaterialsLinks() {
  const { t } = useTranslation('meetings')
  return (
    <section
      className={css({
        borderTop: '1px solid',
        borderColor: 'greyscale.200',
        paddingTop: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      })}
    >
      <h2 className={css({ fontWeight: '600' })}>{t('materials.title')}</h2>
      <p className={css({ color: 'greyscale.600', fontSize: '0.875rem' })}>
        {t('materials.hint')}
      </p>
      <div
        className={css({
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1.5rem',
          color: 'primary.700',
        })}
      >
        <Link href="/meeting/notes">{t('library.notes')}</Link>
        <Link href="/meeting/minutes">{t('library.minutes')}</Link>
      </div>
    </section>
  )
}
