import { fetchApi } from '@/api/fetchApi'

/**
 * 卡片按钮的点击与叠加层(二期 A2)。
 *
 * 服务端那侧的说明见 `core/api/im_cards.py`。这里只强调调用方要知道的两件事:
 *
 * 1. **请求里没有 cid,也没有 value。** 服务端按 mid 查自己的记录拿权威 cid,
 *    再拿它去 jusi 验成员资格。客户端说的一概不算。
 * 2. **转发副本点了会 404。** 转发产生新 mid、服务端没有它的按钮记录。
 *    我们本地已经剥掉了 actions(见 `richCard.stripActions`),所以正常路径
 *    走不到;404 是兜底不是常态。
 */

/** 一个 actions 块的定局结果。``once`` 块每块最多一条。 */
export interface CardBlockResolution {
  button_id: string
  text: string
  at: string
}

export interface CardState {
  mid: number
  expired: boolean
  /** ``block key``(``a0``/``a1``…) → 定局结果。``each`` 块永远不在这里。 */
  resolved: Record<string, CardBlockResolution>
}

/** 批量拉一屏卡片的叠加层。 */
export const fetchCardStates = (mids: number[]): Promise<{ states: CardState[] }> =>
  fetchApi<{ states: CardState[] }>('/im/cards/states/', {
    method: 'POST',
    body: JSON.stringify({ mids }),
  })

/**
 * 点一个按钮。``clickId`` 是幂等键 —— 同一次点击重试时带同一个值,服务端会
 * 重放上次的结果而不是再记一笔(与入站 webhook 的 X-Request-Id 同一个思路)。
 *
 * 409 = 这个 once 块已经被别人定局了。响应体里带着当前状态,所以调用方**不用
 * 再拉一次**就能把按钮换成结果条。
 */
export const clickCardButton = (
  mid: number,
  buttonId: string,
  clickId: string,
): Promise<{ replayed: boolean; state: CardState }> =>
  fetchApi<{ replayed: boolean; state: CardState }>(`/im/cards/${mid}/click/`, {
    method: 'POST',
    body: JSON.stringify({ button_id: buttonId, click_id: clickId }),
  })
