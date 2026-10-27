import { describe, expect, it } from 'vitest'
import {
  groupSessionsByPrefix, MAX_PREFIX_LENGTH, parseTitlePrefix, prefixGroupExpanded, UNCATEGORIZED_GROUP_KEY,
} from '../src/client/rows/prefix-groups.ts'

const row = (id: string, title: string, updatedAt: number) => ({ id, title, updatedAt })

describe('parseTitlePrefix', () => {
  it('splits a prefixed title into prefix and display text', () => {
    expect(parseTitlePrefix('店铺｜ZA062 广告数据查询')).toEqual({ prefix: '店铺', display: 'ZA062 广告数据查询' })
  })

  it('cuts at the first bar only and trims the prefix', () => {
    expect(parseTitlePrefix('A｜B｜C')).toEqual({ prefix: 'A', display: 'B｜C' })
    expect(parseTitlePrefix('  DSH  ｜ 标题')).toEqual({ prefix: 'DSH', display: ' 标题' })
  })

  it.each([
    ['empty prefix', '｜标题'],
    ['blank prefix', '   ｜标题'],
    ['no bar', '普通标题'],
    ['half-width bar', 'DSH|标题'],
    ['prefix over 16 characters', `${'长'.repeat(MAX_PREFIX_LENGTH + 1)}｜标题`],
    ['empty title', ''],
  ])('keeps the whole title and no prefix for %s', (_name, title) => {
    expect(parseTitlePrefix(title)).toEqual({ prefix: undefined, display: title })
  })

  it('treats a missing title as an empty uncategorized title', () => {
    expect(parseTitlePrefix(undefined)).toEqual({ prefix: undefined, display: '' })
  })

  it('counts code points, so a 16-character prefix of astral characters is accepted', () => {
    const sixteen = '𠮷'.repeat(MAX_PREFIX_LENGTH)
    expect(parseTitlePrefix(`${sixteen}｜x`).prefix).toBe(sixteen)
    expect(parseTitlePrefix(`${sixteen}𠮷｜x`).prefix).toBeUndefined()
  })
})

describe('groupSessionsByPrefix', () => {
  it('orders prefix groups by newest member and puts Uncategorized last regardless of activity', () => {
    const groups = groupSessionsByPrefix([
      row('u1', '没有前缀', 900),
      row('a1', '店铺｜一', 10),
      row('b1', 'DSH｜二', 50),
      row('a2', '店铺｜三', 20),
      row('b2', 'DSH｜四', 5),
    ])
    expect(groups.map(group => [group.key, group.prefix, group.rows.map(r => r.id)])).toEqual([
      ['prefix:DSH', 'DSH', ['b1', 'b2']],
      ['prefix:店铺', '店铺', ['a1', 'a2']],
      [UNCATEGORIZED_GROUP_KEY, undefined, ['u1']],
    ])
  })

  it('keeps input order inside a group and exposes the title without its prefix', () => {
    const [group] = groupSessionsByPrefix([row('x', 'P｜后', 1), row('y', 'P｜前', 9)])
    expect(group?.rows.map(r => r.id)).toEqual(['x', 'y'])
    expect(group?.displayById.get('x')).toBe('后')
    expect(group?.displayById.get('y')).toBe('前')
  })

  it('omits the Uncategorized group when every row has a prefix and yields no groups for no rows', () => {
    expect(groupSessionsByPrefix([row('a', 'P｜x', 1)]).map(group => group.key)).toEqual(['prefix:P'])
    expect(groupSessionsByPrefix([])).toEqual([])
  })

  it('keeps a real prefix distinct from the Uncategorized key', () => {
    const groups = groupSessionsByPrefix([row('a', '未分类｜x', 1), row('b', 'none', 0)])
    expect(groups.map(group => group.key)).toEqual(['prefix:未分类', UNCATEGORIZED_GROUP_KEY])
  })
})

describe('prefixGroupExpanded', () => {
  it('defaults Uncategorized to folded and other groups to open, and honors a saved choice', () => {
    expect(prefixGroupExpanded({}, UNCATEGORIZED_GROUP_KEY)).toBe(false)
    expect(prefixGroupExpanded({}, 'prefix:店铺')).toBe(true)
    expect(prefixGroupExpanded({ [UNCATEGORIZED_GROUP_KEY]: true, 'prefix:店铺': false }, UNCATEGORIZED_GROUP_KEY)).toBe(true)
    expect(prefixGroupExpanded({ 'prefix:店铺': false }, 'prefix:店铺')).toBe(false)
  })
})
