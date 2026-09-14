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
checks. The rule above is not a convention anyone has to remember; CI enforces it against the last
released tag.

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

## Two doctrines the messages encode

**Payloads cross the wire as JSON text, never `google.protobuf.Struct`.** `CompareResponse.result_json`
and `SyncEvent.payload` are strings. `Struct` folds every JSON number to float64, which silently
corrupts a long product code or a trailing-zero price. Instants are raw ISO-8601 strings for the
same reason, never `google.protobuf.Timestamp`: PostgreSQL is the arbiter of meaning and the wire
carries the token it arbitrated. This is inherited verbatim from `read.v1`.

**The coordinator passes the spine's answer through; it does not re-derive it.**
`CompareResponse.coverage.redacted` is *lifted* out of `result_json`, not computed — same members,
same order — so a client can branch on redaction without parsing the blob. A caller lacking the
`inventory_levels` entitlement gets a **successful** response with the facet absent and named in
`coverage.redacted`. Absence is stated, never implied.

## Local development

```bash
npm ci
npm run lint        # buf lint (STANDARD, no exceptions)
npm run breaking    # buf breaking vs the last v* tag; skips cleanly when there is none
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
4. `publish.yml` runs on the tag: it verifies the tag matches `package.json`, re-checks codegen
   drift, builds, packs, attests SLSA build provenance, and publishes to `npm.pkg.github.com` with
   the ephemeral `GITHUB_TOKEN`.

Publishing is **org-only**. On a fork the publish job is skipped, so a fork can never publish into
the `@figurecollecting` scope.
