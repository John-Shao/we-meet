import { useTranslation } from 'react-i18next'

import { PagePlaceholder } from './PagePlaceholder'

export const AdminOrg = () => {
  const { t } = useTranslation('admin')
  return <PagePlaceholder title={t('org.title')} hint={t('org.placeholder')} />
}
