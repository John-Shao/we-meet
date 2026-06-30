import { useTranslation } from 'react-i18next'
import type { ConnectionState } from '@jusi/light-im-sdk'

import { css } from '@/styled-system/css'

const stateColors: Record<ConnectionState, string> = {
  disconnected: 'greyscale.200',
  connecting: 'primary.100',
  connected: 'success.100',
  reconnecting: 'warning.100',
  auth_failed: 'danger.100',
}

export const ConnectionStatusBar = ({ state }: { state: ConnectionState }) => {
  const { t } = useTranslation('im')
  return (
    <div
      className={css({
        paddingX: '1rem',
        paddingY: '0.5rem',
        backgroundColor: stateColors[state] ?? 'greyscale.100',
        borderBottom: '1px solid token(colors.greyscale.200)',
        fontSize: '0.875rem',
        color: 'greyscale.800',
      })}
      data-testid="im-connection-status"
    >
      {t(`connection.${state}`)}
    </div>
  )
}
