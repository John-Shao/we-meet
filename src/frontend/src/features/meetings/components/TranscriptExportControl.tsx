import { useTranslation } from 'react-i18next'
import { Menu as AriaMenu, MenuItem } from 'react-aria-components'
import { RiArrowDownSLine, RiDownloadLine } from '@remixicon/react'
import { apiUrl } from '@/api/apiUrl'
import { Button } from '@/primitives'
import { Menu } from '@/primitives/Menu'
import { menuRecipe } from '@/primitives/menuRecipe'
import { css, cx } from '@/styled-system/css'

const FORMATS = ['TXT', 'SRT', 'VTT'] as const

/** Native download links preserve streaming and server export permissions. */
export function TranscriptExportControl({ recordId }: { recordId: string }) {
  const { t } = useTranslation('meetings')
  const classes = menuRecipe({ variant: 'light' })
  return (
    <Menu placement="bottom">
      <Button
        size="sm"
        variant="secondaryText"
        icon={<RiDownloadLine size={16} aria-hidden />}
        aria-label={t('transcriptExport.label')}
      >
        {t('transcriptToolbar.export')}
        <RiArrowDownSLine size={16} aria-hidden />
      </Button>
      <AriaMenu
        className={classes.root}
        aria-label={t('transcriptExport.label')}
      >
        {FORMATS.map((format) => (
          <MenuItem
            key={format}
            id={format}
            textValue={format}
            className={cx(
              classes.item,
              css({
                display: 'block',
                textStyle: 'labelLarge',
                paddingX: 'md',
                paddingY: 'sm',
                textDecoration: 'none',
              })
            )}
            href={apiUrl(
              `meeting-records/${encodeURIComponent(recordId)}/transcript-export/?as=${format.toLowerCase()}`
            )}
            download
            aria-label={t('transcriptExport.download', { format })}
          >
            {format}
          </MenuItem>
        ))}
      </AriaMenu>
    </Menu>
  )
}
