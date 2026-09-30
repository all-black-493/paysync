'use client'

import { ORPCError } from '@orpc/client'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { OrgPicker } from '../components/entry/org-picker'
import { Workspace } from '../components/workspace/workspace'
import { authClient } from '../lib/auth-client'
import { orpc } from '../lib/orpc'

export default function HomePage() {
  const router = useRouter()
  const session = authClient.useSession()

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/sign-in/')
  }, [session.isPending, session.data, router])

  if (session.isPending || !session.data) return <main className="loading-screen">Loading…</main>
  return <Home />
}

function Home() {
  const me = useQuery(orpc.me.get.queryOptions())
  const noActiveOrg = me.error instanceof ORPCError && me.error.code === 'FORBIDDEN'

  if (me.isPending) return <main className="loading-screen">Loading…</main>
  if (noActiveOrg) return <OrgPicker />
  if (me.isError) return <main className="loading-screen error">Could not load your workspace.</main>
  return <Workspace me={me.data} />
}
