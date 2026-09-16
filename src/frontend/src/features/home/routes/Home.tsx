import { useTranslation } from 'react-i18next'
import { DialogTrigger } from 'react-aria-components'
import { Button } from '@/primitives'
import { styled } from '@/styled-system/jsx'
import { navigateTo } from '@/navigation/navigateTo'
import { Screen } from '@/layout/Screen'
import { useCreateRoom } from '@/features/rooms'
import { useUser, UserAware } from '@/features/auth'
import { JoinMeetingDialog } from '../components/JoinMeetingDialog'
import { authUrl } from '@/features/auth'
import { EventDetailHost, CreateEventDialog } from '@/features/calendar'
import { IntroSlider } from '@/features/home/components/IntroSlider'
import { MoreLink } from '@/features/home/components/MoreLink'
import {
  MeetingDetailPanel,
  MeetingNavPanel,
  ScheduledMeetingsList,
  RecentMeetingsList,
  type MeetingSelection,
} from '@/features/meetings'
import { ReactNode, useEffect, useState } from 'react'

import { css } from '@/styled-system/css'
import { usePersistentUserChoices } from '@/features/rooms/livekit/hooks/usePersistentUserChoices'
import { useConfig } from '@/api/useConfig'
import { useQueryClient } from '@tanstack/react-query'
import { LoadingScreen } from '@/components/LoadingScreen'
import { ResizablePanel } from '@/components/ResizablePanel'
import { StateHint } from '@/components/StateHint'
import {
  moduleContent,
  moduleRow,
  pageHeaderRow,
  pageHeaderText,
  pageTitle,
} from '@/features/meetings/components/libraryStyles'
import { MeetingModuleNav } from '@/features/meetings/components/MeetingModuleNav'

/**
 * 登录后的会议主区版心。数值与「AI 录音 / 会议实录 / 智能纪要」三页取同一档
 * —— 四个栏目来回切时,标题与内容的左边距、上下留白不再各跳一次。
 */
const meetingPage = css({
  width: '100%',
  maxWidth: '1120px',
  margin: '0 auto',
  padding: 'xl',
})

/** 主区顶部的三个入口(快速 / 加入 / 预约)。 */
const meetingActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'md',
})

const Columns = ({ children }: { children?: ReactNode }) => {
  return (
    <div
      className={css({
        alignItems: 'center',
        margin: 'auto',
        display: 'inline-flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '100%',
        justifyContent: 'normal',
        padding: '0 1rem',
        width: 'calc(100% - 2rem)',
        _motionReduce: {
          opacity: 1,
        },
        _motionSafe: {
          opacity: 0,
          animation: '.5s ease-in fade 0s forwards',
        },
        lg: {
          flexDirection: 'row',
          justifyContent: 'center',
          width: '100%',
          padding: 0,
        },
      })}
    >
      {children}
    </div>
  )
}

const LeftColumn = ({ children }: { children?: ReactNode }) => {
  return (
    <div
      className={css({
        alignItems: 'center',
        textAlign: 'center',
        display: 'inline-flex',
        flexDirection: 'column',
        flexBasis: 'auto',
        flexShrink: 0,
        maxWidth: '38rem',
        width: '100%',
        padding: '1rem 3%',
        marginTop: 'auto',
        lg: {
          margin: 0,
          textAlign: 'left',
          alignItems: 'flex-start',
          flexShrink: '1',
          flexBasis: '40rem',
          maxWidth: '40rem',
          padding: '1em 3em',
        },
      })}
    >
      {children}
    </div>
  )
}

const RightColumn = ({ children }: { children?: ReactNode }) => {
  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        overflow: 'hidden',
        padding: '1rem 3%',
        marginBottom: 'auto',
        flexBasis: 'auto',
        flexShrink: 0,
        maxWidth: '39rem',
        lg: {
          margin: 0,
          flexBasis: '45%',
          padding: '1em 3em',
        },
      })}
    >
      {children}
    </div>
  )
}

const Separator = styled('div', {
  base: {
    borderBottom: '1px solid',
    borderColor: 'border.subtle',
    marginTop: '2.5rem',
    maxWidth: '30rem',
    width: '100%',
  },
})

const Heading = styled('h1', {
  base: {
    fontWeight: '700',
    fontStyle: 'normal',
    fontStretch: 'normal',
    fontOpticalSizing: 'auto',
    paddingBottom: '1.2rem',
    fontSize: '2.3rem',
    lineHeight: '2.6rem',
    letterSpacing: '0',
    xsm: {
      fontSize: '3rem',
      lineHeight: '3.2rem',
    },
  },
})

