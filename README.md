# fc-api-contract

`coordinator.v1` — the **client-facing** wire contract served by `fc-coordinator` and consumed by
`fc-mobile`. Protos are the source of truth; TypeScript is generated from them, committed, and
published to GitHub Packages as `@figurecollecting/fc-api-contract`.

## What lives here, and what does not

| | |
|---|---|
| **Here** | Anything that crosses the wire between a client and the coordinator: request/response messages, the sync event, enums, service definitions. Generated, never hand-edited. |
| **`fc-shared`** | Hand-written, human-facing TypeScript: UI vocabulary, the api client shape, stores, helpers. Where it describes the same concept as a message here, it **re-exports** the generated type rather than redeclaring it — a redeclared type is how `figureDisplayMeta.ts` became a stale mirror. |
| **`fc-ingest-contract`** | The **spine** contract (`ingest.v1`, `read.v1`), spoken inside the mesh between the scraper, fc-aggregation and the coordinator. The coordinator depends on both packages: on the spine contract because it *calls* the spine, on this one because it *serves* the client. |

The package ships a few **hand-written helpers**, and only for grammars that are part of the wire
contract: the `version` token (`parseVersion`, `compareVersion`, `canonicalInstant`,
`canonicalVersion`, and the `Hlc` that mints tokens) and the facet keys (`parseUserFacetKey`,
`parseServerFacetKey`, `buildFacetKey` and one builder per family, `parseCollectionRef`, and the
MFC import's `canonicalMfcId`, `mfcImportOccName` and `importOccIdFromMac`). The coordinator and
every client must order and validate these identically, so they live next to the protos with
shared test files, `golden/version-vectors.json`, `golden/key-vectors.json` and
`golden/import-vectors.json`. Convenience wrappers and UI helpers still belong in `fc-shared`.

## The compatibility rule

**Additive only. Never rename a field. Never renumber a field. Never delete one.**

This is stricter than the spine contract's rule, and the reason is the consumer, not taste. The
spine's consumers are operator-deployed services that redeploy together, so `buf breaking
--use WIRE_JSON` — "can a new server and an old server still exchange bytes?" — is the right
question there.

This contract's consumers are **phones**. A PWA installed six months ago is still running its own
copy of these types and will not update because we shipped. Deleting a field does not break its
parser; unknown fields are skipped. It blanks a screen.

So the breaking check here runs buf's strictest category, `FILE`, which adds `FIELD_NO_DELETE`,
`ENUM_VALUE_NO_DELETE`, `MESSAGE_NO_DELETE` and `RPC_NO_DELETE` on top of everything `WIRE_JSON`
checks. (`WIRE_JSON` waves through a field or enum-value deletion once the number is reserved,
which is exactly how a careful author retires one.) The rule above is not a convention anyone has
to remember; CI enforces it.

The payload JSON Schemas get the same treatment, because `buf` cannot see them: a published schema
never gains a property (a new attribute is a new facet key, since every write replaces the whole
payload). `scripts/schema-growth.ts` (`npm run schema-growth`, in the contract job and before every
publish) compares each schema the previous `v*` tag published with the working tree: every keyword
must be unchanged at every depth except the annotations (`title`, `description`, `$comment`,
`examples`), which no validator reads, and `enum`, which may only grow. So no property, pattern
property or subschema is added or removed, a closed object stays closed, and no type, bound, pattern
or format changes. A schema is removed only by retiring it by name in the script's `RETIRED_SCHEMAS`.

**The gate of record is the contract job on the PR**, where a break is cheap to fix. The publish
workflow re-runs the same check as belt and braces, because a tag can be cut from any commit and
an npm version is immutable once it exists. That second run is only meaningful because
`scripts/buf-breaking.sh` excludes tags pointing at `HEAD`: at tag-push time the highest `v*` tag
*is* the release being cut, so selecting it naively would compare a release against itself and
pass anything. The script also refuses to run in a shallow clone, where no tags are visible and
the skip path would otherwise report "first release" over a real break.

In practice:

- **Adding** a field, an enum value, a message or an RPC is always fine.
- **Retiring** a field means leaving it in place and ignoring it, or `reserved`-ing the number and
  the name so it can never be reused. A reused number makes an old app read the new field as the
  old one.
- **Changing meaning in place** is the one break `buf` cannot see. Repurposing `version` from an
  `as_of` token to a counter would pass every check and corrupt every phone in the field. Add a new
  field instead.
- Enum values that an old client has never heard of survive its decode as raw numbers (proto3 enums
  are open), which is what `*_UNSPECIFIED = 0` is for: it lets a client tell "not set" from
  "something newer than me".

## Layout

```
proto/coordinator/v1/compare.proto   Compare pass-through (spine read.v1, carried verbatim)
proto/coordinator/v1/sync.proto      SyncEvent + Delta / Push / Status, version and facet-key grammar
proto/coordinator/v1/catalog.proto   ProductCard reads: GetProducts / GetProductImages / SearchProducts
proto/coordinator/v1/import.proto    ImportMfcExport
src/gen/                             generated TypeScript — COMMITTED, never hand-edited
src/index.ts                         re-export barrel
src/version.ts, src/hlc.ts           version grammar, comparator, HLC
src/sync-vocabulary.ts               facet-key grammar and builders, occurrence statuses, REJECTED reason codes
golden/version-vectors.json          version cases every implementation tests against
golden/key-vectors.json              facet-key and MFC-id cases every implementation tests against
golden/import-vectors.json           re-import and import-crossing cases, server and client
schemas/                             JSON Schemas for the facet payloads, one per family, closed forever
scripts/buf-breaking.sh              buf breaking against the previous v* tag
scripts/schema-growth.ts             no published payload schema gains a property
tests/                               codec round-trips and the invariants the comments claim
```

`src/gen` is committed on purpose. `fc-ingest-contract` gitignores its generated output; this repo
does not, because a wire-type change should be visible in a pull-request diff, and because CI can
then prove the committed output is what the protos actually produce (`npm run generate` followed by
`git diff --exit-code`). Generated code that only exists at publish time can be neither reviewed
nor drift-checked.

**Payloads cross the wire as JSON text, never `google.protobuf.Struct`.** `CompareResponse.result_json`
and `SyncEvent.payload` are strings. `ProductCard` is the one typed read: the coordinator maps the
spine's JSON onto it through an allowlist, because a card is cached on the phone and an unknown key
or an original's image URL must never reach it. Its values are still strings. `Struct` folds every JSON number to float64, which silently
corrupts a long product code or a trailing-zero price. Instants are raw ISO-8601 strings for the
same reason, never `google.protobuf.Timestamp`: PostgreSQL is the arbiter of meaning and the wire
carries the token it arbitrated. This is inherited verbatim from `read.v1`.

## The `version` token

`SyncEvent.version` is the merge token: a client applies an event when `version > local[facet_key]`.
That is a **string** comparison, so the spelling is part of the contract.

**Instant: UTC, a trailing `Z`, exactly six fractional digits** — `2026-09-14T11:30:00.123456Z`.
An offset spelling (`+09:00`) breaks the identity between lexicographic order and instant order
outright. Variable precision breaks it more quietly: PostgreSQL renders a zero fraction as
`...:00Z`, and `.` sorts below `Z`, so `2026-09-14T11:30:00Z` sorts *greater* than
`2026-09-14T11:30:00.000000Z` — one instant, two spellings, inverted.

**User-owned facets carry the HLC form** (0.2.0), `<instant>#<10-digit counter>#<32-hex device id>`:

```
2026-09-14T11:30:00.123456Z#0000000007#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e
```

The device id is the enrolled device's uuid, lowercase and dashless; the MFC import writes under the
reserved all-zero id. Every segment is fixed width, so bytewise order is version order and the
device id makes it total. Tokens in the grammar order the same under C, glibc and ICU collations,
but an out-of-grammar token (an uppercase or dashed device id) does not, so the server rejects one
before storing it and compares with `compareVersion()` or on a `TEXT COLLATE "C"` column, never
with `<` under a locale collation. The `Hlc` mints each edit above its facet's local version
(`tick(base)`), trusts the wall clock after a sleep and recovers from a clock jump through
`rebase()`. `sync.proto` rule 5 has the ordering table and the clock rules;
`golden/version-vectors.json` has the cases.

A grammar change passes `buf breaking`, so it is a semantic break buf cannot see. 0.2.0 made one
(0.1.0 sketched `<instant>#<counter>` with no device id) and it is safe only because no 0.1.0
`SyncService` consumer exists. The grammar is frozen from here: extend it only by a further
fixed-width suffix, never by a separate field.

## Facet keys and payloads

`sync.proto` rule 6 is the key table. A user's collection is **per copy**: each copy is an
occurrence (`occ/{occ}/head`, `/status`, `/collection`, `/disposal`, `/tag/{tag}`), a quantity is
the count of live copies, figure-level fields and tags live under `uf/{head_id}/…`, and
collections and tags have name facets (`coll/{kind}/{cid|default}/name`, `tag/{tag}/name`). The
server owns `occ/{occ}/origin` and the import's `imp/{site}/base|conflict/{key}` facets
(`import.proto` has the three-way re-import rule, run per field and on each row's Count, with heads
compared through the spine's redirect chain; its copies get occ ids keyed by a secret only the
coordinator holds). An import write or conflict that crosses an edit still on a phone, on the facet
or on the copy's row, is presented to the user there, never silently adopted (rule 6, IMPORT
CROSSINGS). Every payload schema is closed and stays closed:
a new attribute is a new facet key, never a new property, because every write replaces the whole
payload and an older writer would drop a property it does not know.

