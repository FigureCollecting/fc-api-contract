// ============================================================================
// coordinator.v1 — the catalog read path for the client.
//
//   fc-mobile ──Connect-Web/TLS──► coordinator.v1.CatalogService
//                                       │ mints the entitlement assertion
//                                       │ SERVER-SIDE, per call
//                                       ▼
//                                  read.v1.SpineRead  (mesh, gRPC + mTLS)
//
// The spine answers with JSON text carrying every winning claim. This service
// does NOT pass that blob through, unlike CompareService. It maps it onto a
// small typed ProductCard through an explicit allowlist, because a card is
// cached on the phone and replayed offline: an unknown key or an image URL
// that names an original must never reach the device, and bytes already on a
// phone cannot be revoked.
//
// INVENTORY. ProductCard carries no inventory_level, in 0.2.0 or by default
// later. Inventory magnitude is an entitlement-gated claim (Ross, 2026-09-08:
// persist, gate delivery) and a card is offline-cached display data. Stock
// for a product is read through CompareService, which carries it gated and
// names a withholding in coverage.redacted. The coordinator still mints the
// assertion on every spine call; entitlement is asserted at that hop, not on
// the card. A gated field added to the card later must bring a Coverage lift
// with it in the same change.
//
// ER REDIRECTS. A merged product id stays valid forever: the spine resolves
// it through the redirect chain to the survivor. A ProductCard therefore
// names the survivor in head_id and echoes, in requested_as, every ref from
// this request that resolved to it. The client's facets stay keyed on the
// ids they were written against (never re-keyed, sync.proto rule 6): a copy
// names its figure in occ/{occ}/head, and uf facets sit under the head_id
// they were written for. Both are displayed through requested_as. Two held
// ids in one request that merge into one survivor come back as ONE card
// naming both; sync.proto rule 6 says whose copies it counts, which head a
// new write uses and what a delete clears. A client that hydrates over
// several GetProducts calls groups cards by head_id across every call and
// page and unions their requested_as; the display, write-target and delete
// rules of sync.proto rule 6 apply to that union.
//
// DISPLAY RESTRICTIONS (Ross, 2026-09-26). By default every image and its
// mask are shown to every viewer: to a user in their own views and to anyone
// opening a link the user shared. A display restriction overrides that
// default for one image (every derivative of it), one product (a restriction
// on any id that resolves to a head covers that head's images) or one source
// (every image captured from that store; an image captured from several is
// covered by each). A subject matches an id without regard to ASCII case.
// Restrictions are data, never code, and they only withhold: none grants
// anything, so every restriction that applies withholds what its scope names
// from the contexts its scope covers, whatever its level, and what a viewer
// is denied is the union of them. A restriction's scope says what it
// withholds and from which viewer context:
//
//   scope              withholds   from
//   no_display         the image   owner, share_link, anonymous
//   owner_views_only   the image   share_link, anonymous
//   no_share           the image   share_link, anonymous
//   no_mask            the mask    owner, share_link, anonymous
//
// no_share covers anonymous viewers too: a restriction against sharing
// cannot be bypassed by not signing in, and anonymous is the weakest context
// (orchestrator ruling 2026-10-09). Only these four scopes and the levels
// image, product and source are valid, and a writer rejects any other; a
// restriction read with any other scope or level (a typo such as "no-share"
// or "Image") fails closed: an unrecognised scope withholds the image from
// every viewer context, and an unrecognised level applies when its subject
// matches the image's id, any id that resolves to its head or any of its
// sources.
//
// The viewer context is `owner` (the signed-in user in their own views:
// every CatalogService call), `share_link` (anyone opening a link the owner
// shared, signed in or not) or `anonymous` (no account and no link).
// Restrictions are evaluated in ONE place, where an image list is built for
// a viewer: the GetProductImages list, a ProductCard's derivative_ids and
// any share projection the contract adds, each with the viewer context of
// its call. A withheld image is absent, its mask with it; a withheld mask is
// unset and the fields derived from it are computed without it
// (ProductImage). When the primary is withheld, the first image of the
// product shown to this caller, on whatever page it falls, is sent as the
// primary (primary set, role "primary"), so the list reads as if the
// withheld image never existed (orchestrator ruling 2026-10-09). A list the
// spine sends with no primary is sent with none.
//
// A denial is logged by the coordinator only when an evaluation withholds
// something the image has: the image, the viewer context and the
// restrictions that withheld it, each with its rule. Those are the ones that
// withhold the image when the image is withheld, else the ones that withhold
// its mask. An evaluation that withholds nothing, because no restriction
// applies, none covers the context or the image has no mask to withhold, is
// logged at debug level only (orchestrator ruling 2026-10-09).
//
// The caller is never told (orchestrator ruling 2026-10-09): unlike an
// entitlement withholding (CompareResponse.coverage.redacted), a display
// restriction is not named, and a list, its primary and its pages read as if
// a withheld image never existed. A client replaces a product's cached
// images with each fresh list and drops an image or mask the list no longer
// carries, since a restriction may have been added since.
// golden/display-vectors.json has the cases.
// ============================================================================

