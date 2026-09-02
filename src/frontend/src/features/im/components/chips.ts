import { chipRecipe } from '@/primitives/chipRecipe'

/**
 * Inline chips used next to a name — group owner, departed member, bot.
 *
 * Extracted when the bot badge became the third copy of the same six
 * declarations. They are class constants rather than a component because every
 * use site already sits inside a flex row and only differs by its label.
 */

/** Emphasis chip (群主). */
export const brandChipCls = chipRecipe({ tone: 'brand', size: 'sm' })

/**
 * Neutral chip (已离职, 机器人).
 *
 * Deliberately greyscale rather than error/warning: neither "this person left"
 * nor "this is a bot" is an error state. `error.*` is also an inverted scale
 * (100 is the darkest), so copying the brand chip with `error.50` yields an
 * invalid token and a silently dropped background.
 */
export const neutralChipCls = chipRecipe({ tone: 'neutral', size: 'sm' })
