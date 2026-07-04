import { useTranslation } from 'react-i18next'

import { PagePlaceholder } from './PagePlaceholder'

export const AdminDashboard = () => {
  const { t } = useTranslation('admin')
  return (
    <PagePlaceholder
      title={t('dashboard.title')}
      hint={t('dashboard.placeholder')}
    />
  )
}