// @generated by protoc-gen-es v2.15.0 with parameter "target=ts,import_extension=js"
// @generated from file coordinator/v1/catalog.proto (package coordinator.v1, syntax proto3)
/* eslint-disable */

import type { GenFile, GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";
import { fileDesc, messageDesc, serviceDesc } from "@bufbuild/protobuf/codegenv2";
import type { Message } from "@bufbuild/protobuf";

/**
 * Describes the file coordinator/v1/catalog.proto.
 */
export const file_coordinator_v1_catalog: GenFile = /*@__PURE__*/
  fileDesc("Chxjb29yZGluYXRvci92MS9jYXRhbG9nLnByb3RvEg5jb29yZGluYXRvci52MSJrCgpQcm9kdWN0UmVmEhEKB2hlYWRfaWQYASABKAlIABIQCgZndGluMTQYAiABKAlIABIxCgtzb3VyY2VfaXRlbRgDIAEoCzIaLmNvb3JkaW5hdG9yLnYxLlNvdXJjZUl0ZW1IAEIFCgNyZWYiLQoKU291cmNlSXRlbRIMCgRzaXRlGAEgASgJEhEKCW5hdGl2ZV9pZBgCIAEoCSIoCghDYXJkVGV4dBINCgV2YWx1ZRgBIAEoCRINCgVhc19vZhgCIAEoCSKfBAoLUHJvZHVjdENhcmQSDwoHaGVhZF9pZBgBIAEoCRIwCgxyZXF1ZXN0ZWRfYXMYAiADKAsyGi5jb29yZGluYXRvci52MS5Qcm9kdWN0UmVmEicKBXRpdGxlGAMgASgLMhguY29vcmRpbmF0b3IudjEuQ2FyZFRleHQSLgoMbWFudWZhY3R1cmVyGAQgASgLMhguY29vcmRpbmF0b3IudjEuQ2FyZFRleHQSKAoGc2VyaWVzGAUgASgLMhguY29vcmRpbmF0b3IudjEuQ2FyZFRleHQSKwoJY2hhcmFjdGVyGAYgASgLMhguY29vcmRpbmF0b3IudjEuQ2FyZFRleHQSJwoFc2NhbGUYByABKAsyGC5jb29yZGluYXRvci52MS5DYXJkVGV4dBIsCgpyZWxlYXNlX3ltGAggASgLMhguY29vcmRpbmF0b3IudjEuQ2FyZFRleHQSDwoHZ3RpbjE0cxgJIAMoCRIvCg1jb250ZW50X2xldmVsGAogASgLMhguY29vcmRpbmF0b3IudjEuQ2FyZFRleHQSFgoOZGVyaXZhdGl2ZV9pZHMYCyADKAkSFgoJaGVpZ2h0X21tGAwgASgNSACIAQESFQoId2lkdGhfbW0YDSABKA1IAYgBARIVCghkZXB0aF9tbRgOIAEoDUgCiAEBQgwKCl9oZWlnaHRfbW1CCwoJX3dpZHRoX21tQgsKCV9kZXB0aF9tbSJlChJHZXRQcm9kdWN0c1JlcXVlc3QSKAoEcmVmcxgBIAMoCzIaLmNvb3JkaW5hdG9yLnYxLlByb2R1Y3RSZWYSEQoJcGFnZV9zaXplGAIgASgNEhIKCnBhZ2VfdG9rZW4YAyABKAkijQEKE0dldFByb2R1Y3RzUmVzcG9uc2USLQoIcHJvZHVjdHMYASADKAsyGy5jb29yZGluYXRvci52MS5Qcm9kdWN0Q2FyZBIuCgp1bnJlc29sdmVkGAIgAygLMhouY29vcmRpbmF0b3IudjEuUHJvZHVjdFJlZhIXCg9uZXh0X3BhZ2VfdG9rZW4YAyABKAkiUgoXR2V0UHJvZHVjdEltYWdlc1JlcXVlc3QSEAoIaGVhZF9pZHMYASADKAkSEQoJcGFnZV9zaXplGAIgASgNEhIKCnBhZ2VfdG9rZW4YAyABKAkiZAoYR2V0UHJvZHVjdEltYWdlc1Jlc3BvbnNlEi8KCHByb2R1Y3RzGAEgAygLMh0uY29vcmRpbmF0b3IudjEuUHJvZHVjdEltYWdlcxIXCg9uZXh0X3BhZ2VfdG9rZW4YAiABKAkiTgoNUHJvZHVjdEltYWdlcxIPCgdoZWFkX2lkGAEgASgJEiwKBmltYWdlcxgCIAMoCzIcLmNvb3JkaW5hdG9yLnYxLlByb2R1Y3RJbWFnZSLFAgoMUHJvZHVjdEltYWdlEhUKDWRlcml2YXRpdmVfaWQYASABKAkSDAoEcm9sZRgCIAEoCRIPCgdwcmltYXJ5GAMgASgIEhQKDGNvbnRlbnRfdHlwZRgEIAEoCRINCgV3aWR0aBgFIAEoDRIOCgZoZWlnaHQYBiABKA0SCwoDdXJsGAcgASgJEicKBG1hc2sYCCABKAsyGS5jb29yZGluYXRvci52MS5JbWFnZU1hc2sSHwoSYm90dG9tX21hcmdpbl9mcmFjGAkgASgBSACIAQESMQoMY29udGFjdF9iYW5kGAogASgLMhsuY29vcmRpbmF0b3IudjEuQ29udGFjdEJhbmQSEQoJdGh1bWJoYXNoGAsgASgMEhYKDmRvbWluYW50X2NvbG9yGAwgASgJQhUKE19ib3R0b21fbWFyZ2luX2ZyYWMiPwoJSW1hZ2VNYXNrEg8KB21hc2tfaWQYASABKAkSFAoMY29udGVudF90eXBlGAIgASgJEgsKA3VybBgDIAEoCSI4CgtDb250YWN0QmFuZBIVCg1jZW50ZXJfeF9mcmFjGAEgASgBEhIKCndpZHRoX2ZyYWMYAiABKAEiTQoVU2VhcmNoUHJvZHVjdHNSZXF1ZXN0Eg0KBXF1ZXJ5GAEgASgJEhEKCXBhZ2Vfc2l6ZRgCIAEoDRISCgpwYWdlX3Rva2VuGAMgASgJImAKFlNlYXJjaFByb2R1Y3RzUmVzcG9uc2USLQoIcHJvZHVjdHMYASADKAsyGy5jb29yZGluYXRvci52MS5Qcm9kdWN0Q2FyZBIXCg9uZXh0X3BhZ2VfdG9rZW4YAiABKAkysAIKDkNhdGFsb2dTZXJ2aWNlElYKC0dldFByb2R1Y3RzEiIuY29vcmRpbmF0b3IudjEuR2V0UHJvZHVjdHNSZXF1ZXN0GiMuY29vcmRpbmF0b3IudjEuR2V0UHJvZHVjdHNSZXNwb25zZRJlChBHZXRQcm9kdWN0SW1hZ2VzEicuY29vcmRpbmF0b3IudjEuR2V0UHJvZHVjdEltYWdlc1JlcXVlc3QaKC5jb29yZGluYXRvci52MS5HZXRQcm9kdWN0SW1hZ2VzUmVzcG9uc2USXwoOU2VhcmNoUHJvZHVjdHMSJS5jb29yZGluYXRvci52MS5TZWFyY2hQcm9kdWN0c1JlcXVlc3QaJi5jb29yZGluYXRvci52MS5TZWFyY2hQcm9kdWN0c1Jlc3BvbnNlYgZwcm90bzM");

/**
 * ---------------------------------------------------------------------------
 * ProductRef — one product, named one of three ways. A ref that matches
 * nothing is not an error; it comes back in GetProductsResponse.unresolved.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.ProductRef
 */
export type ProductRef = Message<"coordinator.v1.ProductRef"> & {
  /**
   * @generated from oneof coordinator.v1.ProductRef.ref
   */
  ref: {
    /**
     * A spine product id (lowercase dashed uuid), current or merged.
     *
     * @generated from field: string head_id = 1;
     */
    value: string;
    case: "headId";
  } | {
    /**
     * GS1 identifier (GTIN-14, zero-padded).
     *
     * @generated from field: string gtin14 = 2;
     */
    value: string;
    case: "gtin14";
  } | {
    /**
     * A store's own coordinates, e.g. ("mfc", "1144").
     *
     * @generated from field: coordinator.v1.SourceItem source_item = 3;
     */
    value: SourceItem;
    case: "sourceItem";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message coordinator.v1.ProductRef.
 * Use `create(ProductRefSchema)` to create a new message.
 */
export const ProductRefSchema: GenMessage<ProductRef> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 0);

/**
 * A store's site key and its native id for a record, verbatim.
 *
 * @generated from message coordinator.v1.SourceItem
 */
export type SourceItem = Message<"coordinator.v1.SourceItem"> & {
  /**
   * @generated from field: string site = 1;
   */
  site: string;

  /**
   * @generated from field: string native_id = 2;
   */
  nativeId: string;
};

/**
 * Describes the message coordinator.v1.SourceItem.
 * Use `create(SourceItemSchema)` to create a new message.
 */
export const SourceItemSchema: GenMessage<SourceItem> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 1);

/**
 * ---------------------------------------------------------------------------
 * CardText — one display value and when the spine first observed it.
 *
 * Presence carries meaning: an absent CardText means the spine holds no value
 * for that field, so the client renders "unknown", never an empty string.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.CardText
 */
export type CardText = Message<"coordinator.v1.CardText"> & {
  /**
   * The value as the spine holds it, never empty when the message is set.
   *
   * @generated from field: string value = 1;
   */
  value: string;

  /**
   * The spine's as_of for the claim that supplied `value`, as a canonical
   * instant (UTC, six fractional digits). Display only, never a merge token.
   * Empty when the value came from a materialized column with no claim time.
   *
   * @generated from field: string as_of = 2;
   */
  asOf: string;
};

/**
 * Describes the message coordinator.v1.CardText.
 * Use `create(CardTextSchema)` to create a new message.
 */
export const CardTextSchema: GenMessage<CardText> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 2);

