import { useTranslation } from 'react-i18next'
import { DialogTrigger } from 'react-aria-components'
import { Button } from '@/primitives'
import { styled } from '@/styled-system/jsx'
import { navigateTo } from '@/navigation/navigateTo'
import { Screen } from '@/layout/Screen'
import { useCreateRoom } from '@/features/rooms'
import { useUser, UserAware } from '@/features/auth'
import { JoinMeetingDialog } from '../components/JoinMeetingDialog'
import { LoginDialog } from '@/features/home/components/LoginDialog'
import { ScheduleMeetingDialog } from '@/features/home/components/ScheduleMeetingDialog'
import { LaterMeetingDialog } from '@/features/home/components/LaterMeetingDialog'
import { IntroSlider } from '@/features/home/components/IntroSlider'
import { MoreLink } from '@/features/home/components/MoreLink'
import { RecentMeetingsList, ScheduledMeetingsList } from '@/features/meetings'
import { PersonalAIFab } from '@/features/personal-ai'
import { ReactNode, useEffect, useState } from 'react'

import { css } from '@/styled-system/css'
import { usePersistentUserChoices } from '@/features/rooms/livekit/hooks/usePersistentUserChoices'
import { useConfig } from '@/api/useConfig'
import { ApiRoom } from '@/features/rooms/api/ApiRoom'
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
    fontSize: '1.2rem',
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
  const [laterRoom, setLaterRoom] = useState<null | ApiRoom>(null)
  const [redirectFailed, setRedirectFailed] = useState(false)

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
                backgroundColor: 'white',
                padding: '1.25rem 1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
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
                  {t('createMeeting')}
                </Button>
                <DialogTrigger>
                  <Button variant="secondary">{t('joinMeeting')}</Button>
                  <JoinMeetingDialog />
                </DialogTrigger>
                <DialogTrigger>
                  <Button variant="secondary" data-attr="schedule-meeting">
                    {t('scheduleMeeting')}
                  </Button>
                  <ScheduleMeetingDialog
                    username={username}
                    onCreated={setLaterRoom}
                  />
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
              <ScheduledMeetingsList enabled />
              <RecentMeetingsList enabled />
            </main>
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
                <DialogTrigger>
                  <Button variant="secondary" data-attr="schedule-meeting">
                    {t('scheduleMeeting')}
                  </Button>
                  <ScheduleMeetingDialog
                    username={username}
                    onCreated={setLaterRoom}
                  />
                </DialogTrigger>
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
                <DialogTrigger>
                  <Button variant="primary" data-attr="login">
                    {t('login')}
                  </Button>
                  <LoginDialog />
                </DialogTrigger>
                <DialogTrigger>
                  <Button variant="secondary">{t('joinMeeting')}</Button>
                  <JoinMeetingDialog />
                </DialogTrigger>
              </div>
            )}
            <ScheduledMeetingsList enabled={!!isLoggedIn} />
            <RecentMeetingsList enabled={!!isLoggedIn} />
            <Separator />
            <MoreLink />
          </LeftColumn>
          <RightColumn>
            <IntroSlider />
            </RightColumn>
          </Columns>
        )}
        <LaterMeetingDialog
          room={laterRoom}
          onOpenChange={() => setLaterRoom(null)}
        />
        {isLoggedIn && <PersonalAIFab />}
      </Screen>
    </UserAware>
  )
}
