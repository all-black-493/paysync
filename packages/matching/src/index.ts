export {
  DEFAULT_MATCH_POLICY,
  decide,
  settle,
  type Candidate,
  type Decision,
  type ExceptionDecision,
  type ExceptionReason,
  type FollowUp,
  type JevEvidence,
  type MatchDecision,
  type MatchPolicy,
  type PaymentFacts,
} from './decide.js'
export { afterJev, jevCandidates, needsJev } from './jev-tier.js'
export { normalizeReference, referenceKey } from './reference.js'
export { suggest, type Suggestion, type SuggestionReason } from './suggest.js'
export {
  MatchError,
  applyMatch,
  loadCandidates,
  lockTransaction,
  readTransaction,
  resolveMatchExceptions,
  undoMatch,
  type ApplyMatchInput,
  type TransactionForMatching,
} from './store.js'
