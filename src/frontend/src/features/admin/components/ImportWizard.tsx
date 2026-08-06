import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'

import { Dialog } from '@/primitives/Dialog'
import { Button } from '@/primitives'
import { css } from '@/styled-system/css'
import { useConfirm } from '@/components/ConfirmProvider'

import {
  type ImportJob,
  type ImportSummary,
  IMPORT_TEMPLATE_PATH,
  applyImportJob,
  uploadImportFile,
} from '../api/adminImport'
import { describeApiError } from '../api/errors'

interface Props {
  isOpen: boolean
  onDone: () => void
  onClose: () => void
}

/**
 * 批量导入向导 —— 三步:选文件 → **看预检结果** → 确认落库。
 *
 * 中间那步是这个功能存在的理由。上传即执行的导入器只能事后告诉你它干了什么,
 * 而一列映射错就足以悄悄重塑一个几百人的通讯录。
 *
 * 「导入成员」的语义要在界面上说清:匹配不到的人建的是**邀请**,他首次登录后
 * 才会出现在通讯录里(we-meet 身份来自 OIDC,没首登就没有 sub)。不说清楚必然
 * 收到「导了三百人通讯录还是空的」。
 */
export const ImportWizard = ({ isOpen, onDone, onClose }: Props) => {
  const { t } = useTranslation('admin')
  const { alert: showAlert } = useConfirm()
  const fileRef = useRef<HTMLInputElement>(null)
  const [job, setJob] = useState<ImportJob | null>(null)
  const [createMissing, setCreateMissing] = useState(false)

  const onError = (e: unknown) => showAlert({ message: describeApiError(e) })

  const uploadMut = useMutation({
    mutationFn: (file: File) => uploadImportFile(file, createMissing),
    onSuccess: setJob,
    onError,
  })

  const applyMut = useMutation({
    mutationFn: () => applyImportJob(job!.id, summary(job!).total),
    onSuccess: (applied) => {
      setJob(applied)
      onDone()
    },
    onError,
  })

  const close = () => {
    setJob(null)
    setCreateMissing(false)
    onClose()
  }

  const stats = job ? summary(job) : null
  const rows = job?.rows ?? []
  const errorRows = rows.filter((r) => r.action === 'error')
  const warnRows = rows.filter(
    (r) => r.action !== 'error' && r.warnings.length > 0,
  )

  return (
    // type="flex":默认 dialog 档定宽 30rem,46rem 的向导会整片溢到框外。
    <Dialog isOpen={isOpen} onClose={close} type="flex" title={t('import.title')}>
      <div className={css({ width: 'min(46rem, calc(100vw - 6rem))' })}>
        {job === null ? (
          <>
            <p className={leadCls}>{t('import.lead')}</p>
            {/* 语义说明放在选文件之前,不是事后提示。 */}
            <p className={noteCls}>{t('import.invitationNote')}</p>

            <div className={rowCls}>
              <a
                href={IMPORT_TEMPLATE_PATH}
                download
                className={linkCls}
                data-testid="import-template-link"
              >
                {t('import.downloadTemplate')}
              </a>
            </div>

            <label className={checkRowCls}>
              <input
                type="checkbox"
                checked={createMissing}
                onChange={(e) => setCreateMissing(e.target.checked)}
              />
              <span>{t('import.createMissingDepartments')}</span>
            </label>

            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              data-testid="import-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) uploadMut.mutate(file)
              }}
              className={css({ marginTop: '0.75rem' })}
            />
            {uploadMut.isPending && (
              <p className={noteCls}>{t('import.checking')}</p>
            )}
          </>
        ) : job.status === 'failed' ? (
          <>
            <p className={errorCls}>{job.error}</p>
            <div className={footerCls}>
              <Button variant="tertiaryText" size="sm" onPress={() => setJob(null)}>
                {t('import.chooseAnother')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className={statsCls}>
              <Stat label={t('import.statTotal')} value={stats!.total} />
              <Stat label={t('import.statUpdate')} value={stats!.update} />
              <Stat label={t('import.statRehire')} value={stats!.rehire} />
              <Stat label={t('import.statInvite')} value={stats!.invite} />
              <Stat
                label={t('import.statError')}
                value={stats!.error}
                danger={stats!.error > 0}
              />
            </div>

            {stats!.error > 0 && (
              <p className={noteCls}>{t('import.errorRowsSkipped')}</p>
            )}

            {/* 只列有问题的行。一份 800 行全绿的预览逐行铺开只会把真正要看的
                十几行淹掉。 */}
            {[...errorRows, ...warnRows].length > 0 && (
              <div className={listCls}>
                {[...errorRows, ...warnRows].map((row) => (
                  <div key={row.line} className={issueRowCls}>
                    <span className={lineCls}>#{row.line}</span>
                    <span className={css({ flex: 1, minWidth: 0 })}>
                      <span className={css({ color: 'greyscale.900' })}>
                        {row.label}
                      </span>
                      {row.errors.map((message) => (
                        <span key={message} className={errorTextCls}>
                          {message}
                        </span>
                      ))}
                      {row.warnings.map((message) => (
                        <span key={message} className={warnTextCls}>
                          {message}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {job.status === 'previewed' ? (
              <div className={footerCls}>
                <Button
                  variant="tertiaryText"
                  size="sm"
                  onPress={() => setJob(null)}
                >
                  {t('import.chooseAnother')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={applyMut.isPending || stats!.total === 0}
                  onPress={() => applyMut.mutate()}
                >
                  {t('import.confirm', {
                    count: stats!.total - stats!.error,
                  })}
                </Button>
              </div>
            ) : (
              <div className={footerCls}>
                <span className={doneCls}>
                  {job.status === 'partial'
                    ? t('import.donePartial')
                    : t('import.done')}
                </span>
                <Button variant="primary" size="sm" onPress={close}>
                  {t('actions.close')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

/** 空 summary(job 刚建、预检还没落)时给一份全零,免得到处判 undefined。 */
const summary = (job: ImportJob): ImportSummary => {
  const s = job.summary as Partial<ImportSummary>
  return {
    total: s.total ?? 0,
    warnings: s.warnings ?? 0,
    create: s.create ?? 0,
    update: s.update ?? 0,
    rehire: s.rehire ?? 0,
    invite: s.invite ?? 0,
    error: s.error ?? 0,
  }
}

const Stat = ({
  label,
  value,
  danger,
}: {
  label: string
  value: number
  danger?: boolean
}) => (
  <div className={statCls}>
    <span className={danger && value > 0 ? statValueDangerCls : statValueCls}>
      {value}
    </span>
    <span className={statLabelCls}>{label}</span>
  </div>
)

const leadCls = css({ fontSize: '0.875rem', color: 'greyscale.800' })
const noteCls = css({
  marginTop: '0.5rem',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const errorCls = css({ fontSize: '0.875rem', color: 'danger.subtle-text' })
const rowCls = css({ marginTop: '0.75rem' })
const linkCls = css({
  fontSize: '0.8125rem',
  color: 'primary.500',
  textDecoration: 'underline',
})
const checkRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginTop: '0.75rem',
  fontSize: '0.8125rem',
  color: 'greyscale.800',
  cursor: 'pointer',
})
const statsCls = css({
  display: 'flex',
  gap: '1.25rem',
  paddingY: '0.5rem',
})
const statCls = css({ display: 'flex', flexDirection: 'column' })
const statValueCls = css({
  fontSize: '1.25rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
// 两个完整类切换而不是在一个 css() 里三元拼颜色(见 AdminShell 顶部说明)。
const statValueDangerCls = css({
  fontSize: '1.25rem',
  fontWeight: 'bold',
  color: 'danger.subtle-text',
})
const statLabelCls = css({ fontSize: '0.75rem', color: 'greyscale.500' })
const listCls = css({
  marginTop: '0.75rem',
  maxHeight: '18rem',
  overflowY: 'auto',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '6px',
})
const issueRowCls = css({
  display: 'flex',
  gap: '0.625rem',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  fontSize: '0.8125rem',
})
const lineCls = css({
  width: '3rem',
  flexShrink: 0,
  color: 'greyscale.400',
  fontFamily: 'monospace',
})
const errorTextCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'danger.subtle-text',
})
const warnTextCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const footerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.75rem',
})
const doneCls = css({
  flex: 1,
  fontSize: '0.8125rem',
  color: 'greyscale.600',
})
