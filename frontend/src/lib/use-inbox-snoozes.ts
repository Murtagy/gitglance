import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchInboxSnoozeActivity, markThreadRead } from './github'
import { deleteInboxSnooze, loadInboxSnoozes, saveInboxSnooze, wakeInboxSnooze } from './storage'
import type { InboxSnooze, NotificationThread, PullRequestData, Viewer } from './types'

export function useInboxSnoozes(token: string, viewer: Viewer | undefined, refreshSeconds: number, onSnoozed: (threadId: string) => void) {
  const queryClient = useQueryClient()
  const currentAccount = useRef({ token, viewerId: viewer?.id })
  currentAccount.current = { token, viewerId: viewer?.id }
  const wakeAttempts = useRef(new Map<string, number>())
  const interval = Math.max(refreshSeconds, 120) * 1000
  const snoozesQuery = useQuery({
    queryKey: ['inbox-snoozes', viewer?.id],
    enabled: Boolean(token && viewer),
    staleTime: interval,
    refetchInterval: interval,
    refetchOnWindowFocus: 'always',
    refetchOnMount: 'always',
    queryFn: () => {
      if (!viewer) throw new Error('Missing account for inbox snoozes')
      return loadInboxSnoozes(viewer.id)
    },
  })
  const { snoozes, restored } = useMemo(() => ({
    snoozes: (snoozesQuery.data ?? []).filter((record) => !record.restoredAt),
    restored: (snoozesQuery.data ?? []).filter((record): record is InboxSnooze & { restoredAt: string } => Boolean(record.restoredAt)),
  }), [snoozesQuery.data])
  const snoozeMutation = useMutation({
    mutationFn: async ({ token: accountToken, viewerId, thread, pr }: { token: string; viewerId: string; thread: NotificationThread; pr: PullRequestData }) => {
      const snooze: InboxSnooze = {
        thread,
        pullRequest: { id: pr.id, number: pr.number, title: pr.title, url: pr.url, repository: pr.repository },
        snoozedAt: new Date().toISOString(),
      }
      await markThreadRead(accountToken, thread.id)
      try {
        await saveInboxSnooze(viewerId, snooze)
      } catch (error) {
        throw new Error(`Marked read on GitHub, but could not save snooze. ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    onSuccess: async (_data, { token: accountToken, viewerId, thread }) => {
      if (currentAccount.current.token === accountToken && currentAccount.current.viewerId === viewerId) onSnoozed(thread.id)
      await queryClient.invalidateQueries({ queryKey: ['inbox-snoozes', viewerId] })
    },
    onSettled: (_data, _error, { token: accountToken }) => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', accountToken] })
    },
  })
  const restoreMutation = useMutation({
    mutationFn: ({ viewerId, snooze, wake }: { token: string; viewerId: string; snooze: InboxSnooze; wake?: boolean }) => wake
      ? wakeInboxSnooze(viewerId, snooze)
      : deleteInboxSnooze(viewerId, snooze),
    onSuccess: async (_data, { token: accountToken, viewerId, snooze }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['preview', accountToken, snooze.thread.id] }),
        queryClient.invalidateQueries({ queryKey: ['inbox-snoozes', viewerId] }),
        queryClient.invalidateQueries({ queryKey: ['notifications', accountToken] }),
      ])
    },
  })
  const activityQueries = useQueries({
    queries: snoozes.map((snooze) => ({
      queryKey: ['inbox-snooze-activity', token, viewer?.id, snooze.thread.id, snooze.snoozedAt],
      enabled: Boolean(token && viewer),
      queryFn: () => fetchInboxSnoozeActivity(token, snooze),
      initialData: false,
      initialDataUpdatedAt: new Date(snooze.snoozedAt).getTime(),
      staleTime: interval,
      refetchInterval: interval,
      refetchOnWindowFocus: true,
    })),
  })
  useEffect(() => {
    if (!viewer || !token) return
    const currentKeys = new Set<string>()
    snoozes.forEach((snooze, index) => {
      const key = `${viewer.id}:${snooze.thread.id}:${snooze.snoozedAt}`
      currentKeys.add(key)
      const activity = activityQueries[index]
      if (!activity?.data || wakeAttempts.current.get(key) === activity.dataUpdatedAt) return
      wakeAttempts.current.set(key, activity.dataUpdatedAt)
      restoreMutation.mutate({ token, viewerId: viewer.id, snooze, wake: true })
    })
    for (const key of wakeAttempts.current.keys()) {
      if (!currentKeys.has(key)) wakeAttempts.current.delete(key)
    }
  }, [activityQueries, restoreMutation.mutate, snoozes, token, viewer])

  const failedCheck = activityQueries.findIndex((query) => query.isError)
  const failed = snoozes[failedCheck]
  const error = snoozesQuery.error ? `Could not load inbox snoozes. Refresh Inbox to retry. ${snoozesQuery.error.message}` :
    snoozeMutation.error ? `Could not mark read and snooze. ${snoozeMutation.error.message}` :
    restoreMutation.error ? `Could not restore inbox thread. ${restoreMutation.error.message}` :
    failed ? `Could not check ${failed.thread.repoFullName} #${failed.pullRequest.number}. Manual restore remains available. ${activityQueries[failedCheck].error?.message}` : ''

  return {
    snoozes,
    restored,
    error,
    isLoading: Boolean(viewer && snoozesQuery.isPending),
    canSnooze: Boolean(viewer && snoozesQuery.isSuccess && !snoozeMutation.isPending),
    isSnoozing: snoozeMutation.isPending,
    isRestoring: restoreMutation.isPending,
    checkIntervalSeconds: interval / 1000,
    snooze: (thread: NotificationThread, pr: PullRequestData) => { if (viewer) snoozeMutation.mutate({ token, viewerId: viewer.id, thread, pr }) },
    restore: (snooze: InboxSnooze) => { if (viewer) restoreMutation.mutate({ token, viewerId: viewer.id, snooze }) },
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox-snoozes', viewer?.id] })
      void queryClient.invalidateQueries({ queryKey: ['inbox-snooze-activity', token, viewer?.id] })
    },
  }
}
