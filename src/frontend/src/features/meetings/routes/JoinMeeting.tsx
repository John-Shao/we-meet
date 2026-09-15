import { useTranslation } from 'react-i18next'
import { Field, Ul, H, P, Form } from '@/primitives'
import { css } from '@/styled-system/css'
import { navigateTo } from '@/navigation/navigateTo'
import { Screen } from '@/layout/Screen'
import { useUser } from '@/features/auth'
import {
  isRoomValid,
  normalizeRoomId,
} from '@/features/rooms/utils/isRoomValid'
import { libraryLayout } from '../components/libraryStyles'
import { MeetingModuleNav } from '../components/MeetingModuleNav'
import { MeetingModuleShell } from '../components/MeetingModuleShell'

const title = css({
  fontSize: '1.5rem',
  fontWeight: 700,
  marginBottom: '0.75rem',
})

/**
 * 「加入会议」页（`/meeting/join`）—— 原先是挂在按钮上的一个弹窗。
 *
 * 改成页面有三条理由:
 *
 * 1. 它是**一次导航前的输入**(输完就去房间),不是一个随手就能取消的动作 ——
 *    弹窗的 backdrop / ESC / 取消把"填错就退出"当成了默认结局;
 * 2. 弹窗里放不下那句"您知道吗"的说明与允许的几种写法(完整链接、8 位会议号、
 *    带横线的短码),挤在浮层里只能当小字;
 * 3. 同一件事在别处都已经有"页"的形态(录音 / 笔记 / 纪要),左侧那列功能导航
 *    在这些页上是常驻的 —— 弹窗一开一关,导航列反而显不出来。
 *
 * 已登录时套 `MeetingModuleShell`(左列功能导航跟着路由留在屏幕上,与兄弟页同一
 * 套壳);未登录的落地页进来时不套 —— 那列磁贴对匿名用户没有意义,只留这一页
 * 自己的内容。
 */
export const JoinMeeting = () => {
  const { t } = useTranslation(['home', 'meetings'])
  const { isLoggedIn } = useUser()

  // Strip the optional we-meet origin prefix, then run the input through
  // normalizeRoomId so that pasted formats like "1234 5678" or "1234-5678"
  // collapse to the canonical 8-digit slug expected by the room route.
  const sanitize = (raw: string) =>
    normalizeRoomId(raw.trim().replace(`${window.location.origin}/`, ''))

  const handleSubmit = (data: { roomId?: FormDataEntryValue }) => {
    navigateTo('room', sanitize(data.roomId as string))
  }

  const validateRoomId = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return null
    return !isRoomValid(sanitize(trimmed)) ? (
      <>
        <p>{t('joinInputError')}</p>
        <Ul>
          <li>{window.location.origin}/12345678</li>
          <li>12345678</li>
          <li>{window.location.origin}/uio-azer-jkl</li>
          <li>uio-azer-jkl</li>
        </Ul>
      </>
    ) : null
  }

  const content = (
    <main className={libraryLayout}>
      {isLoggedIn && <MeetingModuleNav />}
      <h1 className={title}>{t('joinMeeting')}</h1>
      <Form
        onSubmit={handleSubmit}
        submitLabel={t('joinInputSubmit')}
        // 页面上没有"取消"这一说:左侧那列功能导航(或浏览器返回)就是出口,
        // 再摆一个取消按钮等于把弹窗时代的动作照搬过来。
        withCancelButton={false}
      >
        {/* eslint-disable jsx-a11y/no-autofocus -- 这一页只有一件事:输入会议号,进来就该能打字 */}
        <Field
          type="text"
          autoFocus
          isRequired
          name="roomId"
          label={t('joinInputLabel')}
          description={t('joinInputExample', {
            example: window.origin + '/azer-tyu-qsdf',
          })}
          validate={validateRoomId}
        />
      </Form>
      <H lvl={2}>{t('joinMeetingTipHeading')}</H>
      <P last>{t('joinMeetingTipContent')}</P>
    </main>
  )

  if (!isLoggedIn) return <Screen>{content}</Screen>

  return <MeetingModuleShell>{content}</MeetingModuleShell>
}
