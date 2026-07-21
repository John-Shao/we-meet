import { proxy, subscribe } from 'valtio'
import {
  ProcessorConfig,
  ProcessorType,
} from '@/features/rooms/livekit/components/blur'
import {
  loadUserChoices,
  LocalUserChoices as LocalUserChoicesLK,
  saveUserChoices,
} from '@livekit/components-core'
import { VideoQuality } from 'livekit-client'
import type { VideoCodec } from 'livekit-client'

export type VideoResolution = 'h720' | 'h360' | 'h180'

/** P8 会议设置:Web 端可选发布编解码(浏览器广泛支持的子集;App 端另有
 *  H.265,Web SDK/浏览器编码不支持故不提供)。 */
export const VIDEO_PUBLISH_CODECS = ['h264', 'vp8', 'vp9'] as const

export type LocalUserChoices = LocalUserChoicesLK & {
  processorConfig?: ProcessorConfig
  noiseReductionEnabled?: boolean
  audioOutputDeviceId?: string
  videoPublishResolution?: VideoResolution
  videoSubscribeQuality?: VideoQuality
  /** P8 会议设置:发布端视频编解码,下一次加入会议时生效。 */
  videoPublishCodec?: VideoCodec
}

function getUserChoicesState(): LocalUserChoices {
  return {
    noiseReductionEnabled: false,
    audioOutputDeviceId: 'default', // Use 'default' to match LiveKit's standard device selection behavior
    videoPublishResolution: 'h720',
    videoSubscribeQuality: VideoQuality.HIGH,
    videoPublishCodec: 'vp9', // 保持既有默认(Conference 原来写死 vp9)
    ...loadUserChoices(),
  }
}

export const userChoicesStore = proxy<LocalUserChoices>(getUserChoicesState())
subscribe(userChoicesStore, () => {
  saveUserChoices(userChoicesStore, false)
})

// we run some logic on store loading to check if the processor config is still valid
if (userChoicesStore.processorConfig?.type === ProcessorType.VIRTUAL) {
  if (userChoicesStore.processorConfig.imagePath.startsWith('blob:')) {
    // this happens when a not authenticated user had changed their background image
    // we restore clear the processor config to avoid displaying a black screen.
    userChoicesStore.processorConfig = undefined
  } else if (userChoicesStore.processorConfig.fileId) {
    // Checking if the image is still available / accessible
    await fetch(userChoicesStore.processorConfig.imagePath, {
      // We bypass the cache to ensure we have access
      cache: 'reload',
    })
      .then((response) => {
        // if we cannot fetch the image (likely a 401 from the backend because
        // the user is not logged in anymore, etc.),
        // we clear the processor config to avoid displaying a black screen.
        // This can happen when the user logs out for instance, etc.
        if (!response.ok) {
          userChoicesStore.processorConfig = undefined
        }
      })
      .catch(() => {
        userChoicesStore.processorConfig = undefined
      })
  }
}
