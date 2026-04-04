export type {
  UnifiedEvent,
  UnifiedEventKind,
  ToolCallEvent,
  ToolCallResult,
  PermissionDecisionEvent,
  PermissionDecision,
  ContextLoadEvent,
  ContextResource,
  RoutingDecisionEvent,
  SessionLifecycleLogEvent,
  SessionLifecycleAction,
  VerificationEvent,
  VerificationStatus,
  CronSelfDestructEvent,
  EventFilter,
  EventPage,
  EventBase,
} from "./types.js";

export {
  appendEvent,
  queryEvents,
  queryAllEvents,
  onEvent,
  resolveEventLogPath,
  aggregateByKind,
  aggregateToolCalls,
  resetEventIdCountersForTests,
  type AppendEventInput,
  type EventCountByKind,
  type ToolCallStats,
} from "./store.js";

export {
  registerToolVerifier,
  hasVerifier,
  getRegisteredVerifierTools,
  runVerification,
  createErrorCheckVerifier,
  createDurationThresholdVerifier,
  clearVerifiersForTests,
  type ToolVerifier,
  type VerificationResult,
} from "./verification-hooks.js";

export {
  emitToolCall,
  emitToolCallAndVerify,
  emitContextLoad,
  emitRoutingDecision,
  emitSessionLifecycle,
  emitCronSelfDestruct,
  registerSessionLifecycleListener,
  setBaseDirForTests,
  setEnabledForTests,
  unregisterSessionLifecycleListenerForTests,
} from "./integrations.js";

export {
  createWriteVerifier,
  createExecVerifier,
  createMessageVerifier,
} from "./builtin-verifiers.js";

export { registerBuiltinVerifiers, unregisterAllVerifiers } from "./register-verifiers.js";
