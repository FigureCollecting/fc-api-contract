// coordinator.v1 — the client-facing wire contract.
//
// This barrel is the ONLY hand-written TypeScript in the package. Everything it
// re-exports is generated from proto/ by protoc-gen-es; nothing here adds
// behaviour, and nothing should. The estate's rule (plan §A.3): if a type
// crosses the wire it is generated and imported from this package; if it is UI
// vocabulary or a helper it lives in fc-shared. A convenience helper added here
// would be a second place to look for the same concept, which is how
// fc-shared's figureDisplayMeta became a stale mirror of a generated type.

export {
  CompareRequestSchema,
  CompareResponseSchema,
  CoverageSchema,
  CompareService,
  file_coordinator_v1_compare,
} from './gen/coordinator/v1/compare_pb.js';
export type {
  CompareRequest,
  CompareResponse,
  Coverage,
} from './gen/coordinator/v1/compare_pb.js';

export {
  SyncEventSchema,
  DeltaRequestSchema,
  DeltaResponseSchema,
  PushRequestSchema,
  PushResultSchema,
  PushResponseSchema,
  StatusRequestSchema,
  StatusResponseSchema,
  SyncOp,
  SyncOpSchema,
  PushOutcome,
  PushOutcomeSchema,
  SyncService,
  file_coordinator_v1_sync,
} from './gen/coordinator/v1/sync_pb.js';
export type {
  SyncEvent,
  DeltaRequest,
  DeltaResponse,
  PushRequest,
  PushResult,
  PushResponse,
  StatusRequest,
  StatusResponse,
} from './gen/coordinator/v1/sync_pb.js';