A key change passes `buf breaking` too. **0.3.0 made one**: it retired 0.2.x's per-figure
`holding/{head_id}/status|count` grain for per-copy occurrences (a Push of a `holding/*` key is now
REJECTED `facet_key_not_user_owned`). It is safe only because no device had installed 0.2.x and no
import had run; 0.2.x is deprecated. `golden/key-vectors.json` and the vocabulary tests guard the
grammar: every valid key parses to exactly one family and builds back to itself.

## Two doctrines the messages encode

**The coordinator passes the spine's answer through; it does not re-derive it.**
`CompareResponse.coverage` lifts two facts out of `result_json` rather than computing them.
`redacted` names the facets withheld — same members, same order — so a client can branch on
redaction without parsing the blob. A caller lacking the `inventory_levels` entitlement gets a
**successful** response with the facet absent and named there. Absence is stated, never implied.
`semantics_rev` is the spine's `coverage.semanticsRev`, the stable hash of the orderability
semantics that produced the verdicts inside the blob. It is lifted for a specific reason: `FILE`
strictness protects this *envelope* and cannot see inside `result_json`, so `semanticsRev` is the
only signal a client gets that the spine changed how a verdict is derived.

`coverage` is a proto3 message field and therefore carries presence. Null-check it
(`res.coverage?.redacted`); a server that omits it decodes to `undefined`, not to an empty
`Coverage`.

