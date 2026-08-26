import { useState, type ReactNode } from 'react'

import { useConfirm } from '@/components/ConfirmProvider'

import { createGroupConversation } from '../api/createGroupConversation'
import { useForwardConversations } from '../hooks/useForwardConversations'

import { ForwardDialog } from './ForwardDialog'
import { GroupPicker } from './GroupPicker'

interface Props {
  /** 卡片正文(JSON 字符串),由各业务方自己 build 好后传进来。 */
  body: string
  /** Build a conversation-specific body (used when card URLs carry the cid). */
  buildBody?: (cid: string) => string
  /** IM 富消息类型:event-card / meeting-card / doc-card …… */
  contentType: string
  /** 顶部那行「在分享什么」的一句话预览。 */
  previewText: string
  /** 发送失败的提示文案(各模块措辞不同,故由调用方给)。 */
  errorMessage: string
  /** 发送成功后的附加动作(如云文档的「分享即精准授权」);失败不触发。
   * 新建群转发时收到的是刚建出来的那个 cid。 */
  onSent?: (cids: string[]) => void
  beforeSend?: (cids: string[]) => Promise<unknown>
  title?: string
  primaryTabLabel?: string
  secondaryTab?: { label: string; content: ReactNode }
  onClose: () => void
}

/**
 * 「分享到聊天」通用弹窗 —— 选已有会话发,或新建群再发(对标飞书转发)。
 *
 * 日程 / 会议 / 云文档三处分享原本各写了一遍同样的
 * 「useForwardConversations + ForwardDialog + GroupPicker + 循环 sendText」,
 * 云文档那份还漏掉了「创建群组并转发」这一支。收敛到这里之后,差异只剩
 * body/contentType/文案三个入参,新增分享入口不会再漏掉某个分支。
 */
export const ShareToChatDialog = ({
  body,
  buildBody,
  contentType,
  previewText,
  errorMessage,
  onSent,
  beforeSend,
  title,
  primaryTabLabel,
  secondaryTab,
  onClose,
}: Props) => {
  const { alert } = useConfirm()
  const { client, conversations, isLoading } = useForwardConversations()
  const [creatingGroup, setCreatingGroup] = useState(false)

  const send = async (cids: string[]) => {
    try {
      await beforeSend?.(cids)
      for (const cid of cids)
        await client.sendText(cid, buildBody?.(cid) ?? body, { contentType })
      onSent?.(cids)
      onClose()
    } catch {
      void alert({ message: errorMessage })
    }
  }

  if (creatingGroup)
    return (
      <GroupPicker
        onClose={() => setCreatingGroup(false)}
        onCreate={(memberUserIds, name) => {
          void (async () => {
            try {
              const created = await createGroupConversation(memberUserIds, name)
              await send([created.cid])
            } catch {
              void alert({ message: errorMessage })
            }
          })()
        }}
      />
    )

  return (
    <ForwardDialog
      conversations={conversations}
      isLoading={isLoading}
      previewText={previewText}
      title={title}
      primaryTabLabel={primaryTabLabel}
      secondaryTab={secondaryTab}
      onConfirm={(cids) => void send(cids)}
      onCreateGroupForward={() => setCreatingGroup(true)}
      onClose={onClose}
    />
  )
}
