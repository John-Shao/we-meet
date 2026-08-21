import { css } from '@/styled-system/css'

import type { ApiTaskLabel, TaskLabelColor } from '../api/ApiTask'

const colors: Record<
  TaskLabelColor,
  { backgroundColor: string; color: string; borderColor: string }
> = {
  grey: {
    backgroundColor: 'greyscale.100',
    color: 'greyscale.700',
    borderColor: 'greyscale.300',
  },
  blue: {
    backgroundColor: 'primary.subtle',
    color: 'primary.subtle-text',
    borderColor: 'primary.subtle-border',
  },
  green: {
    backgroundColor: 'success.subtle',
    color: 'success.subtle-text',
    borderColor: 'success.subtle-border',
  },
  yellow: {
    backgroundColor: 'warning.subtle',
    color: 'warning.subtle-text',
    borderColor: 'warning.subtle-border',
  },
  orange: {
    backgroundColor: 'warning.subtle',
    color: 'warning.subtle-text',
    borderColor: 'warning.subtle-border',
  },
  red: {
    backgroundColor: 'danger.subtle',
    color: 'danger.subtle-text',
    borderColor: 'danger.subtle-border',
  },
  purple: {
    backgroundColor: 'brand.100',
    color: 'brand.800',
    borderColor: 'brand.300',
  },
}

export const TaskLabelBadge = ({ label }: { label: ApiTaskLabel }) => (
  <span
    data-label-color={label.color}
    className={css({
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '12rem',
      paddingX: '0.5rem',
      paddingY: '0.125rem',
      border: '1px solid',
      borderRadius: '999px',
      fontSize: '0.75rem',
      lineHeight: '1.25rem',
      fontWeight: '500',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      ...colors[label.color],
    })}
  >
    {label.name}
  </span>
)