/**
 * ---------------------------------------------------------------------------
 * ProductCard — the client-facing display record for one product.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.ProductCard
 */
export type ProductCard = Message<"coordinator.v1.ProductCard"> & {
  /**
   * The survivor: the cluster head the refs in requested_as resolved to.
   *
   * @generated from field: string head_id = 1;
   */
  headId: string;

  /**
   * The refs from THIS request that resolved to this card, as sent. Two refs
   * can name one product; a merged id names its survivor.
   *
   * @generated from field: repeated coordinator.v1.ProductRef requested_as = 2;
   */
  requestedAs: ProductRef[];

  /**
   * @generated from field: coordinator.v1.CardText title = 3;
   */
  title?: CardText | undefined;

  /**
   * @generated from field: coordinator.v1.CardText manufacturer = 4;
   */
  manufacturer?: CardText | undefined;

  /**
   * The origin series (the work), e.g. "Character Vocal Series".
   *
   * @generated from field: coordinator.v1.CardText series = 5;
   */
  series?: CardText | undefined;

  /**
   * @generated from field: coordinator.v1.CardText character = 6;
   */
  character?: CardText | undefined;

  /**
   * As the store states it, e.g. "1/7" or "Non-scale".
   *
   * @generated from field: coordinator.v1.CardText scale = 7;
   */
  scale?: CardText | undefined;

  /**
   * "YYYY-MM".
   *
   * @generated from field: coordinator.v1.CardText release_ym = 8;
   */
  releaseYm?: CardText | undefined;

  /**
   * Every GTIN-14 in the cluster, zero-padded. No as_of: identifiers are
   * facts about the product, not observations of it.
   *
   * @generated from field: repeated string gtin14s = 9;
   */
  gtin14s: string[];

  /**
   * The source's content level: general | intermediate | explicit |
   * controversial | nsfw | nsfw+ | unknown. Absent means the source has no
   * level concept. Treat `unknown` as the most restrictive.
   *
   * @generated from field: coordinator.v1.CardText content_level = 10;
   */
  contentLevel?: CardText | undefined;

  /**
   * Hex SHA-256 content addresses of display DERIVATIVES, primary first.
   * Never an original, never a URL; fetch refs come from GetProductImages.
   * Empty until derivatives exist. Only the derivatives shown to this caller,
   * the first of them in place of a withheld primary (DISPLAY RESTRICTIONS).
   *
   * @generated from field: repeated string derivative_ids = 11;
   */
  derivativeIds: string[];

  /**
   * The physical size of the product itself, the figure with its base, never
   * the box, in whole millimetres, rounded half up from the spine's value.
   * Unset means unknown, never 0. Height is the total height, base included;
   * width runs left to right and depth front to back as the figure faces the
   * viewer (MFC's L is depth). Whole millimetres are finer than any source
   * states a figure's size, and the client sizes and fits figures in them.
   *
   * @generated from field: optional uint32 height_mm = 12;
   */
  heightMm?: number | undefined;

  /**
   * @generated from field: optional uint32 width_mm = 13;
   */
  widthMm?: number | undefined;

  /**
   * @generated from field: optional uint32 depth_mm = 14;
   */
  depthMm?: number | undefined;
};

