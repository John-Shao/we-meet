import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/ApiError'

import {
  apiErrorCode,
  describeApiError,
  describeInvitationError,
  describeRoleError,
} from './errors'

/**
 * 管理台报错文案的两段:DRF 原文兜底 + 机器可读 `code` 映射成中文。
 *
 * 这里守的是**前后端之间那份约定**:后端在 `admin_roles.py` 里往校验错误上挂
 * `code` / `codes` / `count`,前端按 `roles.error.<code>` 取文案并插值。约定一
 * 漂,表现是管理员看到一句英文而不是报错 —— 没有任何东西会红。
 */
const err = (body: unknown) => new ApiError(400, body)

const fakeT = (key: string, options?: Record<string, unknown>): string => {
  // 只认这一个键,其余走 defaultValue —— 模拟 i18n 缺键时的行为。
  if (key === 'roles.error.unscopable_scope') {
    return `组织级权限（${String(options?.codes)}）不能限定到部门`
  }
  return String(options?.defaultValue ?? key)
}

describe('describeApiError', () => {
  it('DRF 的 detail 优先', () => {
    expect(describeApiError(err({ detail: 'Not allowed.' }))).toBe(
      'Not allowed.'
    )
  })

  it('没有 detail 时取第一个字段的第一条', () => {
    expect(describeApiError(err({ scope_type: ['nope'], code: 'x' }))).toBe(
      'nope'
    )
  })

  it('body 不是对象时退回 ApiError.message', () => {
    expect(describeApiError(err('boom'))).toBe('Api error 400')
  })

  it('不是 ApiError 也不崩', () => {
    expect(describeApiError(new Error('offline'))).toBe('offline')
    expect(describeApiError('naked string')).toBe('naked string')
  })
})

describe('apiErrorCode', () => {
  it('拿到 code,并把列表插值成逗号串', () => {
    const hit = apiErrorCode(
      err({
        permissions: 'x',
        code: 'unscopable_assigned',
        codes: ['a', 'b'],
        count: 2,
      })
    )
    expect(hit).toEqual({
      code: 'unscopable_assigned',
      params: { permissions: 'x', codes: 'a, b', count: 2 },
    })
  })

  it('serializer 抛的那一路 code 是**列表**,同样要认', () => {
    // DRF 的 `as_serializer_error` 把 serializer.validate() 里抛的每个值都规整
    // 成列表;viewset 里抛的则原样是字符串。同一个后端两种形状,都得认 ——
    // 只认字符串的话前端什么都不会报,只是文案永远退回英文。
    expect(
      apiErrorCode(
        err({
          permissions: ['This role is assigned to 1 holder(s)…'],
          code: ['unscopable_assigned'],
          codes: ['org.bot.read'],
          count: ['1'],
        })
      )
    ).toEqual({
      code: 'unscopable_assigned',
      params: {
        permissions: 'This role is assigned to 1 holder(s)…',
        codes: 'org.bot.read',
        count: '1',
      },
    })
  })

  it('没有 code 就返回 null,调用方走原文', () => {
    expect(apiErrorCode(err({ detail: 'nope' }))).toBeNull()
    expect(apiErrorCode(err({ code: '' }))).toBeNull()
    expect(apiErrorCode(new Error('x'))).toBeNull()
  })
})

describe('describeRoleError', () => {
  it('认识的 code 走中文并插值', () => {
    const message = describeRoleError(
      fakeT,
      err({
        scope_type: 'This role includes organization-wide permissions…',
        code: 'unscopable_scope',
        codes: ['org.bot.read'],
      })
    )
    expect(message).toBe('组织级权限（org.bot.read）不能限定到部门')
  })

  it('认不出的 code 退回后端原文,而不是显示成键名', () => {
    // 后端新加一条 code、前端还没跟上时的样子 —— 必须仍是一句人话。
    expect(
      describeRoleError(
        fakeT,
        err({ detail: 'Something specific.', code: 'brand_new' })
      )
    ).toBe('Something specific.')
  })

  it('没带 code 的普通校验错误照旧', () => {
    expect(describeRoleError(fakeT, err({ detail: 'Name is required.' }))).toBe(
      'Name is required.'
    )
  })
})

describe('describeInvitationError', () => {
  it('maps the serializer error code through the active locale', () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      key === 'addMember.error.already_member'
        ? '该成员已在当前组织中。'
        : String(options?.defaultValue ?? key)

    expect(
      describeInvitationError(
        t,
        err({
          phone: ['This person is already in your organization.'],
          code: ['already_member'],
        })
      )
    ).toBe('该成员已在当前组织中。')
  })

  it('keeps the server message as a fallback for unknown codes', () => {
    expect(
      describeInvitationError(
        fakeT,
        err({ detail: 'A specific validation error.', code: 'future_code' })
      )
    ).toBe('A specific validation error.')
  })
})
