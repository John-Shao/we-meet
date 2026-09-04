import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal, ModalBody, ModalHeader } from '@/components/Modal'

const preCls = css({
  overflowX: 'auto',
  padding: '0.625rem',
  borderRadius: '0.375rem',
  backgroundColor: 'greyscale.50',
  border: '1px solid token(colors.greyscale.200)',
  fontFamily: 'mono',
  fontSize: '0.75rem',
  color: 'greyscale.800',
  whiteSpace: 'pre',
})

const h3Cls = css({
  margin: '1rem 0 0.375rem',
  fontSize: '0.875rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})

const pCls = css({
  margin: 0,
  fontSize: '0.8125rem',
  color: 'greyscale.700',
  lineHeight: 1.6,
})

/**
 * 使用说明 — how to actually POST to a webhook.
 *
 * A dialog rather than a link to a docs site because we do not have one, and
 * this text has to exist regardless: handing someone a URL without telling them
 * what body it accepts is handing them nothing.
 */
export const BotHelpDialog = ({ onClose }: { onClose: () => void }) => {
  const { t } = useTranslation('im')
  return (
    <Modal
      onClose={onClose}
      maxWidth="600px"
      maxHeight="80vh"
      ariaLabel={t('bots.helpTitle')}
    >
      <ModalHeader
        title={t('bots.helpTitle')}
        onClose={onClose}
        closeLabel={t('manage.cancel')}
      />

      <ModalBody>
        <p className={pCls}>{t('bots.helpIntro')}</p>

        <h3 className={h3Cls}>{t('bots.helpText')}</h3>
        <pre className={preCls}>
          {`curl -X POST <webhook 地址> \\
  -H 'Content-Type: application/json' \\
  -d '{"msg_type":"text","content":{"text":"构建完成 <at user_id=\\"all\\"></at>"}}'`}
        </pre>

        <h3 className={h3Cls}>{t('bots.helpPost')}</h3>
        <pre className={preCls}>
          {`{
  "msg_type": "post",
  "content": {"post": {"zh_cn": {
    "title": "构建失败",
    "content": [[
      {"tag": "text", "text": "分支 main 构建失败 "},
      {"tag": "a", "text": "查看日志", "href": "https://ci.example.com/1"}
    ]]
  }}}
}`}
        </pre>

        <h3 className={h3Cls}>{t('bots.helpSign')}</h3>
        <p className={pCls}>{t('bots.helpSignBody')}</p>
        <pre className={preCls}>
          {`timestamp = 当前 unix 秒
sign = base64(hmac_sha256(key = timestamp + "\\n" + 密钥, data = ""))
# 两个字段都放在 JSON body 顶层,不是 header`}
        </pre>

        <h3 className={h3Cls}>{t('bots.helpLimits')}</h3>
        <p className={pCls}>{t('bots.helpLimitsBody')}</p>
      </ModalBody>
    </Modal>
  )
}
