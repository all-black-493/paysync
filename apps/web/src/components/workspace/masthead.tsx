'use client'

import type { MeOutput } from '@paysync/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { authClient } from '../../lib/auth-client'
import { roleLabel } from '../../lib/labels'
import { Chevron } from '../ui/chevron'

export function Masthead({ me }: { me: MeOutput }) {
  return (
    <header className="masthead">
      <div className="brand">
        <span className="wordmark">Paysync</span>
        <h1>{me.organization.name}</h1>
      </div>
      <AccountMenu name={me.actor.name} role={roleLabel(me.role)} />
    </header>
  )
}

function AccountMenu({ name, role }: { name: string; role: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    function close(event: MouseEvent | KeyboardEvent) {
      const details = ref.current
      if (!details?.open) return
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !details.contains(event.target as Node)) details.open = false
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', close)
    }
  }, [])

  return (
    <details className="account" ref={ref}>
      <summary>
        <span>{name}</span>
        <span className="role">{role}</span>
        <Chevron />
      </summary>
      <div className="account-menu">
        <button
          type="button"
          onClick={() => void authClient.organization.setActive({ organizationId: null }).then(() => queryClient.invalidateQueries())}
        >
          Switch organization
        </button>
        <button
          type="button"
          onClick={() => {
            void authClient.signOut().then(() => {
              router.replace('/sign-in/')
            })
          }}
        >
          Sign out
        </button>
      </div>
    </details>
  )
}
