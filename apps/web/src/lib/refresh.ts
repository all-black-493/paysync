'use client'

import { useQueryClient } from '@tanstack/react-query'
import { orpc } from './orpc'

/** After a change to money records: the lists and today's totals that can move with it. */
export function useRefreshRecords(): () => void {
  const queryClient = useQueryClient()
  return () => {
    for (const key of [
      orpc.exceptions.key(),
      orpc.transactions.key(),
      orpc.expected.key(),
      orpc.matches.key(),
      orpc.reports.key(),
      orpc.pendingActions.key(),
    ]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }
}
