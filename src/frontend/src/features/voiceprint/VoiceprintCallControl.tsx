import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react'
import { ConnectionState, RoomEvent, Track, TrackEvent } from 'livekit-client'
import { useTranslation } from 'react-i18next'
import { useUser } from '@/features/auth'
import {
  getAuthSnapshot,
  sameAuthSession,
} from '@/features/auth/utils/tokenStorage'
import { useConfig } from '@/api/useConfig'
import { Button, Dialog, Switch } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'
import { useConnectedMeetingSid } from '@/features/meetings/useConnectedMeetingSid'
import {
  CallSamplingClient,
  callDeviceGroups,
  type CallDeviceGroup,
} from './callSamplingApi'
import { CallSamplingController } from './callSamplingController'
import { VoiceprintSettingsPanel } from './VoiceprintSettingsPanel'

/** Shared by voice calls, video calls and meetings; no media subscriptions. */
export function VoiceprintCallControl() {
  const { data: config } = useConfig()
  return config?.speaker_identity?.enabled &&
    config.speaker_identity.sampling_enabled ? (
    <ConnectedControl />
  ) : null
}

function ConnectedControl() {
  const room = useRoomContext()
  const { user, isLoggedIn } = useUser()
  const sid = useConnectedMeetingSid()
  const connection = useConnectionState()
  const { localParticipant, microphoneTrack, isMicrophoneEnabled } =
    useLocalParticipant()
  const [session, setSession] = useState(() => getAuthSnapshot().session)
  const [reconnect, setReconnect] = useState(0)
  useEffect(() => {
    const changed = () => setReconnect((value) => value + 1)
    room.on(RoomEvent.Reconnected, changed)
    return () => {
      room.off(RoomEvent.Reconnected, changed)
    }
  }, [room])
  useEffect(() => {
    const timer = setInterval(() => setSession(getAuthSnapshot().session), 250)
    return () => clearInterval(timer)
  }, [])
  if (
    !isLoggedIn ||
    !user ||
    !sid ||
    !localParticipant.sid ||
    connection !== ConnectionState.Connected
  )
    return null
  return (
    <ConnectionPanel
      key={`${user.id}:${session}:${sid}:${localParticipant.sid}:${localParticipant.identity}:${reconnect}`}
      ownerId={user.id}
      roomSid={sid}
      participantSid={localParticipant.sid}
      microphoneEnabled={isMicrophoneEnabled}
      track={microphoneTrack?.track}
      needsDeclaration={reconnect > 0}
    />
  )
}

function ConnectionPanel({
  ownerId,
  roomSid,
  participantSid,
  microphoneEnabled,
  track,
  needsDeclaration,
}: {
  ownerId: string
  roomSid: string
  participantSid: string
  microphoneEnabled: boolean
  track?: Track
  needsDeclaration: boolean
}) {
  const room = useRoomContext()
  const [client] = useState(
    () => new CallSamplingClient(ownerId, roomSid, participantSid)
  )
  const controller = useMemo(() => new CallSamplingController(client), [client])
  const previousDevice = useRef<string>()
  const previousTrack = useRef<Track>()
  useEffect(() => {
    if (needsDeclaration) controller.invalidateDevice()
  }, [needsDeclaration, controller])
  // A different capture device requires a fresh explicit declaration. IDs are
  // compared only in memory; they are never submitted, cached or logged.
  useEffect(() => {
    if (track && previousTrack.current && previousTrack.current !== track)
      controller.invalidateDevice()
    if (track) previousTrack.current = track
    const changed = () => {
      const next = track?.mediaStreamTrack.getSettings().deviceId
      if (previousDevice.current && next && previousDevice.current !== next) {
        controller.invalidateDevice()
      }
      if (next) previousDevice.current = next
    }
    const activeDeviceChanged = (kind: MediaDeviceKind) => {
      if (kind === 'audioinput') controller.invalidateDevice()
    }
    changed()
    track?.on(TrackEvent.Restarted, changed)
    room.on(RoomEvent.ActiveDeviceChanged, activeDeviceChanged)
    return () => {
      track?.off(TrackEvent.Restarted, changed)
      room.off(RoomEvent.ActiveDeviceChanged, activeDeviceChanged)
    }
  }, [track, room, controller])
  return (
    <VoiceprintCallPanel
      controller={controller}
      microphoneEnabled={microphoneEnabled}
    />
  )
}