/**
 * Describes the message coordinator.v1.ProductCard.
 * Use `create(ProductCardSchema)` to create a new message.
 */
export const ProductCardSchema: GenMessage<ProductCard> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 3);

/**
 * ---------------------------------------------------------------------------
 * GetProducts — the cards for a batch of refs, one page at a time.
 *
 * PAGING. The client MUST follow next_page_token until it is empty. The
 * coordinator passes the spine's pages through one to one; the token is
 * opaque and bound to the ref list, so send the same refs with every page.
 * Products come back in the order of their first naming ref, deduplicated.
 * `unresolved` describes the batch and is returned on the first page only: a
 * client that appends pages must not append it again.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.GetProductsRequest
 */
export type GetProductsRequest = Message<"coordinator.v1.GetProductsRequest"> & {
  /**
   * At most 200 refs. More, or none, is INVALID_ARGUMENT before any spine
   * call; the batch is never truncated.
   *
   * @generated from field: repeated coordinator.v1.ProductRef refs = 1;
   */
  refs: ProductRef[];

  /**
   * 0 = the server default (currently 50), capped at 200. Both clamp
   * silently: read the page you were given, never assume its size.
   *
   * @generated from field: uint32 page_size = 2;
   */
  pageSize: number;

  /**
   * Empty for the first page, else the previous next_page_token.
   *
   * @generated from field: string page_token = 3;
   */
  pageToken: string;
};

