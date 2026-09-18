import type { ApiMeetingRecord } from './api/ApiMeetingRecord'

/**
 * 记录来源标签的 i18n key。导入件按媒体类型细分成 `upload.audio` / `upload.video`。
 *
 * 三个列表页与「录音信息」必须同一口径:同一条记录在「AI 录音」页写的是
 * `upload.video`,到了记录库却退回笼统的 `library.source.upload`,同一条记录就
 * 有了两个说法。而且导入件在两个库里共用一个通用图标(见 `recordIcon`),音视频
 * 之分只能靠这行字。
 *
 * 来源**筛选器**拿不到媒体类型(只有 `source_type` 枚举),仍旧直接用
 * `library.source.*` —— 那一档的「导入文件」是通用标签。
 */
export const recordSourceKey = (
  record: Pick<ApiMeetingRecord, 'source_type' | 'upload'>
): string =>
  record.source_type === 'upload'
    ? `upload.${record.upload?.media_type ?? 'audio'}`
    : `library.source.${record.source_type}`
