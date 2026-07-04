import { useTranslation } from 'react-i18next'

import { PagePlaceholder } from './PagePlaceholder'

export const AdminMembers = () => {
  const { t } = useTranslation('admin')
  return (
    <PagePlaceholder
      title={t('members.title')}
      hint={t('members.placeholder')}
    />
  )
}
