// 内容标题栏的**共享源码级规则**,被 `check-title-bar.mjs`(六个 TitleBar 调用点)与
// `check-calendar-title-bar.mjs`(日历那条自己排的 header)复用。
//
// 规则出处:
//   · `docs/component-system.md` §「图标按钮」—— 纯图标操作统一使用 `IconButton`,
//     只走 icon24/28/32 三档,普通动作配 `quaternaryText`(危险动作 `quaternaryDanger`);
//   · `docs/reviews/meetings-ux-migration-2026-09-16.md` §3.27 的基准表 ——
//     主操作 `primary + action + 18px 图标`、次操作 `secondaryText + action + 18px 图标`、
//     纯图标 `icon32`,以及「每页只有一个主操作(品牌蓝实底 + 18px 图标)」。
//
// 这里钉的是静态可查、且曾经真的漏出去过的几条:
//   ① 标题栏区块必须**取对** —— 见 `extractElementInner` 的注释(旧实现取到第一个
//      子元素的 `/>` 就收尾,区间里一个按钮都没有,检查是空转的);
//   ② 区块里不出现 `size="dense"`;
//   ③ 纯图标钮必须走基元 `IconButton`(不再手搓方形热区/悬停色/焦点环);
//   ④ 纯图标钮不得借用品牌蓝 —— 既不能用主操作的实底(`primary`),也不能用选中态
//      容器色(`tertiary` = `action.selected`)。2026-09-19 之前「任务」标题栏的齿轮
//      写的就是 `variant="tertiary"`:浅蓝底(`action.selected.bg`)+ 品牌蓝图
//      (`action.selected.text`),一颗常驻、并未选中的齿轮看起来一直「激活」,
//      标题栏里也多出一块品牌蓝强调。

const ICON_SIZES = ['icon24', 'icon28', 'icon32']
/** 品牌蓝系:实心主按钮底与选中态容器色。纯图标钮都不该用。 */
const BRAND_BLUE_VARIANTS = ['primary', 'tertiary', 'primaryDark']

/**
 * 从 `start` 处的 `<Tag` 起,找到**这个开标签自己的**结尾 `>`。
 *
 * 逐字符前进,跳过 `"" / '' / `` ` `` 里的内容,并用 `{} / () / []` 配平 —— 这样
 * `onPress={() => { … }}` 里的 `>` 与 `meta={<>…</>}` 里的 `>` 都不会被误判为标签结束。
 *
 * @returns {number} `>` 的下标;没找到返回 -1
 */