/**
 * Describes the message coordinator.v1.GetProductsRequest.
 * Use `create(GetProductsRequestSchema)` to create a new message.
 */
export const GetProductsRequestSchema: GenMessage<GetProductsRequest> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 4);

/**
 * @generated from message coordinator.v1.GetProductsResponse
 */
export type GetProductsResponse = Message<"coordinator.v1.GetProductsResponse"> & {
  /**
   * @generated from field: repeated coordinator.v1.ProductCard products = 1;
   */
  products: ProductCard[];

  /**
   * Refs that matched no product, as sent. First page only.
   *
   * @generated from field: repeated coordinator.v1.ProductRef unresolved = 2;
   */
  unresolved: ProductRef[];

  /**
   * Empty on the last page.
   *
   * @generated from field: string next_page_token = 3;
   */
  nextPageToken: string;
};

/**
 * Describes the message coordinator.v1.GetProductsResponse.
 * Use `create(GetProductsResponseSchema)` to create a new message.
 */
export const GetProductsResponseSchema: GenMessage<GetProductsResponse> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 5);

/**
 * ---------------------------------------------------------------------------
 * GetProductImages — derivative refs for a batch of products.
 *
 * Pass head ids as ProductCard.head_id names them. Paging is over IMAGE
 * ROWS, not products, with the same token rules as GetProducts: follow
 * next_page_token until it is empty, and a product's images may span pages.
 * A product with no displayable derivative is simply absent, as is one whose
 * every image a display restriction withholds from this caller (DISPLAY
 * RESTRICTIONS). Withheld rows are dropped before the page is cut, so no page
 * is shorter for them.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.GetProductImagesRequest
 */
