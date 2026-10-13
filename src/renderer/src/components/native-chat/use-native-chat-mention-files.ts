import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useRuntimeFileListForWorktree } from '@/components/quick-open-file-list'
import { rankQuickOpenFilesWithHistory } from '@/components/quick-open-history-ranking'
import { useQuickOpenHistory } from '@/lib/quick-open-file-history'
import { findTerminalTabWorktreeId } from './native-chat-file-link'
import { useKnownWorktreeById } from '@/store/selectors'
import { useNativeChatMentionContentMatches } from './use-native-chat-mention-content-matches'

const MENTION_FILE_LIMIT = 20
const NO_FILES: readonly string[] = []

export type NativeChatMentionFiles = {
  /** Workspace-relative paths: name matches best first, then content matches from `contentStart`. */
  files: readonly string[]
  /** Index of the first content match; equals `files.length` when there are none. */
  contentStart: number
  /** Name list still loading; Enter waits only on this, never on the slower content search. */
  loading: boolean
  contentLoading: boolean
  failed: boolean
}

/** Content matches go after the name matches so a late content result never moves the highlight. */
export function mergeMentionFiles(
  nameFiles: readonly string[],
  contentFiles: readonly string[]
): Pick<NativeChatMentionFiles, 'files' | 'contentStart'> {
  const named = new Set(nameFiles)
  const extra = contentFiles.filter((path) => !named.has(path))
  return {
    files: extra.length > 0 ? [...nameFiles, ...extra] : nameFiles,
    contentStart: nameFiles.length
  }
}

/** `query` is null while no `@` token is open. */
export function useNativeChatMentionFiles(args: {
  query: string | null
  terminalTabId: string
  structuredWorktreeId?: string
}): NativeChatMentionFiles {
  const { query, terminalTabId, structuredWorktreeId } = args
  const enabled = query !== null
  // Closed is the common state, so the tab scan only runs while a token is open.
  const worktreeId = useAppStore((state) =>
    enabled
      ? (structuredWorktreeId ?? findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId))
      : null
  )
  const worktreePath = useKnownWorktreeById(worktreeId)?.path ?? null
  const history = useQuickOpenHistory(worktreeId, worktreePath)
  const list = useRuntimeFileListForWorktree({
    enabled,
    worktreeId,
    query: query ?? '',
    recentPaths: history
  })
  const content = useNativeChatMentionContentMatches({ query, worktreeId, worktreePath })
  const failed = list.loadError !== null

  return useMemo(() => {
    const nameFiles =
      query === null
        ? NO_FILES
        : rankQuickOpenFilesWithHistory(query, list.files, history)
            .slice(0, MENTION_FILE_LIMIT)
            .map((item) => item.path)
    return {
      ...mergeMentionFiles(nameFiles, content.files),
      loading: list.loading,
      contentLoading: content.loading,
      failed
    }
  }, [content.files, content.loading, failed, history, list.files, list.loading, query])
}
