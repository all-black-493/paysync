import type { Contract } from '@paysync/contract'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterContractClient } from '@orpc/contract'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

const link = new RPCLink({
  origin: () => window.location.origin,
  url: '/api/rpc',
})

export const client: RouterContractClient<Contract> = createORPCClient(link)
export const orpc = createTanstackQueryUtils(client)
