import { sql } from 'drizzle-orm'
import { bigint, char, customType, foreignKey, integer, text, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { organization } from './auth.js'

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const id = () => uuid().primaryKey().default(sql`uuidv7()`)
export const orgId = () =>
  text()
    .notNull()
    .references(() => organization.id, { onDelete: 'restrict' })
/** Minor units (cents). Never floats. */
export const money = () => bigint({ mode: 'bigint' }).notNull()
export const currency = () => char({ length: 3 }).notNull().default('KES')
export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
export const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
export const version = () => integer().notNull().default(1)

/** Parent side of a same-org foreign key. */
export function idOrgUnique(name: string, cols: { id: AnyPgColumn; orgId: AnyPgColumn }) {
  return unique(name).on(cols.id, cols.orgId)
}

/** Child row and parent row must belong to the same organization. */
export function sameOrg(
  name: string,
  child: { column: AnyPgColumn; orgId: AnyPgColumn },
  parent: { id: AnyPgColumn; orgId: AnyPgColumn },
) {
  return foreignKey({ name, columns: [child.column, child.orgId], foreignColumns: [parent.id, parent.orgId] })
}

export function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`)
}
