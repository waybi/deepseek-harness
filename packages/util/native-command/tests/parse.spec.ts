import { describe, expect, it } from 'vitest'
import { parseNativeFileApplications } from '@deepseek-ai/dsh-native-command/types'

describe('parseNativeFileApplications', () => {
  it('returns validated entries with PNG, SVG, or absent icons', () => {
    const applications = [
      { id: 'a', name: 'A', default: true, icon: 'data:image/png;base64,AAAA' },
      { id: 'b', name: 'B', default: false, icon: 'data:image/svg+xml;base64,AAAA' },
      { id: 'c', name: 'C', default: false, icon: null },
    ]

    expect(parseNativeFileApplications(applications)).toEqual(applications)
  })

  it('rejects a value that is not a list', () => {
    expect(() => parseNativeFileApplications({ id: 'a' })).toThrow('Invalid native application list')
  })

  it.each([
    ['null entry', null],
    ['empty id', { id: '', name: 'A', default: true, icon: null }],
    ['missing icon', { id: 'a', name: 'A', default: true }],
    ['unsupported icon', { id: 'a', name: 'A', default: true, icon: 'https://example.test/icon.png' }],
  ])('rejects a %s', (_name, entry) => {
    expect(() => parseNativeFileApplications([entry])).toThrow('Invalid native application entry')
  })
})
