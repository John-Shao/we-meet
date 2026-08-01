import { useTranslation } from 'react-i18next'
import { DialogTrigger } from 'react-aria-components'
import {
  RiFlashlightLine,
  RiCalendarLine,
  RiAddCircleLine,
  RiSettings3Line,
} from '@remixicon/react'
import { Button } from '@/primitives'
import { styled } from '@/styled-system/jsx'
import { navigateTo } from '@/navigation/navigateTo'
import { Screen } from '@/layout/Screen'
import { useCreateRoom } from '@/features/rooms'
import { useUser, UserAware } from '@/features/auth'
import { JoinMeetingDialog } from '../components/JoinMeetingDialog'
import { authUrl } from '@/features/auth'
import { CreateEventDialog, EventDetailHost } from '@/features/calendar'
import { IntroSlider } from '@/features/home/components/IntroSlider'
import { MoreLink } from '@/features/home/components/MoreLink'
import {
  MeetingDetailPanel,
  RecentMeetingsList,
  ScheduledMeetingsList,
  type MeetingSelection,
} from '@/features/meetings'
import { PersonalAIFab } from '@/features/personal-ai'
import { ReactNode, useEffect, useState } from 'react'

import { css } from '@/styled-system/css'
import { openSystemSettings } from '@/stores/systemSettings'
import { usePersistentUserChoices } from '@/features/rooms/livekit/hooks/usePersistentUserChoices'
import { useConfig } from '@/api/useConfig'
import { useQueryClient } from '@tanstack/react-query'
import { LoadingScreen } from '@/components/LoadingScreen'
import { ResizablePanel } from '@/components/ResizablePanel'

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
    borderColor: 'greyscale.500',
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
  const { t } = useTranslation(['home', 'shell'])
  const { isLoggedIn, user } = useUser()

  const {
    userChoices: { username },
  } = usePersistentUserChoices()

  const { mutateAsync: createRoom } = useCreateRoom()
  // 预约会议 = 创建日程(与飞书一致):点击打开日历的 CreateEventDialog。
  const [scheduling, setScheduling] = useState(false)
  const qc = useQueryClient()
  const [redirectFailed, setRedirectFailed] = useState(false)
  // P8(对标飞书):点预约/历史会议行 → 右侧详情面板,操作收进面板。
  const [meetingDetail, setMeetingDetail] = useState<MeetingSelection | null>(
    null
  )

  const { data } = useConfig()

  // 发起会议:后端在保存时生成 8 位 slug,前端不再自造 code。
  const handleCreate = async () => {
    const owner = (user?.full_name || username || '').trim()
    const name = owner
      ? t('defaultRoomName', { user: owner })
      : t('defaultRoomNameAnonymous')
    const room = await createRoom({ name, username })
    navigateTo('room', room.slug, {
      state: { create: true, initialRoomData: room },
    })
  }

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
          <div className={css({ display: 'flex', height: '100%' })}>
            <ResizablePanel
              storageKey="we-meet:meeting-sidebar-width"
              defaultWidth={260}
              min={220}
              max={460}
            >
              <aside
                className={css({
                  width: '100%',
                  height: '100%',
                  borderRight: '1px solid token(colors.greyscale.200)',
                  backgroundColor: 'greyscale.000',
                  padding: '1.25rem 1rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem',
                })}
              >
                <div
                  className={css({
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  })}
                >
                  <h1
                    className={css({
                      fontSize: '1.125rem',
                      fontWeight: 'bold',
                      color: 'greyscale.900',
                    })}
                  >
                    {t('nav.meeting', { ns: 'shell' })}
                  </h1>
                  {/* P8 设置收敛:齿轮只是快捷入口,打开系统设置定位「会议设置」节。 */}
                  <button
                    type="button"
                    onClick={() => openSystemSettings('meeting')}
                    title={t('systemSettings.nav.meeting', { ns: 'settings' })}
                    aria-label={t('systemSettings.nav.meeting', {
                      ns: 'settings',
                    })}
                    data-testid="meeting-settings"
                    className={css({
                      width: '1.75rem',
                      height: '1.75rem',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: 'none',
                      borderRadius: '0.5rem',
                      backgroundColor: 'transparent',
                      color: 'greyscale.600',
                      cursor: 'pointer',
                      _hover: { backgroundColor: 'greyscale.100' },
                    })}
                  >
                    <RiSettings3Line size={16} />
                  </button>
                </div>
                <div
                  className={css({
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.625rem',
                    alignItems: 'stretch',
                  })}
                >
                  <Button
                    variant="primary"
                    data-attr="create-meeting"
                    onPress={handleCreate}
                  >
                    <RiFlashlightLine size={18} />
                    {t('quickMeeting')}
                  </Button>
                  <Button
                    variant="secondary"
                    data-attr="schedule-meeting"
                    onPress={() => setScheduling(true)}
                  >
                    <RiCalendarLine size={18} />
                    {t('scheduleMeeting')}
                  </Button>
                  <DialogTrigger>
                    <Button variant="secondary">
                      <RiAddCircleLine size={18} />
                      {t('joinMeeting')}
                    </Button>
                    <JoinMeetingDialog />
                  </DialogTrigger>
                </div>
              </aside>
            </ResizablePanel>
            <main
              className={css({
                flex: 1,
                minWidth: 0,
                overflowY: 'auto',
                padding: '1.5rem',
              })}
            >
              <ScheduledMeetingsList
                enabled
                showEmpty
                onSelect={setMeetingDetail}
                selectedId={meetingDetail?.id}
              />
              <RecentMeetingsList
                enabled
                showEmpty
                onSelect={setMeetingDetail}
                selectedId={meetingDetail?.id}
              />
            </main>
            {/* 一场会一个详情页:预约会议 = 创建日程后,有日程的走统一的
                「日程详情」(与日历/IM 同一个组件,带参与人/RSVP/纪要);
                无日程的(快速会议、存量裸预约、历史会议)才留会议面板。 */}
            {meetingDetail?.eventId ? (
              <EventDetailHost
                eventId={meetingDetail.eventId}
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
                    <Button variant="secondary">{t('joinMeeting')}</Button>
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
                    <Button variant="secondary">{t('joinMeeting')}</Button>
                    <JoinMeetingDialog />
                  </DialogTrigger>
                </div>
              )}
              <ScheduledMeetingsList
                enabled={!!isLoggedIn}
                onSelect={setMeetingDetail}
                selectedId={meetingDetail?.id}
              />
              <RecentMeetingsList
                enabled={!!isLoggedIn}
                onSelect={setMeetingDetail}
                selectedId={meetingDetail?.id}
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
            }}
          />
        )}
        {isLoggedIn && <PersonalAIFab />}
      </Screen>
    </UserAware>
  )
}
