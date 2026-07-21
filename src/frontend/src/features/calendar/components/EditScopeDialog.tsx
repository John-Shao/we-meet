import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'
import { Modal } from '@/components/Modal'

import type { EditScope } from '../api/ApiCalendar'

/**
 * P2-M2 重复日程三选弹窗(编辑/删除共用):单选 仅此场次 / 此场次及以后 /
 * 所有场次(删除不提供「所有」——主事件的删除入口已有系列确认)。
 * 弹窗本身即确认步骤,确认后不再二次 confirm。
 */
export const EditScopeDialog = ({
  title,
  options,
  danger,
  onConfirm,
  onClose,
}: {
  title: string
  options: EditScope[]
  /** 删除场景:确认键红色。 */
  danger?: boolean
  onConfirm: (scope: EditScope) => void
  onClose: () => void
}) => {
  const { t } = useTranslation('calendar')
  const [scope, setScope] = useState<EditScope>(options[0])

  return (
    <Modal onClose={onClose} ariaLabel={title} maxWidth="360px">
      <div className={css({ padding: '1.25rem' })}>
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {title}
        </h2>
        <div
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.625rem',
            marginTop: '1rem',
          })}
        >
          {options.map((option) => (
            <label
              key={option}
              className={css({
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                color: 'greyscale.800',
                cursor: 'pointer',
              })}
            >
              <input
                type="radio"
                name="edit-scope"
                checked={scope === option}
                onChange={() => setScope(option)}
                data-testid={`scope-${option}`}
              />
              {t(`scope.${option}`)}
            </label>
          ))}
        </div>
        <div
          className={css({
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
            marginTop: '1.25rem',
          })}
        >
          <button
            type="button"
            onClick={onClose}
            className={scopeBtn}
          >
            {t('form.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(scope)}
            data-testid="scope-confirm"
            className={cx(
              scopeBtn,
              css({
                backgroundColor: danger ? 'danger.600' : 'primary.500',
                borderColor: danger ? 'danger.600' : 'primary.500',
                color: 'white',
              })
            )}
          >
            {t('form.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

const scopeBtn = css({
  paddingX: '0.875rem',
  paddingY: '0.4375rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  cursor: 'pointer',
})
