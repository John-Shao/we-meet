import { css } from '@/styled-system/css'

/**
 * Shared M 端 page scaffold used while a module's real UI is still being built
 * (M0). Each milestone (M1–M4) replaces its page's body with the real content.
 */
export const PagePlaceholder = ({
  title,
  hint,
}: {
  title: string
  hint: string
}) => (
  <div className={css({ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' })}>
    <h1 className={css({ fontSize: '1.25rem', fontWeight: 'bold', color: 'greyscale.900' })}>
      {title}
    </h1>
    <p className={css({ color: 'greyscale.500', fontSize: '0.9375rem' })}>{hint}</p>
  </div>
)
