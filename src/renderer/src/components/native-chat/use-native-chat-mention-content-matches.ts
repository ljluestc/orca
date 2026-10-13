import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { searchRuntimeFiles } from '@/runtime/runtime-file-search-client'
import type { SearchResult } from '../../../../shared/code-search-types'

// Shorter words match most of the repo, so they would only bury the name matches.
export const MENTION_CONTENT_MIN_QUERY_LENGTH = 3
export const MENTION_CONTENT_FILE_LIMIT = 8
const MENTION_CONTENT_DEBOUNCE_MS = 250
const MENTION_CONTENT_MAX_MATCHES = 400

export type NativeChatMentionContentMatches = {
  /** Workspace-relative paths whose contents contain the query, most matches first. */
  files: readonly string[]
  loading: boolean
}

const IDLE: NativeChatMentionContentMatches = { files: [], loading: false }
const PENDING: NativeChatMentionContentMatches = { files: [], loading: true }

/** Most-matching files first; a file with many hits is likelier the one being described. */
export function rankMentionContentFiles(result: SearchResult, limit: number): string[] {
  return result.files
    .map((file) => ({
      path: file.relativePath.replace(/\\/g, '/'),
      count: file.matchCount ?? file.matches.length
    }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((file) => file.path)
}

/** Files whose text contains `query`; idle while `query` is null or too short. */
export function useNativeChatMentionContentMatches(args: {
  query: string | null
  worktreeId: string | null
  worktreePath: string | null
}): NativeChatMentionContentMatches {
  const { worktreeId, worktreePath } = args
  const query = args.query?.trim() ?? ''
  const enabled =
    query.length >= MENTION_CONTENT_MIN_QUERY_LENGTH && worktreeId !== null && worktreePath !== null
  const runtimeEnvironmentId = useAppStore((state) =>
    enabled ? getRuntimeEnvironmentIdForWorktree(state, worktreeId) : null
  )
  const [state, setState] = useState<NativeChatMentionContentMatches & { key: string }>({
    ...IDLE,
    key: ''
  })
  const requestKey = enabled ? `${runtimeEnvironmentId}\0${worktreeId}\0${query}` : ''

  useEffect(() => {
    if (!enabled || !worktreeId || !worktreePath) {
      return undefined
    }
    setState({ files: [], loading: true, key: requestKey })
    const controller = new AbortController()
    // Why: every keystroke changes the query; only the word the user paused on is searched.
    const timer = setTimeout(() => {
      searchRuntimeFiles(
        {
          target: runtimeTargetForOwnerEnvironment(runtimeEnvironmentId),
          worktreeId,
          worktreePath,
          connectionId: getConnectionId(worktreeId) ?? undefined
        },
        {
          query,
          rootPath: worktreePath,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
          maxResults: MENTION_CONTENT_MAX_MATCHES
        },
        controller.signal
      )
        .then((result) => {
          setState({
            files: rankMentionContentFiles(result, MENTION_CONTENT_FILE_LIMIT),
            loading: false,
            key: requestKey
          })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return
          }
          // Content matches are a bonus row group; the name matches above still work.
          console.warn('[native-chat] @ content search failed:', error)
          setState({ files: [], loading: false, key: requestKey })
        })
    }, MENTION_CONTENT_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [enabled, query, requestKey, runtimeEnvironmentId, worktreeId, worktreePath])

  // A stale key means the effect for this query has not committed yet.
  if (!enabled) {
    return IDLE
  }
  return state.key === requestKey ? state : PENDING
}
