import { expect, it } from 'vitest'
import type { ApiMeetingRecord } from './api/ApiMeetingRecord'
import { recordSourceKey } from './recordSource'

type SourceStub = Pick<ApiMeetingRecord, 'source_type' | 'upload'>

const imported = (mediaType: 'audio' | 'video'): SourceStub => ({
  source_type: 'upload',
  upload: {
    media_type: mediaType,
    name: 'clip.mp4',
    size: 1024,
    status: 'succeeded',
  },
})

/**
 * 三个列表页与「录音信息」共用这一个来源标签:导入件必须按媒体类型细分,
 * 非导入件才落回 `library.source.*` 的通用标签。
 */
it('splits imported media by its media type', () => {
  expect(recordSourceKey(imported('video'))).toBe('upload.video')
  expect(recordSourceKey(imported('audio'))).toBe('upload.audio')
})

it('falls back to the generic label for every other source', () => {
  expect(recordSourceKey({ source_type: 'meeting' })).toBe(
    'library.source.meeting'
  )
  expect(recordSourceKey({ source_type: 'audio_recording' })).toBe(
    'library.source.audio_recording'
  )
})

/** 老记录可能缺 `upload` 明细:不能因此渲染成 `upload.undefined`。 */
it('treats a missing upload detail as audio', () => {
  expect(recordSourceKey({ source_type: 'upload' })).toBe('upload.audio')
})
