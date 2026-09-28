export {
  DEFAULT_MATCH_POLICY,
  decide,
  type Candidate,
  type Decision,
  type ExceptionReason,
  type FollowUp,
  type MatchPolicy,
  type PaymentFacts,
} from './decide.js'
export { normalizeReference, referenceKey } from './reference.js'
export { suggest, type Suggestion, type SuggestionReason } from './suggest.js'
export {
  MatchError,
  applyMatch,
  loadCandidates,
  lockTransaction,
  readTransaction,
  resolveMatchExceptions,
  type ApplyMatchInput,
  type TransactionForMatching,
} from './store.js'