/** Exported for isolated UI review with synthetic connection/API fixtures. */
export function VoiceprintCallPanel({
  controller,
  microphoneEnabled,
}: {
  controller: CallSamplingController
  microphoneEnabled: boolean
}) {
  const { t } = useTranslation('voiceprint')
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [selectedGroup, setSelectedGroup] = useState<'' | CallDeviceGroup>('')
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    controller.start()
    const poll = setInterval(() => void controller.refresh(), 3000)
    const clock = setInterval(() => setNow(Date.now()), 250)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
      controller.close()
    }
  }, [controller])
  const snapshot = state.snapshot
  const control = snapshot?.control
  const permission = snapshot?.permission
  useEffect(() => {
    // Disabling the initiating button can leave keyboard focus on body. Keep
    // Escape and the focus trap usable without stealing focus from settings.
    const active = document.activeElement
    if (
      open &&
      !settingsOpen &&
      panel.current &&
      (active === document.body ||
        (active instanceof HTMLElement &&
          panel.current.contains(active) &&
          active.matches(':disabled')))
    )
      panel.current.focus({ preventScroll: true })
  }, [open, settingsOpen, state.busy, state.loading, snapshot])
  useEffect(() => {
    setSelectedGroup(control?.device_group ?? '')
  }, [control?.device_group])
  if (!sameAuthSession(controller.client.auth)) return null
  const phase = controller.runtime(now)
  const displayPhase =
    !microphoneEnabled &&
    (phase === 'sampling' ||
      phase === 'uploading' ||
      phase === 'waiting' ||
      phase === 'starting')
      ? 'muted'
      : phase
  const scope = snapshot?.organization_name ?? t('personal')
  const unavailable =
    !snapshot ||
    phase === 'unavailable' ||
    state.busy ||
    state.deviceChanged ||
    !permission?.available ||
    control?.state === 'disabled' ||
    control?.state === 'source_removed' ||
    control?.state === 'disconnected'
  const description = state.error
    ? t(`call.error.${state.error}`)
    : control?.stop_reason === 'mixed_speaker'
      ? t('call.mixedSpeaker')
      : control?.runtime.reason
        ? t(`call.reason.${control.runtime.reason}`)
        : undefined
  const declare = (changes: {
    paused: boolean
    shared_microphone: boolean
    device_group: '' | CallDeviceGroup
  }) => void controller.declare(changes)
  return (
    <div className={widgetCss}>
      <Button
        variant="secondary"
        size="sm"
        onPress={() => setOpen(true)}
        aria-label={t('call.open')}
      >
        {t('call.status', { state: t(`call.phase.${displayPhase}`) })}
      </Button>
      <Dialog
        type="flex"
        aria-label={t('call.title')}
        isOpen={open}
        onOpenChange={setOpen}
      >
        <div className={panelCss} ref={panel} tabIndex={-1}>
          <h2 className={titleCss}>{t('call.title')}</h2>
          <p role="status">
            {t('call.status', { state: t(`call.phase.${displayPhase}`) })}
          </p>
          {snapshot && (
            <>
              <p>{t('call.scope', { scope })}</p>
              <p>
                {t('call.notice', {
                  clip: snapshot.limits.clip_ms / 1000,
                  session: snapshot.limits.session_ms / 1000,
                  daily: snapshot.limits.daily_ms / 1000,
                  hours: snapshot.limits.candidate_retention_seconds / 3600,
                })}
              </p>
              <p>{t('call.confirmation')}</p>
              <Switch
                isSelected={control!.shared_microphone}
                isDisabled={unavailable}
                onChange={(shared) =>
                  declare({
                    paused: true,
                    shared_microphone: shared,
                    device_group: control!.device_group,
                  })
                }
              >
                {t('call.shared')}
              </Switch>
              <Select
                aria-label={t('call.device')}
                selectedKey={selectedGroup}
                isDisabled={unavailable}
                items={[
                  { value: '', label: t('call.chooseDevice') },
                  ...callDeviceGroups.map((value) => ({
                    value,
                    label: t(`deviceGroup.${value}`),
                  })),
                ]}
                onSelectionChange={(value) =>
                  setSelectedGroup(value as '' | CallDeviceGroup)
                }
              />
              <p>{t('call.declaration')}</p>
              <div className={actionsCss}>
                <Button
                  variant="secondary"
                  isDisabled={
                    unavailable || selectedGroup === control!.device_group
                  }
                  onPress={() =>
                    declare({
                      paused: true,
                      shared_microphone: control!.shared_microphone,
                      device_group: selectedGroup,
                    })
                  }
                >
                  {t('call.saveDevice')}
                </Button>
                <Button
                  isDisabled={
                    unavailable ||
                    !permission!.allow_accumulation ||
                    !microphoneEnabled ||
                    control!.shared_microphone ||
                    !control!.device_group ||
                    selectedGroup !== control!.device_group ||
                    (!control!.paused && control!.state === 'ready')
                  }
                  onPress={() =>
                    declare({
                      paused: false,
                      shared_microphone: false,
                      device_group: control!.device_group,
                    })
                  }
                >
                  {t('call.resume')}
                </Button>
                <Button
                  variant="secondary"
                  isDisabled={unavailable || control!.paused}
                  onPress={() =>
                    declare({
                      paused: true,
                      shared_microphone: control!.shared_microphone,
                      device_group: control!.device_group,
                    })
                  }
                >
                  {t('call.pause')}
                </Button>
              </div>
              {control!.runtime.remaining_ms && (
                <p>
                  {t('call.remaining', {
                    session: Math.floor(
                      control!.runtime.remaining_ms.session_ms / 1000
                    ),
                    daily: Math.floor(
                      control!.runtime.remaining_ms.daily_ms / 1000
                    ),
                  })}
                </p>
              )}
              <Button
                variant="secondary"
                isDisabled={state.busy || !permission!.allow_accumulation}
                onPress={() => void controller.disableAccumulation()}
              >
                {t('call.disableAccumulation', { scope })}
              </Button>
            </>
          )}
          {description && <p role="alert">{description}</p>}
          <div className={actionsCss}>
            <Button
              variant="secondary"
              isDisabled={state.busy || state.loading}
              onPress={() => void controller.refresh()}
            >
              {t('reload')}
            </Button>
            <Button
              variant="secondary"
              isDisabled={!snapshot || state.busy}
              onPress={() => setSettingsOpen(true)}
            >
              {t('call.settings')}
            </Button>
          </div>
        </div>
      </Dialog>
      {settingsOpen && snapshot && (
        <Dialog
          type="flex"
          aria-label={t('title')}
          isOpen
          onOpenChange={(value) => {
            setSettingsOpen(value)
            if (!value) void controller.refresh()
          }}
        >
          <div className={panelCss}>
            <VoiceprintSettingsPanel
              initialOrganizationId={snapshot.organization_id}
              initialOrganizationName={snapshot.organization_name}
            />
          </div>
        </Dialog>
      )}
    </div>
  )
}

const widgetCss = css({
  position: 'absolute',
  left: '1rem',
  top: '1rem',
  zIndex: 'sticky',
  maxWidth: 'calc(100% - 2rem)',
})
const panelCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  width: '30rem',
  maxWidth: 'calc(100vw - 5rem)',
  maxHeight: 'calc(100dvh - 5rem)',
  overflowY: 'auto',
  color: 'text.primary',
  '& p': { margin: 0 },
  '& h3': { margin: 0 },
})
const titleCss = css({
  margin: 0,
  paddingRight: '2rem',
  fontSize: '1.5rem',
  fontWeight: 'bold',
  lineHeight: 1.3,
})
const actionsCss = css({ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' })