const findOpeningTagEnd = (source, start) => {
  let depth = 0
  let quote = null
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{' || char === '(' || char === '[') depth++
    else if (char === '}' || char === ')' || char === ']') depth--
    else if (char === '>' && depth === 0) return index
  }
  return -1
}

/**
 * 取出一个 JSX 元素的**子内容**(开标签之后 → 对应闭合标签之前)。
 *
 * 为什么不能像旧实现那样写 `source.indexOf('/>', start)` 当收尾:`<TitleBar
 * title={…} meta={…}>` 的**第一个** `/>` 属于它内部第一个自闭合子元素(比如
 * `icon={<RiInboxUnarchiveLine size={18} aria-hidden="true" />}`),于是切出来的
 * 「区块」只有两百来字符、一个按钮都没有 —— 那条「标题栏里不出现 dense」实际是空转的,
 * §3.27 里说要拦的那几处也正是这样漏出去的(2026-09-19 实测六个调用点 block 长度
 * 239–589,含 0 个 icon 档按钮;换成这里之后是 222–3486,能扫到按钮)。
 *
 * @param {string} source 源文件内容
 * @param {string} tagName 元素名(如 `TitleBar`)
 * @param {number} [from] 从哪个下标开始找这个元素(同一文件里有多个同类元素时用)
 * @returns {string|null} 子内容;自闭合元素返回 `''`;找不到元素返回 `null`
 */
export const extractElementInner = (source, tagName, from = 0) => {
  const start = source.indexOf(`<${tagName}`, from)
  if (start < 0) return null
  const tagEnd = findOpeningTagEnd(source, start)
  if (tagEnd < 0) return null
  if (source[tagEnd - 1] === '/') return ''
  const close = source.indexOf(`</${tagName}>`, tagEnd)
  return source.slice(tagEnd + 1, close < 0 ? source.length : close)
}

/**
 * 逐个扫出区块里的按钮**开标签**。
 *
 * 不按固定窗口长度猜「附近有没有 variant」—— 标题栏里主操作与齿轮常常只隔十几行,
 * 猜窗口必然误报或漏报,所以按标签边界精确切。
 */
const buttonOpeningTags = (block) => {
  const tags = []
  const matcher = /<(IconButton|IconToggleButton|Button|ToggleButton)\b/g
  let match
  while ((match = matcher.exec(block))) {
    const index = findOpeningTagEnd(block, match.index)
    if (index < 0) break
    tags.push({
      name: match[1],
      text: block.slice(match.index, index + 1),
      index: match.index,
      line: block.slice(0, match.index).split('\n').length,
    })
    matcher.lastIndex = index + 1
  }
  return tags
}

/**
 * @param {string} block 标题栏区块(子内容,来自 `extractElementInner`)
 * @param {string} label 报错里用的页面名
 * @returns {string[]} 违规说明;空数组 = 通过
 */
export const findTitleBarButtonViolations = (block, label) => {
  const failures = []
  const tags = buttonOpeningTags(block)
  // 先定位主操作再逐个比位置:只走一趟的话,「图标在主操作**前面**」这个情形里
  // 主操作还没出现过,顺序规则永远不会命中(这正是要拦的那种写法)。
  const primary = tags.find((tag) => /variant="primary"/.test(tag.text))
  const primaryAt = primary ? primary.index : -1

  for (const tag of tags) {
    const size = tag.text.match(
      new RegExp(`size="(${ICON_SIZES.join('|')})"`)
    )?.[1]
    if (!size) continue

    if (!tag.name.startsWith('Icon')) {
      failures.push(
        `${label}: 标题栏里的纯图标钮(${size},第 ${tag.line} 行附近)用的是 <${tag.name}>,` +
          `应改用基元 <IconButton>(label 一处给出无障碍名 + Tooltip,悬停色与焦点环由基元统一)`
      )
      continue
    }

    const variant = tag.text.match(/variant="([^"]+)"/)?.[1]
    if (BRAND_BLUE_VARIANTS.includes(variant)) {
      failures.push(
        `${label}: 标题栏里的纯图标钮(${size},第 ${tag.line} 行附近)带了 variant="${variant}" —— ` +
          `那是品牌蓝实底 / 选中态容器色,会让未选中的图标看起来一直「激活」,` +
          `也与「每页只有一个主操作」冲突。走 <IconButton> 的默认 quaternaryText(删除类 quaternaryDanger)`
      )
    }

    // §3.29 的顺序:主操作贴左、纯图标次操作收在最右(「日历」那条栏是基准;
    // `check-calendar-title-bar.mjs` 另有一条真实浏览器的「齿轮在主操作右侧」断言)。
    if (primaryAt >= 0 && tag.index < primaryAt) {
      failures.push(
        `${label}: 纯图标钮(${size},第 ${tag.line} 行附近)排在主操作**左侧** —— ` +
          `标题栏的顺序是「主操作贴左、齿轮在最右」(见 3.29「日历」那条栏),应挪到主操作之后`
      )
    }
  }
  return failures
}

/** 标题栏里不出现 `dense` 档按钮(比同排小一号,见 §3.27)。 */
export const findDenseButtons = (block, label) =>
  block.includes('size="dense"')
    ? [`${label}: 标题栏里用了 dense 档按钮,应改用 action`]
    : []
