import { RiArrowDownSLine, RiCheckLine, RiCloseLine } from '@remixicon/react'
import { Button as AriaButton } from 'react-aria-components'
import { useTranslation } from 'react-i18next'

import { Popover } from '@/primitives'
import { css } from '@/styled-system/css'
import { useDirectoryMemberSearch } from '@/features/contacts'

import type {
  TaskSearchDue,
  TaskSearchFilters as TaskSearchFilterValues,
  TaskSearchStatus,
} from '../api/searchTasks'

export type TaskSearchPeople = Map<string, string>

export interface TaskSearchPeopleFilters {
  creators: TaskSearchPeople
  assignees: TaskSearchPeople
  followers: TaskSearchPeople
}

interface Props {
  filters: TaskSearchFilterValues
  people: TaskSearchPeopleFilters
  onFiltersChange: (filters: TaskSearchFilterValues) => void
  onPeopleChange: (people: TaskSearchPeopleFilters) => void
  onClear: () => void
}

export const TaskSearchFilters = ({
  filters,
  people,
  onFiltersChange,
  onPeopleChange,
  onClear,
}: Props) => {
  const { t } = useTranslation('shell')
  const hasFilters =
    filters.status !== 'all' ||
    filters.due !== 'all' ||
    filters.creatorIds.length > 0 ||
    filters.assigneeIds.length > 0 ||
    filters.followerIds.length > 0

  return (
    <div
      className={filterRowCls}
      role="group"
      aria-label={t('search.taskFilters')}
      data-testid="global-search-task-filters"
    >
      <PeopleFilter
        label={t('search.taskCreator')}
        selected={people.creators}
        testId="creator"
        onChange={(creators) => {
          onPeopleChange({ ...people, creators })
          onFiltersChange({ ...filters, creatorIds: [...creators.keys()] })
        }}
      />
      <PeopleFilter
        label={t('search.taskAssignee')}
        selected={people.assignees}
        testId="assignee"
        onChange={(assignees) => {
          onPeopleChange({ ...people, assignees })
          onFiltersChange({ ...filters, assigneeIds: [...assignees.keys()] })
        }}
      />
      <ChoiceFilter<TaskSearchStatus>
        label={t('search.taskStatus')}
        value={filters.status}
        testId="status"
        options={[
          ['all', t('search.taskStatusAll')],
          ['todo', t('search.taskStatusTodo')],
          ['completed', t('search.taskStatusCompleted')],
        ]}
        onChange={(status) => onFiltersChange({ ...filters, status })}
      />
      <ChoiceFilter<TaskSearchDue>
        label={t('search.taskDue')}
        value={filters.due}
        testId="due"
        options={[
          ['all', t('search.taskDueAll')],
          ['today', t('search.taskDueToday')],
          ['tomorrow', t('search.taskDueTomorrow')],
          ['this_week', t('search.taskDueThisWeek')],
          ['overdue', t('search.taskDueOverdue')],
          ['no_date', t('search.taskDueNoDate')],
        ]}
        onChange={(due) => onFiltersChange({ ...filters, due })}
      />
      <PeopleFilter
        label={t('search.taskFollower')}
        selected={people.followers}
        testId="follower"
        onChange={(followers) => {
          onPeopleChange({ ...people, followers })
          onFiltersChange({ ...filters, followerIds: [...followers.keys()] })
        }}
      />
      {hasFilters && (
        <button
          type="button"
          onClick={onClear}
          className={clearCls}
          data-testid="global-search-task-clear-filters"
        >
          <RiCloseLine size={14} aria-hidden="true" />
          {t('search.clearFilters')}
        </button>
      )}
    </div>
  )
}

