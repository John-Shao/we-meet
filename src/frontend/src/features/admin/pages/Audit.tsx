import { useTranslation } from 'react-i18next'

import { PagePlaceholder } from './PagePlaceholder'

export const AdminAudit = () => {
  const { t } = useTranslation('admin')
  return (
    <PagePlaceholder title={t('audit.title')} hint={t('audit.placeholder')} />
  )
}
