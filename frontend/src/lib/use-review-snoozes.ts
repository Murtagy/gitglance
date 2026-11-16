import { useEffect, useRef } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchReviewSnoozeActivity, shouldWakeReviewSnooze } from './github'
import { deleteReviewSnooze, loadReviewSnoozes, saveReviewSnooze } from './storage'
import type { RequestedPullRequest, ReviewSnooze, Viewer } from './types'

export function useReviewSnoozes(token: string, viewer: Viewer | undefined, refreshSeconds: number) {
  const queryClient = useQueryClient()
  const wakeAttempts = useRef(new Map<string, number>())
  // Dormant PR checks run at most every two minutes to bound GitHub API usage.
  const interval = Math.max(refreshSeconds, 120) * 1000
  const snoozesQuery = useQuery({
    queryKey: ['review-snoozes', viewer?.id],
    enabled: Boolean(token && viewer),
    staleTime: interval,
    refetchInterval: interval,
    refetchOnWindowFocus: 'always',
    refetchOnMount: 'always',
    queryFn: () => {
      if (!viewer) throw new Error('Missing account for review snoozes')
      return loadReviewSnoozes(viewer.id)
    },
  })
  const snoozes = snoozesQuery.data ?? []

  const snoozeMutation = useMutation({
    mutationFn: async ({ viewerId, pr }: { viewerId: string; pr: RequestedPullRequest }) => {
      const snooze: ReviewSnooze = {
        pullRequest: { id: pr.id, number: pr.number, title: pr.title, url: pr.url, repository: pr.repository },
        // GitHub response timestamps have second precision; do not miss a reply during the local write.
        snoozedAt: new Date(Date.now() - 1000).toISOString(),
        headRefOid: pr.headRefOid,
      }
      await saveReviewSnooze(viewerId, snooze)
    },
    onSuccess: async (_data, { viewerId }) => {
      await queryClient.invalidateQueries({ queryKey: ['review-snoozes', viewerId] })
    },
  })

  const restoreMutation = useMutation({
    mutationFn: ({ viewerId, snooze }: { token: string; viewerId: string; snooze: ReviewSnooze }) => deleteReviewSnooze(viewerId, snooze),
    onSuccess: async (_data, { viewerId, token: accountToken }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['review-snoozes', viewerId] }),
        queryClient.invalidateQueries({ queryKey: ['review-requests', accountToken] }),
      ])
    },
  })

  const activityQueries = useQueries({
    queries: snoozes.map((snooze) => ({
      queryKey: ['review-snooze-activity', token, viewer?.id, snooze.pullRequest.id, snooze.snoozedAt],
      enabled: Boolean(token && viewer),
      queryFn: () => fetchReviewSnoozeActivity(token, snooze.pullRequest.id, snooze.snoozedAt, snooze.headRefOid),
      initialData: { headRefOid: snooze.headRefOid, authorReplied: false, isClosed: false },
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
      const key = `${viewer.id}:${snooze.pullRequest.id}:${snooze.snoozedAt}`
      currentKeys.add(key)
      const activity = activityQueries[index]
      if (!activity?.data || !shouldWakeReviewSnooze(snooze, activity.data) || wakeAttempts.current.get(key) === activity.dataUpdatedAt) return
      wakeAttempts.current.set(key, activity.dataUpdatedAt)
      restoreMutation.mutate({ token, viewerId: viewer.id, snooze })
    })
    for (const key of wakeAttempts.current.keys()) {
      if (!currentKeys.has(key)) wakeAttempts.current.delete(key)
    }
  }, [activityQueries, restoreMutation.mutate, snoozes, token, viewer])

  const failedCheck = activityQueries.findIndex((query) => query.isError)
  const checkError = activityQueries[failedCheck]?.error
  const failedPR = snoozes[failedCheck]?.pullRequest
  const error = snoozesQuery.error ? `Could not load snoozed reviews. Refresh Reviews to retry. ${snoozesQuery.error.message}` :
    snoozeMutation.error ? `Could not snooze PR. ${snoozeMutation.error.message}` :
    restoreMutation.error ? `Could not restore PR. ${restoreMutation.error.message}` :
    checkError ? `Could not check ${failedPR?.repository.nameWithOwner} #${failedPR?.number} for replies. Manual restore remains available. ${checkError.message}` : ''

  return {
    snoozes,
    error,
    isLoading: Boolean(viewer && snoozesQuery.isPending),
    canSnooze: Boolean(viewer && snoozesQuery.isSuccess && !snoozeMutation.isPending),
    isSnoozing: snoozeMutation.isPending,
    isRestoring: restoreMutation.isPending,
    checkIntervalSeconds: interval / 1000,
    snooze: (pr: RequestedPullRequest) => { if (viewer) snoozeMutation.mutate({ viewerId: viewer.id, pr }) },
    restore: (snooze: ReviewSnooze) => { if (viewer) restoreMutation.mutate({ token, viewerId: viewer.id, snooze }) },
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: ['review-snoozes', viewer?.id] })
      void queryClient.invalidateQueries({ queryKey: ['review-snooze-activity', token, viewer?.id] })
    },
  }
}
