import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

export function OriginalSearch({
  onSearch,
}: {
  onSearch: (query: string) => void
}) {
  const { t } = useTranslation('meetings')
  const [draft, setDraft] = useState('')
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
      <label className={css({ minWidth: 0, maxWidth: '100%' })}>
        {t('library.searchOriginal')}{' '}
        <input
          type="search"
          maxLength={200}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className={css({
            border: '1px solid token(colors.greyscale.400)',
            borderRadius: '0.375rem',
            padding: '0.5rem',
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
