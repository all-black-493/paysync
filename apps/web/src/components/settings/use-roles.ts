'use client'

import { customRolePermissions, type AppPermission } from '@paysync/auth'
import { useQuery } from '@tanstack/react-query'
import { authClient } from '../../lib/auth-client'

export interface CustomRole {
  readonly id: string
  readonly name: string
  readonly permissions: readonly AppPermission[]
}

function statementsOf(permission: unknown): unknown {
  if (typeof permission !== 'string') return permission
  try {
    return JSON.parse(permission) as unknown
  } catch {
    return null
  }
}

export const ROLES_KEY = ['organization-roles'] as const

/** The organization's custom roles, as stored by Better Auth. */
export function useCustomRoles() {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: async (): Promise<CustomRole[]> => {
      const { data, error } = await authClient.organization.listRoles()
      if (error) throw new Error(error.message ?? 'Could not load roles')
      return data.map((r) => ({ id: r.id, name: r.role, permissions: customRolePermissions(statementsOf(r.permission)) }))
    },
  })
}
