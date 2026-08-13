import {
  FeedbackRoute,
  RoomRoute,
  flexibleRoomIdPattern,
} from '@/features/rooms'
import { HomeRoute } from '@/features/home'
import { LegalTermsRoute } from '@/features/legalsTerms/LegalTermsRoute'
import { AccessibilityRoute } from '@/features/legalsTerms/Accessibility'
import { TermsOfServiceRoute } from '@/features/legalsTerms/TermsOfService'
import { CreatePopup } from '@/features/sdk/routes/CreatePopup'
import { CreateMeetingButton } from '@/features/sdk/routes/CreateMeetingButton'
import { RecordingDownloadRoute } from '@/features/recording'
import { MeetingDetailRoute } from '@/features/meetings'
import { ImRoute } from '@/features/im'
import { ContactsRoute } from '@/features/contacts'
import { CalendarRoute, CalendarSubscribeRoute } from '@/features/calendar'
import { ApprovalRoute } from '@/features/approval'
import { DocsRoute } from '@/features/docs'
import { InviteRoute } from '@/features/invite'

const roomIdRegex = new RegExp(`^[/](?<roomId>${flexibleRoomIdPattern})$`)

// 分享云文档到聊天:卡片「查看文档」需要深链到具体文档,而不只是文档列表首页。
const docIdRegex =
  /^\/docs(?:\/(?<docId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/

export const routes: Record<
  | 'home'
  | 'room'
  | 'feedback'
  | 'legalTerms'
  | 'accessibility'
  | 'termsOfService'
  | 'sdkCreatePopup'
  | 'sdkCreateButton'
  | 'recordingDownload'
  | 'meetingDetail'
  | 'im'
  | 'contacts'
  | 'calendar'
  | 'calendarSubscribe'
  | 'approval'
  | 'docs'
  | 'invite',
  {
    name: RouteName
    path: RegExp | string
    Component: () => JSX.Element
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    to?: (...args: any[]) => string | URL
  }
> = {
  home: {
    name: 'home',
    // 视频会议主页迁到 /meeting;根路径 "/" 在 App.tsx 重定向到此。
    path: '/meeting',
    Component: HomeRoute,
  },
  room: {
    name: 'room',
    to: (roomId: string) => `/${roomId.trim()}`,
    path: roomIdRegex,
    Component: RoomRoute,
  },
  feedback: {
    name: 'feedback',
    path: '/feedback',
    Component: FeedbackRoute,
  },
  legalTerms: {
    name: 'legalTerms',
    path: '/mentions-legales',
    Component: LegalTermsRoute,
  },
  accessibility: {
    name: 'accessibility',
    path: '/accessibilite',
    Component: AccessibilityRoute,
  },
  termsOfService: {
    name: 'termsOfService',
    path: '/conditions-utilisation',
    Component: TermsOfServiceRoute,
  },
  sdkCreatePopup: {
    name: 'sdkCreatePopup',
    path: '/sdk/create-popup',
    Component: CreatePopup,
  },
  sdkCreateButton: {
    name: 'sdkCreateButton',
    path: '/sdk/create-button',
    Component: CreateMeetingButton,
  },
  recordingDownload: {
    name: 'recordingDownload',
    path: /^\/recording\/(?<recordingId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    to: (recordingId: string) => `/recording/${recordingId.trim()}`,
    Component: RecordingDownloadRoute,
  },
  meetingDetail: {
    name: 'meetingDetail',
    path: /^\/meetings\/(?<roomId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    to: (roomId: string) => `/meetings/${roomId.trim()}`,
    Component: MeetingDetailRoute,
  },
  im: {
    name: 'im',
    path: '/im',
    Component: ImRoute,
  },
  contacts: {
    name: 'contacts',
    path: '/contacts',
    Component: ContactsRoute,
  },
  calendar: {
    name: 'calendar',
    path: '/calendar',
    Component: CalendarRoute,
  },
  calendarSubscribe: {
    name: 'calendarSubscribe',
    path: '/calendar/subscribe/:token',
    Component: CalendarSubscribeRoute,
  },
  approval: {
    name: 'approval',
    path: '/approval',
    Component: ApprovalRoute,
  },
  docs: {
    name: 'docs',
    path: docIdRegex,
    to: (docId?: string) => (docId ? `/docs/${docId.trim()}` : '/docs'),
    Component: DocsRoute,
  },
  // 邀请落地页 —— 收到链接的人多半还没登录,所以这一页**必须匿名可开**。
  // Layout 已按 isLoggedIn 分支处理匿名态,不要为它再造一套根树。
  invite: {
    name: 'invite',
    path: '/invite/:code',
    to: (code: string) => `/invite/${code.trim()}`,
    Component: InviteRoute,
  },
}

export type RouteName = keyof typeof routes