export type GetProductImagesRequest = Message<"coordinator.v1.GetProductImagesRequest"> & {
  /**
   * At most 200; more, or none, is INVALID_ARGUMENT.
   *
   * @generated from field: repeated string head_ids = 1;
   */
  headIds: string[];

  /**
   * 0 = the server default (currently 50), capped at 200.
   *
   * @generated from field: uint32 page_size = 2;
   */
  pageSize: number;

  /**
   * @generated from field: string page_token = 3;
   */
  pageToken: string;
};

/**
 * Describes the message coordinator.v1.GetProductImagesRequest.
 * Use `create(GetProductImagesRequestSchema)` to create a new message.
 */
export const GetProductImagesRequestSchema: GenMessage<GetProductImagesRequest> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 6);

/**
 * @generated from message coordinator.v1.GetProductImagesResponse
 */
export type GetProductImagesResponse = Message<"coordinator.v1.GetProductImagesResponse"> & {
  /**
   * @generated from field: repeated coordinator.v1.ProductImages products = 1;
   */
  products: ProductImages[];

  /**
   * Empty on the last page.
   *
   * @generated from field: string next_page_token = 2;
   */
  nextPageToken: string;
};

/**
 * Describes the message coordinator.v1.GetProductImagesResponse.
 * Use `create(GetProductImagesResponseSchema)` to create a new message.
 */
export const GetProductImagesResponseSchema: GenMessage<GetProductImagesResponse> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 7);

/**
 * @generated from message coordinator.v1.ProductImages
 */
export type ProductImages = Message<"coordinator.v1.ProductImages"> & {
  /**
   * @generated from field: string head_id = 1;
   */
  headId: string;

  /**
   * Render order: the primary first, then the gallery by position. When the
   * primary is withheld from this caller, the first image shown is sent as
   * the primary (DISPLAY RESTRICTIONS).
   *
   * @generated from field: repeated coordinator.v1.ProductImage images = 2;
   */
  images: ProductImage[];
};

/**
 * Describes the message coordinator.v1.ProductImages.
 * Use `create(ProductImagesSchema)` to create a new message.
 */
export const ProductImagesSchema: GenMessage<ProductImages> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 8);

/**
 * One derivative the client may show. The original's content address, its
 * object key and the capture that observed it are not on this surface.
 *
 * @generated from message coordinator.v1.ProductImage
 */
