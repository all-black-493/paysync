import { approvalsDecide } from './decide.js'
import { pendingActionsGet, pendingActionsList } from './list.js'

export const pendingActionProcedures = { list: pendingActionsList, get: pendingActionsGet }
export const approvalProcedures = { decide: approvalsDecide }
