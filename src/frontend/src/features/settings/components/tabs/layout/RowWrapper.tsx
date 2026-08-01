import { ReactNode } from 'react'
import { H } from '@/primitives'
import { HStack } from '@/styled-system/jsx'
import { css } from '@/styled-system/css'

export type RowWrapperProps = {
  heading?: string
  children: ReactNode[]
  beta?: boolean
}

const BetaBadge = () => (
  <span
    className={css({
      content: '"Beta"',
      display: 'block',
      letterSpacing: '-0.02rem',
      padding: '0 0.25rem',
      // 蓝色 Beta 徽标:浅色浅蓝底/中蓝字,深色翻到 primaryDark 暗蓝底/亮蓝字。
      backgroundColor: 'primary.50',
      color: 'primary.700',
      _dark: { backgroundColor: 'primaryDark.100', color: 'primaryDark.700' },
      fontSize: '0.75rem',
      fontWeight: 500,
      margin: '0 0 0.9375rem 0.3125rem',
      lineHeight: '1rem',
      borderRadius: '4px',
      width: 'fit-content',
      height: 'fit-content',
      marginTop: { base: '10px', sm: '5px' },
    })}
  >
    Beta
  </span>
)

export const RowWrapper = ({ heading, children, beta }: RowWrapperProps) => {
  return (
    <>
      {heading && (
        <HStack>
          <H lvl={2}>{heading}</H>
          {beta && <BetaBadge />}
        </HStack>
      )}
      <HStack
        gap={0}
        style={{
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            flex: '1 1 215px',
            minWidth: 0,
          }}
        >
          {children[0]}
        </div>
        <div
          style={{
            width: '10rem',
            justifyContent: 'center',
            display: 'flex',
            paddingLeft: '1.5rem',
          }}
        >
          {children[1]}
        </div>
      </HStack>
    </>
  )
}
