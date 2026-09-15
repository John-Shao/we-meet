import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

export function OriginalSearch({
  onSearch,
  initialQuery = '',
}: {
  onSearch: (query: string) => void
  initialQuery?: string
}) {
  const { t } = useTranslation('meetings')
  const [draft, setDraft] = useState(initialQuery)
  return (
    <form
      className={css({
        display: 'flex',
        gap: '0.5rem',
        flexWrap: 'wrap',
        margin: '0.75rem 0',
        alignItems: 'center',
      })}
      onSubmit={(event) => {
        event.preventDefault()
        onSearch(draft.trim())
      }}
    >
      <label
        className={css({ minWidth: 0, maxWidth: '100%', flex: '1 1 12rem' })}
      >
        <input
          aria-label={t('library.searchOriginal')}
          placeholder={t('library.searchOriginal')}
          type="search"
          maxLength={200}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (!event.target.value) onSearch('')
          }}
          className={css({
            border: '1px solid token(colors.greyscale.200)',
            borderRadius: '0.75rem',
            padding: '0.625rem 0.75rem',
            width: '100%',
            maxWidth: '100%',
            backgroundColor: 'transparent',
          })}
        />
      </label>
      <Button type="submit" variant="secondary">
        {t('library.searchButton')}
      </Button>
      {draft && (
        <Button
          variant="tertiary"
          onPress={() => {
            setDraft('')
            onSearch('')
          }}
        >
          {t('library.clearSearch')}
        </Button>
      )}
    </form>
  )
}