export type ProductImage = Message<"coordinator.v1.ProductImage"> & {
  /**
   * Hex SHA-256 of the derivative bytes.
   *
   * @generated from field: string derivative_id = 1;
   */
  derivativeId: string;

  /**
   * The spine's role for the image, e.g. "primary" or "gallery"; "primary"
   * on the image sent as the primary in place of a withheld one (DISPLAY
   * RESTRICTIONS).
   *
   * @generated from field: string role = 2;
   */
  role: string;

  /**
   * @generated from field: bool primary = 3;
   */
  primary: boolean;

  /**
   * e.g. "image/webp". Empty when unknown.
   *
   * @generated from field: string content_type = 4;
   */
  contentType: string;

  /**
   * Pixel dimensions; 0 when unknown.
   *
   * @generated from field: uint32 width = 5;
   */
  width: number;

  /**
   * @generated from field: uint32 height = 6;
   */
  height: number;

  /**
   * Content-addressed and immutable, so it may be cached forever. Empty when
   * no public media base is configured; the client shows a placeholder.
   *
   * @generated from field: string url = 7;
   */
  url: string;

  /**
   * The separate alpha mask for this derivative (Ross, 2026-09-26: masking
   * is a non-destructive, display-time overlay; the derivative is never cut
   * out). Unset when there is none or when a display restriction withholds
   * it from this caller (DISPLAY RESTRICTIONS).
   *
   * @generated from field: coordinator.v1.ImageMask mask = 8;
   */
  mask?: ImageMask | undefined;

  /**
   * GROUNDING, measured on the mask's alpha, or on the derivative's own
   * alpha when it has one, where opaque means alpha above 10 of 255. The
   * grounding fields, thumbhash and dominant_color describe the image as
   * THIS caller is shown it: when a display restriction withholds the mask
   * from the caller they are computed without it (the grounding fields on
   * the derivative's own alpha, else unset), so a withheld mask never
   * reaches the caller through a field derived from it.
   *
   * The fraction of the image's height that is transparent below its lowest
   * opaque row, 0 to 1: how far to lower the image so the figure stands on
   * the shelf. Unset when not measured; 0 is a measurement (the figure
   * touches the bottom edge).
   *
   * @generated from field: optional double bottom_margin_frac = 9;
   */
  bottomMarginFrac?: number | undefined;

  /**
   * Where the figure's base meets the shelf. Unset when not measured or when
   * no opaque row was found.
   *
   * @generated from field: coordinator.v1.ContactBand contact_band = 10;
   */
  contactBand?: ContactBand | undefined;

  /**
   * A ThumbHash (github.com/evanw/thumbhash) of the image as this caller is
   * shown it, the mask applied only when the caller is sent one: the
   * placeholder while it loads. Empty when unknown.
   *
   * @generated from field: bytes thumbhash = 11;
   */
  thumbhash: Uint8Array;

  /**
   * The dominant color of the image as this caller is shown it, as
   * "#rrggbb", lowercase. Empty when unknown.
   *
   * @generated from field: string dominant_color = 12;
   */
  dominantColor: string;
};

/**
 * Describes the message coordinator.v1.ProductImage.
 * Use `create(ProductImageSchema)` to create a new message.
 */
export const ProductImageSchema: GenMessage<ProductImage> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 9);

/**
 * An alpha mask the client composites over its derivative at display time.
 * Same pixel dimensions as its derivative.
 *
 * @generated from message coordinator.v1.ImageMask
 */
export type ImageMask = Message<"coordinator.v1.ImageMask"> & {
  /**
   * Hex SHA-256 of the mask bytes.
   *
   * @generated from field: string mask_id = 1;
   */
  maskId: string;

  /**
   * e.g. "image/png"; its alpha channel is the mask. Empty when unknown.
   *
   * @generated from field: string content_type = 2;
   */
  contentType: string;

  /**
   * Content-addressed and immutable, cached like ProductImage.url. Empty
   * when no public media base is configured.
   *
   * @generated from field: string url = 3;
   */
  url: string;
};

/**
 * Describes the message coordinator.v1.ImageMask.
 * Use `create(ImageMaskSchema)` to create a new message.
 */
export const ImageMaskSchema: GenMessage<ImageMask> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 10);

/**
 * The opaque pixels in the bottom contact band, the lowest 8 % of the image's
 * height ending at its lowest opaque row, as fractions of the image width.
 *
 * @generated from message coordinator.v1.ContactBand
 */
export type ContactBand = Message<"coordinator.v1.ContactBand"> & {
  /**
   * Horizontal centre of the band's opaque pixels, 0 to 1 from the left.
   *
   * @generated from field: double center_x_frac = 1;
   */
  centerXFrac: number;

  /**
   * Width of the band's opaque pixels, 0 to 1.
   *
   * @generated from field: double width_frac = 2;
   */
  widthFrac: number;
};