const PeopleFilter = ({
  label,
  selected,
  testId,
  onChange,
}: {
  label: string
  selected: TaskSearchPeople
  testId: string
  onChange: (selected: TaskSearchPeople) => void
}) => {
  const { t } = useTranslation('shell')
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch({
    includeSelf: true,
  })
  const selectedLabels = [...selected.values()]
  const triggerLabel =
    selectedLabels.length === 0
      ? label
      : selectedLabels.length === 1
        ? selectedLabels[0]
        : `${label} · ${selectedLabels.length}`

  return (
    <Popover aria-label={label} withArrow={false}>
      <AriaButton
        className={filterTriggerCls}
        data-testid={`global-search-task-filter-${testId}`}
      >
        <span className={truncateCls}>{triggerLabel}</span>
        <RiArrowDownSLine size={14} aria-hidden="true" />
      </AriaButton>
      <div className={peoplePanelCls}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('search.taskPeoplePlaceholder')}
          aria-label={t('search.taskPeoplePlaceholder')}
          className={peopleSearchCls}
          data-testid={`global-search-task-filter-${testId}-search`}
        />
        <div
          className={peopleListCls}
          role="listbox"
          aria-multiselectable="true"
        >
          {isFetching && selectable.length === 0 ? (
            <p className={peopleHintCls}>{t('search.loading')}</p>
          ) : selectable.length === 0 ? (
            <p className={peopleHintCls}>{t('search.empty')}</p>
          ) : (
            selectable.map((member) => {
              const memberLabel =
                member.full_name ||
                member.short_name ||
                member.email ||
                member.id
              const checked = selected.has(member.id)
              const selectionLimitReached = !checked && selected.size >= 20
              return (
                <button
                  key={member.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  disabled={selectionLimitReached}
                  onClick={() => {
                    const next = new Map(selected)
                    if (checked) next.delete(member.id)
                    else next.set(member.id, memberLabel)
                    onChange(next)
                  }}
                  className={peopleRowCls}
                  data-testid={`global-search-task-filter-${testId}-option-${member.id}`}
                >
                  <span className={avatarCls}>
                    {member.avatar_url ? (
                      <img src={member.avatar_url} alt="" />
                    ) : (
                      memberLabel.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className={truncateCls}>{memberLabel}</span>
                  {checked && <RiCheckLine size={16} aria-hidden="true" />}
                </button>
              )
            })
          )}
        </div>
      </div>
    </Popover>
  )
}

const ChoiceFilter = <T extends string>({
  label,
  value,
  options,
  testId,
  onChange,
}: {
  label: string
  value: T
  options: Array<[T, string]>
  testId: string
  onChange: (value: T) => void
}) => {
  const selectedLabel = options.find(([candidate]) => candidate === value)?.[1]
  return (
    <Popover aria-label={label} withArrow={false}>
      <AriaButton
        className={filterTriggerCls}
        data-testid={`global-search-task-filter-${testId}`}
      >
        <span className={truncateCls}>
          {value === 'all' ? label : selectedLabel}
        </span>
        <RiArrowDownSLine size={14} aria-hidden="true" />
      </AriaButton>
      {({ close }) => (
        <div className={choicePanelCls} role="listbox" aria-label={label}>
          {options.map(([option, optionLabel]) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              onClick={() => {
                onChange(option)
                close()
              }}
              className={choiceRowCls}
              data-testid={`global-search-task-filter-${testId}-${option}`}
            >
              <span>{optionLabel}</span>
              {option === value && <RiCheckLine size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

const filterRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.5rem 1rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  overflowX: 'auto',
})
const filterTriggerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.25rem',
  maxWidth: '8.75rem',
  minWidth: '4.5rem',
  height: '1.875rem',
  paddingX: '0.625rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '999px',
  bg: 'greyscale.000',
  color: 'greyscale.700',
  fontSize: '0.75rem',
  cursor: 'pointer',
  _hover: { bg: 'greyscale.100' },
  _disabled: { cursor: 'not-allowed', opacity: 0.5 },
})
const truncateCls = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const clearCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  flexShrink: 0,
  border: 'none',
  bg: 'transparent',
  color: 'primary.500',
  fontSize: '0.75rem',
  cursor: 'pointer',
})
const peoplePanelCls = css({ width: '17rem' })
const peopleSearchCls = css({
  width: '100%',
  height: '2rem',
  paddingX: '0.625rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.375rem',
  fontSize: '0.8125rem',
})
const peopleListCls = css({
  maxHeight: '16rem',
  overflowY: 'auto',
  marginTop: '0.375rem',
})
const peopleRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  width: '100%',
  minHeight: '2.25rem',
  paddingX: '0.375rem',
  border: 'none',
  borderRadius: '0.375rem',
  bg: 'transparent',
  color: 'greyscale.800',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { bg: 'greyscale.100' },
})
const avatarCls = css({
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
  width: '1.5rem',
  height: '1.5rem',
  overflow: 'hidden',
  borderRadius: '50%',
  bg: 'greyscale.200',
  fontSize: '0.6875rem',
  '& img': { width: '100%', height: '100%', objectFit: 'cover' },
})
const peopleHintCls = css({
  padding: '0.75rem',
  color: 'greyscale.500',
  fontSize: '0.8125rem',
})
const choicePanelCls = css({ minWidth: '10rem' })
const choiceRowCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '0.5rem 0.625rem',
  border: 'none',
  borderRadius: '0.375rem',
  bg: 'transparent',
  color: 'greyscale.800',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  textAlign: 'left',
  _hover: { bg: 'greyscale.100' },
})
