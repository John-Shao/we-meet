/**
 * 可添加的机器人类型(「添加机器人」弹窗的第一页)。
 *
 * A client-side constant while there is exactly one entry — an endpoint that
 * serves a single row is ceremony. It moves server-side when a second kind
 * (application bots from an open platform) actually exists.
 */
export const BOT_CATALOG = [
  {
    key: 'custom',
    nameKey: 'bots.catalog.custom',
    descKey: 'bots.catalog.customDesc',
  },
] as const

export type BotCatalogEntry = (typeof BOT_CATALOG)[number]
