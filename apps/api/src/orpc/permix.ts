import type { PermissionsDefinition } from '@paysync/auth'
import { createPermix } from 'permix/orpc'

export const permix = createPermix<PermissionsDefinition>().contextKey('permix')

export type PermissionPath = typeof permix.$inferPath
