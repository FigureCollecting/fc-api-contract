// coordinator.v1 — the client-facing wire contract.
//
// Wire types are generated from proto/ by protoc-gen-es and re-exported here.
// The hand-written helpers (version, hlc, sync-vocabulary) exist because the
// merge token's grammar and the facet-key grammar are part of the contract:
// the coordinator and every client must order and validate them identically,
// and golden/version-vectors.json is the shared test. UI helpers stay in
// fc-shared.

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

export {
  ProductRefSchema,
  SourceItemSchema,
  CardTextSchema,
  ProductCardSchema,
  GetProductsRequestSchema,
  GetProductsResponseSchema,
  GetProductImagesRequestSchema,
  GetProductImagesResponseSchema,
  ProductImagesSchema,
  ProductImageSchema,
  SearchProductsRequestSchema,
  SearchProductsResponseSchema,
  CatalogService,
  file_coordinator_v1_catalog,
} from './gen/coordinator/v1/catalog_pb.js';
export type {
  ProductRef,
  SourceItem,
  CardText,
  ProductCard,
  GetProductsRequest,
  GetProductsResponse,
  GetProductImagesRequest,
  GetProductImagesResponse,
  ProductImages,
  ProductImage,
  SearchProductsRequest,
  SearchProductsResponse,
} from './gen/coordinator/v1/catalog_pb.js';

export {
  ImportMfcExportRequestSchema,
  ImportMfcExportResponseSchema,
  UnresolvedMfcRowSchema,
  ImportService,
  file_coordinator_v1_import,
} from './gen/coordinator/v1/import_pb.js';
export type {
  ImportMfcExportRequest,
  ImportMfcExportResponse,
  UnresolvedMfcRow,
} from './gen/coordinator/v1/import_pb.js';

export {
  MAX_FUTURE_SKEW_MS,
  MAX_HLC_COUNTER,
  SERVER_DEVICE_ID,
  VersionError,
  canonicalInstant,
  canonicalVersion,
  compareVersion,
  isCanonicalVersion,
  normaliseDeviceId,
  parseVersion,
} from './version.js';
export type { ParsedVersion } from './version.js';

export { Hlc } from './hlc.js';
export type { HlcClock, HlcOptions, HlcState } from './hlc.js';

export {
  HOLDING_STATUSES,
  PUSH_REJECT_REASONS,
  USER_FACET_FIELDS,
  USER_FACET_PAYLOAD_SCHEMAS,
  parseUserFacetKey,
  userFacetKey,
} from './sync-vocabulary.js';
export type {
  HoldingStatus,
  PushRejectReason,
  UserFacetField,
  UserFacetKey,
} from './sync-vocabulary.js';