## Local development

```bash
npm ci
npm run lint        # buf lint (STANDARD, no exceptions)
npm run breaking    # buf breaking vs the PREVIOUS v* tag; skips cleanly when there is none
npm run schema-growth  # no payload schema that tag published changed beyond annotations and enum growth
npm run generate    # regenerate src/gen from proto/ — commit the result
npm run typecheck
npm run build       # tsc -> dist/
npm test            # vitest
npm run test:ci     # vitest with coverage + the 85% gate
npm run verify      # everything above, in the order CI runs it
```

`npm ci` needs no registry token: this package depends only on public `@bufbuild` packages, never
on another `@figurecollecting` one.

## Release

1. Land the change on `develop` through a PR with CI green.
2. Bump `version` in `package.json` on `develop` (semver: a new message or field is a **minor**; a
   change that alters meaning should not be happening — see the compatibility rule).
3. Tag the commit `v<version>` and push the tag.
4. `publish.yml` runs on the tag: it verifies the tag matches `package.json`, then runs `buf lint`,
   the typecheck, the codegen-drift check, `buf breaking` against the previous tag, the build and
   the test suite — each as an explicit step ahead of the publish, so a red gate skips the publish.
   It then packs and publishes to `npm.pkg.github.com` with the ephemeral `GITHUB_TOKEN`.

Those steps are the gate. `prepublishOnly` is **not**: npm runs it on `npm publish` from a
directory, not on `npm pack` and not on `npm publish <tarball>`, which is the path CI takes. It is
still wired up, because a human publishing by hand from a checkout does get it.

**Releases from this repository carry no provenance attestation.** GitHub artifact attestations are
available for private repositories only on Enterprise Cloud; FigureCollecting is on the free plan
and this repo is private. The attest step is present but conditioned on the repository being
public, so provenance returns by itself if that ever changes. fc-shared attests successfully
because fc-shared is public — the shape does not transfer.

Publishing is **org-only**. On a fork the publish job is skipped, so a fork can never publish into
the `@figurecollecting` scope.