/**
 * Describes the message coordinator.v1.ContactBand.
 * Use `create(ContactBandSchema)` to create a new message.
 */
export const ContactBandSchema: GenMessage<ContactBand> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 11);

/**
 * ---------------------------------------------------------------------------
 * SearchProducts — catalog-wide free-text search. Defined in 0.2.0 and
 * answered UNIMPLEMENTED until the spine's search read lands; filters arrive
 * as additive fields then.
 * ---------------------------------------------------------------------------
 *
 * @generated from message coordinator.v1.SearchProductsRequest
 */
export type SearchProductsRequest = Message<"coordinator.v1.SearchProductsRequest"> & {
  /**
   * Free text, Latin or kana. Empty is INVALID_ARGUMENT.
   *
   * @generated from field: string query = 1;
   */
  query: string;

  /**
   * 0 = the server default; capped at 50.
   *
   * @generated from field: uint32 page_size = 2;
   */
  pageSize: number;

  /**
   * Empty for the first page, else the previous next_page_token.
   *
   * @generated from field: string page_token = 3;
   */
  pageToken: string;
};

/**
 * Describes the message coordinator.v1.SearchProductsRequest.
 * Use `create(SearchProductsRequestSchema)` to create a new message.
 */
export const SearchProductsRequestSchema: GenMessage<SearchProductsRequest> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 12);

/**
 * @generated from message coordinator.v1.SearchProductsResponse
 */
export type SearchProductsResponse = Message<"coordinator.v1.SearchProductsResponse"> & {
  /**
   * @generated from field: repeated coordinator.v1.ProductCard products = 1;
   */
  products: ProductCard[];

  /**
   * Empty on the last page.
   *
   * @generated from field: string next_page_token = 2;
   */
  nextPageToken: string;
};

/**
 * Describes the message coordinator.v1.SearchProductsResponse.
 * Use `create(SearchProductsResponseSchema)` to create a new message.
 */
export const SearchProductsResponseSchema: GenMessage<SearchProductsResponse> = /*@__PURE__*/
  messageDesc(file_coordinator_v1_catalog, 13);

/**
 * ---------------------------------------------------------------------------
 * CatalogService — READ-ONLY.
 *
 * ERROR CONTRACT:
 *   * an empty or oversized batch, a ref with no case set, or a page_token
 *     not issued for this batch -> INVALID_ARGUMENT, before any spine call.
 *   * missing or invalid OIDC token or DPoP proof -> UNAUTHENTICATED, as
 *     CompareService.
 *   * a ref that matches nothing -> OK, listed in `unresolved`.
 *   * the caller lacks an entitlement -> OK. Nothing on these messages is
 *     gated in 0.2.0.
 *   * a display restriction withholds an image or a mask from the caller ->
 *     OK, the image or mask absent and the restriction not named (DISPLAY
 *     RESTRICTIONS).
 *   * spine unreachable -> UNAVAILABLE. Every call is a pure read and may be
 *     retried freely.
 *   * SearchProducts -> UNIMPLEMENTED until served.
 * ---------------------------------------------------------------------------
 *
 * @generated from service coordinator.v1.CatalogService
 */
export const CatalogService: GenService<{
  /**
   * @generated from rpc coordinator.v1.CatalogService.GetProducts
   */
  getProducts: {
    methodKind: "unary";
    input: typeof GetProductsRequestSchema;
    output: typeof GetProductsResponseSchema;
  },
  /**
   * @generated from rpc coordinator.v1.CatalogService.GetProductImages
   */
  getProductImages: {
    methodKind: "unary";
    input: typeof GetProductImagesRequestSchema;
    output: typeof GetProductImagesResponseSchema;
  },
  /**
   * @generated from rpc coordinator.v1.CatalogService.SearchProducts
   */
  searchProducts: {
    methodKind: "unary";
    input: typeof SearchProductsRequestSchema;
    output: typeof SearchProductsResponseSchema;
  },
}> = /*@__PURE__*/
  serviceDesc(file_coordinator_v1_catalog, 0);

