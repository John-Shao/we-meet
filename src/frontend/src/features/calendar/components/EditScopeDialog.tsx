import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RadioGroup } from 'react-aria-components'

import { css } from '@/styled-system/css'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives'
import { Radio } from '@/primitives/Radio'

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
      <ModalHeader
        title={title}
        onClose={onClose}
        closeLabel={t('form.cancel')}
      />
      <ModalBody>
        <RadioGroup
          aria-label={title}
          value={scope}
          onChange={(v) => setScope(v as EditScope)}
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.625rem',
          })}
        >
          {options.map((option) => (
            <Radio
              key={option}
              value={option}
              data-testid={`scope-${option}`}
              className={css({
                fontSize: '0.875rem',
                color: 'greyscale.800',
                cursor: 'pointer',
              })}
            >
              {t(`scope.${option}`)}
            </Radio>
          ))}
        </RadioGroup>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="dense" onPress={onClose}>
          {t('form.cancel')}
        </Button>
        {/* 危险/常规走 variant 切换 —— 基元每个 variant 自己是一整套完整规则,
            不存在手搓时那种「底色赢了、字色被基类盖掉」的原子类顺序问题
            (panda-cx-atomic-order-trap),所以不用再抄两份完整类。 */}
        <Button
          variant={danger ? 'danger' : 'primary'}
          size="dense"
          onPress={() => onConfirm(scope)}
          data-testid="scope-confirm"
        >
          {t('form.confirm')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
