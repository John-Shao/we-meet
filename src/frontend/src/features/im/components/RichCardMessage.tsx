import { css } from '@/styled-system/css'

import type { CardState } from '../api/cardStates'
import {
  actionsBlockKey,
  parseRichCard,
  type CardSpan,
  type CardTheme,
} from './richCard'

/**
 * `rich-card` 气泡内容(群机器人经 webhook 发来的块级卡片)。
 *
 * 与 [RichTextBody] 一样挂在**气泡内层**而不是自成卡片行 —— 白拿表情回应、
 * 已读回执、右键菜单、多选、时间戳、头像整套设施。三个业务卡片组件各自重写过
 * 一遍那套,没有第五遍的必要。
 *
 * ## 配色红线(改这里前先读完)
 *
 * header 的 5 档语义走 panda 的 `{primary|success|warning|danger}.subtle`
 * 三件套,neutral 走 `greyscale.100/700/300`。**明令禁止**:
 *
 * - `primary.50` / `success.100` / `danger.100` —— 那批数字档**不翻转**,
 *   深色模式下会白底黑字糊在暗色气泡里
 * - `warning.100` —— **根本不存在**。panda 静默产出一条非法声明,背景直接
 *   没了(IM 连接状态条「重连中」栽过)
 * - `error.*` —— 是反向色阶,一律不用
 *
 * 另外:主题类**必须是完整的 `css()` 调用查表**,不能写成
 * `css({ backgroundColor: map[theme] })` —— panda 是静态提取,动态取值一个
 * 原子类都不会生成,页面上看着有色纯属别处顺带带出来的。
 */

const HEADER_CLS: Record<CardTheme, string> = {
  info: css({
    backgroundColor: 'primary.subtle',
    color: 'primary.subtle-text',
    borderBottomColor: 'primary.subtle-border',
  }),
  success: css({
    backgroundColor: 'success.subtle',
    color: 'success.subtle-text',
    borderBottomColor: 'success.subtle-border',
  }),
  warning: css({
    backgroundColor: 'warning.subtle',
    color: 'warning.subtle-text',
    borderBottomColor: 'warning.subtle-border',
  }),
  danger: css({
    backgroundColor: 'danger.subtle',
    color: 'danger.subtle-text',
    borderBottomColor: 'danger.subtle-border',
  }),
  neutral: css({
    backgroundColor: 'greyscale.100',
    color: 'greyscale.700',
    borderBottomColor: 'greyscale.300',
  }),
}

const BUTTON_CLS = {
  default: css({
    borderColor: 'greyscale.300',
    color: 'greyscale.800',
    _hover: { backgroundColor: 'greyscale.100' },
  }),
  primary: css({
    borderColor: 'primary.subtle-border',
    color: 'primary.subtle-text',
    backgroundColor: 'primary.subtle',
    _hover: { borderColor: 'primary.500' },
  }),
  danger: css({
    borderColor: 'danger.subtle-border',
    color: 'danger.subtle-text',
    backgroundColor: 'danger.subtle',
    _hover: { borderColor: 'danger.500' },
  }),
} as const

const shellCls = css({
  display: 'flex',
  flexDirection: 'column',
  minWidth: '15rem',
  maxWidth: '22rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '0.5rem',
  overflow: 'hidden',
  backgroundColor: 'greyscale.000',
})

const headerBaseCls = css({
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderBottomWidth: '1px',
  borderBottomStyle: 'solid',
  fontWeight: 'bold',
  fontSize: '0.875rem',
})

const bodyCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem',
  color: 'greyscale.900',
  fontSize: '0.875rem',
})

const fieldsCls = css({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0.5rem 0.75rem',
})

const fieldLabelCls = css({
  fontSize: '0.75rem',
  color: 'greyscale.600',
})

/** 奇数项的最后一项跨列 —— 否则右边空一格,看着像少了内容。 */
const fieldSpanCls = css({ gridColumn: '1 / -1' })

const actionsCls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  marginTop: '0.125rem',
})

/** 定局后原地替换按钮的结果条 —— 与「已同意」这类文案同一档灰。 */
const resultCls = css({
  paddingX: '0.625rem',
  paddingY: '0.375rem',
  borderRadius: '6px',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  lineHeight: '1.25rem',
})

const buttonBaseCls = css({
  paddingX: '0.75rem',
  paddingY: '0.375rem',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
  fontSize: '0.8125rem',
  lineHeight: '1.25rem',
  cursor: 'pointer',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
})

