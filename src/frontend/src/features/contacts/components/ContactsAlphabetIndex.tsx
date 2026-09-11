import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'

import type { DirectoryLetter } from '../api/fetchDirectoryMembers'

/** '#' 那一桶(数字/符号/空名字)在服务端叫 OTHER_INITIAL,前端只认这个字面量。 */
export const OTHER_INITIAL = '#'

const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', OTHER_INITIAL]

interface Props {
  /** 服务端给的首字母计数:决定哪些字母可点。 */
  letters: DirectoryLetter[]
  /** 当前起点字母(URL 里的 from_initial),没有就是 null。 */
  active: string | null
  /** 点一个字母 = 从它开始;再点一次同一个 = 取消起点。 */
  onPick: (letter: string) => void
}

/**
 * 通讯录右侧的 A–Z 索引条。
 *
 * 上千人的名册里靠滚动找人不现实,这里按**拼音**首字母给一条竖索引。字母的可用性
 * 与人数都来自服务端(``/directory/members/alphabet/``),前端不自己算拼音 —— 否则
 * 「服务端按拼音排、前端按自己算的字母分组」迟早错位(改过名字、换过 pypinyin 版本)。
 *
 * 点一个字母是「从它开始」而不是「只看它」:起点之后一路往下滚还能到 Z,不必为看
 * 后面几个字母反复点。再点一次同一个字母就取消起点(回到整册)。
 */
export const ContactsAlphabetIndex = ({ letters, active, onPick }: Props) => {
  const { t } = useTranslation('contacts')
  const counts = new Map(letters.map((item) => [item.letter, item.count]))

  return (
    <div className={railCls} role="group" aria-label={t('page.alphabetAria')}>
      {ALPHABET.map((letter) => {
        const count = counts.get(letter) ?? 0
        const empty = count === 0
        const isActive = active === letter
        const label = letter === OTHER_INITIAL ? t('page.otherInitial') : letter
        return (
          <button
            key={letter}
            type="button"
            disabled={empty}
            aria-pressed={isActive}
            aria-label={
              isActive
                ? t('page.alphabetClearLetter', { letter: label })
                : t('page.alphabetLetter', { letter: label })
            }
            title={`${label} · ${t('page.count', { count })}`}
            data-testid={`contacts-alphabet-${letter}`}
            onClick={() => onPick(letter)}
            className={cx(
              railBtnCls,
              css({
                color: isActive
                  ? 'selected.text'
                  : empty
                    ? 'greyscale.300'
                    : 'greyscale.600',
                backgroundColor: isActive ? 'selected.bg' : 'transparent',
                fontWeight: isActive ? 'bold' : undefined,
                cursor: empty ? 'default' : 'pointer',
                _hover: empty ? {} : { color: 'selected.text' },
              })
            )}
          >
            {letter}
          </button>
        )
      })}
    </div>
  )
}

const railCls = css({
  flexShrink: 0,
  width: '1.125rem',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  paddingY: '0.375rem',
})
const railBtnCls = css({
  // 27 个字母铺满可用高度,单个不超过 18px —— 视口矮时整体收窄,而不是被裁掉
  // 半截字母表(索引条被截掉是最糟的:用户以为后面没有字母了)。
  flex: '1 1 0',
  minHeight: 0,
  maxHeight: '1.125rem',
  width: '1.125rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: '4px',
  background: 'transparent',
  fontSize: '0.625rem',
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
})