const IntroText = styled('div', {
  base: {
    marginBottom: '3rem',
    fontSize: '1.25rem',
    lineHeight: '1.5rem',
    textWrap: 'balance',
    maxWidth: '32rem',
  },
})

export const Home = () => {
  const { t } = useTranslation(['home', 'shell', 'capture'])
  const { isLoggedIn, user } = useUser()

  const {
    userChoices: { username },
  } = usePersistentUserChoices()

  const { mutateAsync: createRoom, isPending: creating } = useCreateRoom()
  const [createError, setCreateError] = useState(false)
  const handleCreate = async () => {
    setCreateError(false)
    try {
      const owner = (user?.full_name || username || '').trim()
      const name = owner
        ? t('defaultRoomName', { user: owner })
        : t('defaultRoomNameAnonymous')
      const room = await createRoom({ name, username })
      navigateTo('room', room.slug, {
        state: { create: true, initialRoomData: room },
      })
    } catch {
      setCreateError(true)
    }
  }
  const [scheduling, setScheduling] = useState(false)
  const qc = useQueryClient()
  const [redirectFailed, setRedirectFailed] = useState(false)
  // 点击预约会议行打开详情，复用日程和会议操作。
  const [meetingDetail, setMeetingDetail] = useState<MeetingSelection | null>(
    null
  )

  const { data } = useConfig()

  useEffect(() => {
    const checkSiteAndRedirect = async () => {
      if (!data?.external_home_url) return
      if (isLoggedIn === false) {
        try {
          await fetch(data.external_home_url, {
            method: 'HEAD', // Use HEAD to avoid downloading the full page
            mode: 'no-cors', // Needed for cross-origin requests
          })
          window.location.replace(data.external_home_url)
        } catch (error) {
          setRedirectFailed(true)
          console.error('Site is not reachable:', error)
        }
      }
    }

    checkSiteAndRedirect()
  }, [isLoggedIn, data])

  if (data?.external_home_url && isLoggedIn == false && !redirectFailed) {
    return <LoadingScreen header={false} footer={false} delay={0} />
  }

  return (
    <UserAware>
      <Screen>
        {isLoggedIn ? (
          <div className={moduleRow}>
            {/* 功能导航列已抽成 MeetingNavPanel:会议首页、录音、会议实录、
                智能纪要、进会预览页共用同一列,别再往这里塞回内联版本。
                窄屏必须让位给顶部栏目行 —— 与另外三个栏目页
                (MeetingModuleShell 的 compactNavigation)同一套规则:
                定宽左列在 390px 下会把正文挤成一字一行。 */}
            <div className={css({ display: { base: 'none', md: 'flex' } })}>
              <MeetingNavPanel />
            </div>
            <div className={moduleContent}>
              <main className={meetingPage}>
                <div className={css({ md: { display: 'none' } })}>
                  <MeetingModuleNav current="/meeting" />
                </div>
                <header className={pageHeaderRow}>
                  <div className={pageHeaderText}>
                    <h1 className={pageTitle}>
                      {t('library.video', { ns: 'meetings' })}
                    </h1>
                  </div>
                </header>
                {/* 三个入口:快速会议(实心主操作)+ 加入 / 预约(线框次操作)。
                    三档都是 action 尺寸,和模块里其它页头动作同高同字号。 */}
                <div className={meetingActions}>
                  <Button
                    variant="primary"
                    size="action"
                    data-attr="create-meeting"
                    onPress={handleCreate}
                    loading={creating}
                  >
                    {t('quickMeeting')}
                  </Button>
                  <DialogTrigger>
                    <Button
                      variant="secondary"
                      size="action"
                      data-attr="join-meeting"
                    >
                      {t('joinMeeting')}
                    </Button>
                    <JoinMeetingDialog />
                  </DialogTrigger>
                  <Button
                    variant="secondary"
                    size="action"
                    data-attr="schedule-meeting"
                    onPress={() => setScheduling(true)}
                  >
                    {t('scheduleMeeting')}
                  </Button>
                </div>
                {createError && (
                  <StateHint state="error">
                    {t('library.createError', { ns: 'meetings' })}
                  </StateHint>
                )}
                {/* 「预约会议」只保留上面动作行里那一颗:节标题右侧那颗是同一
                    动作的重复入口,已删除。预约出来的会议仍出现在本节。 */}
                <ScheduledMeetingsList
                  enabled
                  showEmpty
                  onSelect={setMeetingDetail}
                  selectedId={meetingDetail?.sessionId ?? meetingDetail?.id}
                />
                <RecentMeetingsList
                  enabled
                  showEmpty
                  onSelect={setMeetingDetail}
                  selectedId={meetingDetail?.sessionId ?? meetingDetail?.id}
                />
              </main>
            </div>
            {/* 一场会一个详情页:预约会议 = 创建日程后,有日程的走统一的
                「日程详情」(与日历/IM 同一个组件,带参与人/RSVP/纪要);
                无日程的(快速会议、存量裸预约)才留会议面板。 */}
            {meetingDetail?.kind === 'scheduled' && meetingDetail.eventId ? (
              <EventDetailHost
                eventId={meetingDetail.eventId}
                editMode="inline"
                onClose={() => setMeetingDetail(null)}
              />
            ) : (
              meetingDetail && (
                <ResizablePanel
                  storageKey="we-meet:meeting-detail-w"
                  side="right"
                  defaultWidth={340}
                  min={280}
                  max={520}
                >
                  <MeetingDetailPanel
                    key={meetingDetail.sessionId ?? meetingDetail.id}
                    selection={meetingDetail}
                    onClose={() => setMeetingDetail(null)}
                  />
                </ResizablePanel>
              )
            )}
          </div>
        ) : (
          <Columns>
            <LeftColumn>
              <Heading>{t('heading')}</Heading>
              <IntroText>{t('intro')}</IntroText>
              {isLoggedIn ? (
                <div
                  className={css({
                    display: 'flex',
                    gap: 0.5,
                    flexDirection: { base: 'column', xsm: 'row' },
                    alignItems: { base: 'center', xsm: 'items-start' },
                  })}
                >
                  <Button
                    variant="primary"
                    data-attr="create-meeting"
                    onPress={async () => {
                      // Backend generates the 8-digit slug on save — don't
                      // ship a random 10-letter "code" that would co-exist
                      // with it and confuse users.
                      const owner = (user?.full_name || username || '').trim()
                      const name = owner
                        ? t('defaultRoomName', { user: owner })
                        : t('defaultRoomNameAnonymous')
                      createRoom({ name, username }).then((data) =>
                        navigateTo('room', data.slug, {
                          state: { create: true, initialRoomData: data },
                        })
                      )
                    }}
                  >
                    {t('createMeeting')}
                  </Button>
                  {/* Logged-in users get the standard join entry — anonymous
                    join is gated below (the button doesn't render at all
                    when isLoggedIn is false). */}
                  <DialogTrigger>
                    <Button variant="secondary" data-attr="join-meeting">
                      {t('joinMeeting')}
                    </Button>
                    <JoinMeetingDialog />
                  </DialogTrigger>
                  <Button
                    variant="secondary"
                    data-attr="schedule-meeting"
                    onPress={() => setScheduling(true)}
                  >
                    {t('scheduleMeeting')}
                  </Button>
                </div>
              ) : (
                // Anonymous users see [Login] + [Join meeting]. Login opens
                // the Douyin-style dual-pane dialog (QR + phone OTP). Join
                // works without login for public rooms — the room page
                // routes restricted rooms back to login as needed.
                <div
                  className={css({
                    display: 'flex',
                    gap: 0.5,
                    flexDirection: { base: 'column', xsm: 'row' },
                    alignItems: { base: 'center', xsm: 'items-start' },
                  })}
                >
                  <Button
                    variant="primary"
                    data-attr="login"
                    onPress={() => {
                      window.location.href = authUrl()
                    }}
                  >
                    {t('login')}
                  </Button>
                  <DialogTrigger>
                    <Button variant="secondary" data-attr="join-meeting">
                      {t('joinMeeting')}
                    </Button>
                    <JoinMeetingDialog />
                  </DialogTrigger>
                </div>
              )}
              <ScheduledMeetingsList
                enabled={!!isLoggedIn}
                onSelect={setMeetingDetail}
                selectedId={meetingDetail?.sessionId ?? meetingDetail?.id}
              />
              <Separator />
              <MoreLink />
            </LeftColumn>
            <RightColumn>
              <IntroSlider />
            </RightColumn>
          </Columns>
        )}
        {scheduling && (
          <CreateEventDialog
            onClose={() => setScheduling(false)}
            onCreated={() => {
              setScheduling(false)
              // 日程创建时后端自建带 scheduled_at 的 Room → 刷新首页预约列表。
              void qc.invalidateQueries({ queryKey: ['scheduled-meetings'] })
              void qc.invalidateQueries({ queryKey: ['video-meetings'] })
            }}
          />
        )}
      </Screen>
    </UserAware>
  )
}