const Spans = ({ spans }: { spans: CardSpan[] }) => (
  <>
    {spans.map((span, i) => {
      if (span.tag === 'a') {
        return (
          <a
            key={i}
            href={span.href}
            target="_blank"
            rel="noopener noreferrer"
            className={css({
              color: 'primary.600',
              textDecoration: 'underline',
            })}
          >
            {span.text}
          </a>
        )
      }
      if (span.tag === 'at') {
        return (
          <span key={i} className={css({ fontWeight: 'bold', color: 'primary.600' })}>
            @{span.name}
          </span>
        )
      }
      return (
        <span
          key={i}
          className={css({})}
          style={{
            fontWeight: span.b ? 700 : undefined,
            fontStyle: span.i ? 'italic' : undefined,
          }}
        >
          {span.text}
        </span>
      )
    })}
  </>
)

export const RichCardMessage = ({
  raw,
  state,
  onClickButton,
}: {
  raw: string
  /**
   * 服务端的叠加层。**它是唯一真相** —— ws 的 card-state 可能早于点击接口的
   * HTTP 响应到达,所以这里绝不做「时间戳新的赢」的本地合并(见 useCardStates)。
   */
  state?: CardState
  /** 点一个 callback 按钮。缺省时按钮渲染成禁用态(比如引用/转发的场景)。 */
  onClickButton?: (buttonId: string) => void
}) => {
  const body = parseRichCard(raw)
  // 坏数据不能把气泡变空 —— 与卡片组件同一种降级。
  if (!body) return <>{raw}</>

  return (
    <div className={shellCls} data-testid="rich-card">
      {body.header && (
        <div className={`${headerBaseCls} ${HEADER_CLS[body.header.theme]}`}>
          {body.header.title}
        </div>
      )}
      <div className={bodyCls}>
        {body.blocks.map((block, bi) => {
          if (block.type === 'divider') {
            return (
              <hr
                key={bi}
                className={css({
                  border: 'none',
                  borderTop: '1px solid token(colors.greyscale.200)',
                  margin: 0,
                })}
              />
            )
          }
          if (block.type === 'text') {
            return (
              <p key={bi} className={css({ margin: 0, whiteSpace: 'pre-wrap' })}>
                <Spans spans={block.spans} />
              </p>
            )
          }
          if (block.type === 'fields') {
            const odd = block.items.length % 2 === 1
            return (
              <div key={bi} className={fieldsCls}>
                {block.items.map((item, ii) => (
                  <div
                    key={ii}
                    className={
                      odd && ii === block.items.length - 1 ? fieldSpanCls : undefined
                    }
                  >
                    {item.label && (
                      <div className={fieldLabelCls}>{item.label}</div>
                    )}
                    <div>{item.value}</div>
                  </div>
                ))}
              </div>
            )
          }
          // 定局之后**原地换成结果条**,而不是把按钮置灰留在那 —— 留着会让
          // 人以为还能改。block key 的推导是三端契约,见 actionsBlockKey。
          const blockKey = actionsBlockKey(body.blocks, bi)
          const resolution = state?.resolved?.[blockKey]
          if (resolution) {
            return (
              <div key={bi} className={actionsCls}>
                <span className={resultCls} data-testid={`card-resolved-${blockKey}`}>
                  {resolution.text}
                </span>
              </div>
            )
          }
          return (
            <div key={bi} className={actionsCls}>
              {block.buttons.map((button) =>
                button.action === 'url' ? (
                  <a
                    key={button.id}
                    href={button.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`card-button-${button.id}`}
                    className={`${buttonBaseCls} ${BUTTON_CLS[button.style]}`}
                  >
                    {button.text}
                  </a>
                ) : (
                  // callback 按钮:点了走服务端记账 + 广播(A2)。没有 onClick
                  // 的场合(引用、转发预览)渲染成禁用态 —— 一个点了没反应的
                  // 按钮比一个明摆着不能点的按钮更糟。
                  <button
                    key={button.id}
                    type="button"
                    disabled={!onClickButton || state?.expired}
                    onClick={() => onClickButton?.(button.id)}
                    data-testid={`card-button-${button.id}`}
                    className={`${buttonBaseCls} ${BUTTON_CLS[button.style]} ${
                      !onClickButton || state?.expired
                        ? css({ opacity: 0.5, cursor: 'default' })
                        : ''
                    }`}
                  >
                    {button.text}
                  </button>
                ),
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
