import type { PermissionsDefinition } from '@paysync/auth'
import { createPermix } from 'permix'

export type Can = ReturnType<typeof createPermix<PermissionsDefinition>>['check']

/** Client-side mirror of the server's rules, for showing or hiding actions only; the API still enforces. */
export function permissionsFrom(state: Parameters<ReturnType<typeof createPermix<PermissionsDefinition>>['hydrate']>[0]) {
  const permix = createPermix<PermissionsDefinition>()
  permix.hydrate(state)
  return permix
}
