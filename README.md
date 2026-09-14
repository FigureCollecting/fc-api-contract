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

There are deliberately **no helper functions** in this package. If you want a convenience wrapper,
it belongs in `fc-shared`; putting one here would create a second place to look for the same
concept.

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
proto/coordinator/v1/sync.proto      SyncEvent + Delta / Push / Status
src/gen/                             generated TypeScript — COMMITTED, never hand-edited
src/index.ts                         the only hand-written file: a re-export barrel
tests/                               codec round-trips and the invariants the comments claim
```

`src/gen` is committed on purpose. `fc-ingest-contract` gitignores its generated output; this repo
does not, because a wire-type change should be visible in a pull-request diff, and because CI can
then prove the committed output is what the protos actually produce (`npm run generate` followed by
`git diff --exit-code`). Generated code that only exists at publish time can be neither reviewed
nor drift-checked.

**Payloads cross the wire as JSON text, never `google.protobuf.Struct`.** `CompareResponse.result_json`
and `SyncEvent.payload` are strings. `Struct` folds every JSON number to float64, which silently
corrupts a long product code or a trailing-zero price. Instants are raw ISO-8601 strings for the
same reason, never `google.protobuf.Timestamp`: PostgreSQL is the arbiter of meaning and the wire
carries the token it arbitrated. This is inherited verbatim from `read.v1`.

## The `version` token

`SyncEvent.version` is the merge token: a client applies an event when `version > local[facet_key]`.
That is a **string** comparison, so the spelling is part of the contract.

**Canonical form: UTC, a trailing `Z`, exactly six fractional digits** — `2026-09-14T11:30:00.123456Z`.

Both halves matter. An offset spelling (`+09:00`) breaks the identity between lexicographic order
and instant order outright. Variable precision breaks it more quietly: PostgreSQL renders a zero
fraction as `...:00Z`, and `.` sorts below `Z`, so `2026-09-14T11:30:00Z` sorts *greater* than
`2026-09-14T11:30:00.000000Z` — one instant, two spellings, inverted. A redelivered event in the
other spelling then re-applies, which is exactly the "replay from cursor 0 reaches the same state"
property the sync feed must have.

Treat the token as **opaque and lexicographically ordered**, not as a date. That is what leaves
room for the HLC: when the logical counter arrives it must be a fixed-width, zero-padded, sortable
**suffix** (`2026-09-14T11:30:00.123456Z#0000000007`), never a separate field. A separate field
would pass `buf breaking` — additions are additive — and still break every phone already in the
field, because they compare `version` alone and would silently lose the tie-break. buf cannot see
that; the rule in `sync.proto` is the only guard.

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
