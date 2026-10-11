import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/primitives'
import { Checkbox } from '@/primitives/Checkbox'
import { css } from '@/styled-system/css'
import { VoiceprintClient, type Scope } from './api'
import { ImportIdentityClient, type ImportIdentity } from './importIdentity'
import type { IdentityPerson, IdentityPage } from './identificationApi'
import { sameAuthSession } from '@/features/auth/utils/tokenStorage'

const column = css({ display: 'grid', gap: 'sm', minWidth: 0 })
const field = css({
  color: 'text.primary',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  padding: 'xs',
  maxWidth: '100%',
  minWidth: 0,
})
const row = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'sm',
  alignItems: 'center',
})
const searchLabel = css({
  display: 'grid',
  gap: 'xs',
  minWidth: 0,
  maxWidth: '100%',
  flex: '1 1 12rem',
})
const wrappingName = css({
  maxWidth: '100%',
  minWidth: 0,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
})

export function ImportIdentityChoices({
  viewerId,
  value,
  disabled,
  maxCandidates,
  onChange,
  onReady,
}: {
  viewerId: string
  value: ImportIdentity
  disabled: boolean
  maxCandidates: number
  onChange: (value: ImportIdentity) => void
  onReady: (ready: boolean) => void
}) {
  const { t } = useTranslation('importIdentity')
  const client = useMemo(() => new ImportIdentityClient(viewerId), [viewerId])
  const scopesClient = useMemo(
    () => new VoiceprintClient(null, viewerId, client.auth),
    [viewerId, client]
  )
  const [scopes, setScopes] = useState<Scope[]>([])
  const [scopeOffset, setScopeOffset] = useState<number | null>(0)
  const [people, setPeople] = useState<
    IdentityPage<IdentityPerson> & { organization_id: string | null }
  >()
  const [names, setNames] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [scopeLoading, setScopeLoading] = useState(false)
  const scopePageRequest = useRef<AbortController | null>(null)
  useEffect(() => {
    scopePageRequest.current?.abort()
    setScopeLoading(false)
    const controller = new AbortController()
    scopesClient
      .scopes(0, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || !sameAuthSession(client.auth)) return
        setScopes((before) => {
          const selected = before.find(
            (scope) => scope.id === value.organization_id
          )
          return selected &&
            !page.results.some((scope) => scope.id === selected.id)
            ? [...page.results, selected]
            : page.results
        })
        setScopeOffset(page.next_offset)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => {
      controller.abort()
      scopePageRequest.current?.abort()
    }
    // A refresh preserves a selected scope from later pages; candidates recheck it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scopesClient, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setPeople(undefined)
    setError(false)
    client
      .candidates(value.organization_id, query, offset, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted && sameAuthSession(client.auth))
          setPeople(page)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [client, value.organization_id, query, offset, refresh])
  useEffect(() => {
    onReady(
      !!people &&
        people.organization_id === value.organization_id &&
        !error &&
        sameAuthSession(client.auth)
    )
    return () => onReady(false)
  }, [onReady, people, value, error, client])
  if (!sameAuthSession(client.auth)) return null
  return (
    <div className={column}>
      <label className={column}>
        {t('scope')}
        <select
          className={field}
          value={value.organization_id ?? 'personal'}
          disabled={disabled}
          onChange={(event) => {
            onChange({
              organization_id:
                event.target.value === 'personal' ? null : event.target.value,
              candidate_user_ids: [],
            })
            setNames({})
            setQuery('')
            setSearch('')
            setOffset(0)
          }}
        >
          <option value="personal">{t('personal')}</option>
          {scopes.map((scope) => (
            <option
              key={scope.id}
              value={scope.id}
              disabled={!scope.policy.enabled}
            >
              {scope.name}
            </option>
          ))}
        </select>
      </label>
      {scopeOffset !== null && scopeOffset > 0 && (
        <Button
          type="button"
          size="dense"
          isDisabled={disabled || scopeLoading}
          onPress={async () => {
            const controller = new AbortController()
            scopePageRequest.current?.abort()
            scopePageRequest.current = controller
            setScopeLoading(true)
            try {
              const page = await scopesClient.scopes(
                scopeOffset,
                controller.signal
              )
              if (controller.signal.aborted || !sameAuthSession(client.auth))
                return
              setScopes((before) => [
                ...before,
                ...page.results.filter(
                  (item) => !before.some((old) => old.id === item.id)
                ),
              ])
              setScopeOffset(page.next_offset)
            } catch {
              if (!controller.signal.aborted && sameAuthSession(client.auth))
                setError(true)
            } finally {
              if (
                !controller.signal.aborted &&
                scopePageRequest.current === controller
              )
                setScopeLoading(false)
            }
          }}
        >
          {t('moreScopes')}
        </Button>
      )}
      <div className={row}>
        <label className={searchLabel}>
          {t('search')}{' '}
          <input
            className={field}
            value={search}
            maxLength={80}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <Button
          type="button"
          size="dense"
          isDisabled={disabled}
          onPress={() => {
            setQuery(search)
            setOffset(0)
          }}
        >
          {t('searchAction')}
        </Button>
      </div>
      <p>
        {t('selected', {
          count: value.candidate_user_ids.length,
          limit: maxCandidates,
        })}
      </p>
      <div className={row}>
        {!error &&
          value.candidate_user_ids
            .filter((id) => names[id])
            .map((id) => (
              <Button
                key={id}
                className={wrappingName}
                type="button"
                size="dense"
                isDisabled={disabled}
                onPress={() =>
                  onChange({
                    ...value,
                    candidate_user_ids: value.candidate_user_ids.filter(
                      (item) => item !== id
                    ),
                  })
                }
              >
                {t('remove', { name: names[id] ?? id })}
              </Button>
            ))}
      </div>
      {error ? (
        <div role="alert">
          {t('directoryError')}{' '}
          <Button
            type="button"
            size="dense"
            isDisabled={disabled}
            onPress={() => setRefresh((before) => before + 1)}
          >
            {t('refresh')}
          </Button>
        </div>
      ) : !people ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <>
          <div className={column}>
            {people.results.length ? (
              people.results.map((person) => (
                <Checkbox
                  key={person.id}
                  className={wrappingName}
                  isSelected={value.candidate_user_ids.includes(person.id)}
                  isDisabled={
                    disabled ||
                    (!value.candidate_user_ids.includes(person.id) &&
                      value.candidate_user_ids.length >= maxCandidates)
                  }
                  onChange={(checked) => {
                    setNames((before) => ({
                      ...before,
                      [person.id]: person.name,
                    }))
                    onChange({
                      ...value,
                      candidate_user_ids: checked
                        ? [
                            ...new Set([
                              ...value.candidate_user_ids,
                              person.id,
                            ]),
                          ].sort()
                        : value.candidate_user_ids.filter(
                            (id) => id !== person.id
                          ),
                    })
                  }}
                >
                  {person.name}
                </Checkbox>
              ))
            ) : (
              <p>{t('empty')}</p>
            )}
          </div>
          <div className={row}>
            {offset > 0 && (
              <Button
                type="button"
                size="dense"
                isDisabled={disabled}
                onPress={() => setOffset(Math.max(0, offset - 25))}
              >
                {t('previous')}
              </Button>
            )}
            {people.next_offset !== null && (
              <Button
                type="button"
                size="dense"
                isDisabled={disabled}
                onPress={() => setOffset(people.next_offset!)}
              >
                {t('next')}
              </Button>
            )}
          </div>
        </>
      )}
      <p>{t('hint')}</p>
    </div>
  )
}
