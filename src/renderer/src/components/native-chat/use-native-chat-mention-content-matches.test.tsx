// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../../shared/code-search-types'
import {
  MENTION_CONTENT_FILE_LIMIT,
  rankMentionContentFiles,
  useNativeChatMentionContentMatches
} from './use-native-chat-mention-content-matches'

const searchRuntimeFilesMock = vi.fn()
vi.mock('@/runtime/runtime-file-search-client', () => ({
  searchRuntimeFiles: (...args: unknown[]) => searchRuntimeFilesMock(...args)
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => 'ssh-1' }))

function result(files: [string, number][]): SearchResult {
  return {
    files: files.map(([relativePath, count]) => ({
      filePath: `/repo/${relativePath}`,
      relativePath,
      matches: [],
      matchCount: count
    })),
    totalMatches: files.reduce((sum, [, count]) => sum + count, 0),
    truncated: false
  }
}

const ARGS = { worktreeId: 'wt-1', worktreePath: '/repo' }

describe('rankMentionContentFiles', () => {
  it('puts the most-matching files first, normalizes separators and caps the list', () => {
    const ranked = rankMentionContentFiles(
      result([
        ['src\\b.ts', 1],
        ['src/a.ts', 5],
        ['src/c.ts', 1]
      ]),
      2
    )
    expect(ranked).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('useNativeChatMentionContentMatches', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    searchRuntimeFilesMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays idle and searches nothing for a closed or short token', async () => {
    for (const query of [null, '', 'db']) {
      const { result: hook, unmount } = renderHook(() =>
        useNativeChatMentionContentMatches({ ...ARGS, query })
      )
      await act(async () => {
        await vi.runAllTimersAsync()
      })
      expect(hook.current).toEqual({ files: [], loading: false })
      unmount()
    }
    expect(searchRuntimeFilesMock).not.toHaveBeenCalled()
  })

  it('searches the paused word as a literal, case-insensitive query on the owning host', async () => {
    searchRuntimeFilesMock.mockResolvedValue(result([['src/store/list.ts', 3]]))
    const { result: hook, rerender } = renderHook(
      ({ query }: { query: string }) => useNativeChatMentionContentMatches({ ...ARGS, query }),
      { initialProps: { query: 'dat' } }
    )
    expect(hook.current.loading).toBe(true)
    rerender({ query: 'database' })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(searchRuntimeFilesMock).toHaveBeenCalledTimes(1)
    const [context, options] = searchRuntimeFilesMock.mock.calls[0]
    expect(context).toMatchObject({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      connectionId: 'ssh-1'
    })
    expect(options).toMatchObject({
      query: 'database',
      rootPath: '/repo',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    expect(hook.current).toMatchObject({ files: ['src/store/list.ts'], loading: false })
  })

  it('drops a superseded search instead of showing its files', async () => {
    let resolveFirst: (value: SearchResult) => void = () => undefined
    searchRuntimeFilesMock
      .mockImplementationOnce(
        () =>
          new Promise<SearchResult>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(result([['new.ts', 1]]))
    const { result: hook, rerender } = renderHook(
      ({ query }: { query: string }) => useNativeChatMentionContentMatches({ ...ARGS, query }),
      { initialProps: { query: 'oldword' } }
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    const firstSignal: AbortSignal = searchRuntimeFilesMock.mock.calls[0][2]
    rerender({ query: 'newword' })
    expect(firstSignal.aborted).toBe(true)
    await act(async () => {
      resolveFirst(result([['old.ts', 9]]))
      await vi.runAllTimersAsync()
    })
    expect(hook.current.files).toEqual(['new.ts'])
  })

  it('settles to no content matches when the search fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    searchRuntimeFilesMock.mockRejectedValue(new Error('rg missing'))
    const { result: hook } = renderHook(() =>
      useNativeChatMentionContentMatches({ ...ARGS, query: 'database' })
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(hook.current).toMatchObject({ files: [], loading: false })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it(`returns at most ${MENTION_CONTENT_FILE_LIMIT} files`, async () => {
    searchRuntimeFilesMock.mockResolvedValue(
      result(Array.from({ length: 20 }, (_, index): [string, number] => [`f${index}.ts`, 1]))
    )
    const { result: hook } = renderHook(() =>
      useNativeChatMentionContentMatches({ ...ARGS, query: 'database' })
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(hook.current.files).toHaveLength(MENTION_CONTENT_FILE_LIMIT)
  })
})
