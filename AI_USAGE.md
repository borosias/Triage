# AI Usage

## Where I used AI

I used AI extensively, including for substantial code generation. The workflow was
not `prompt -> accept implementation`: for the correctness-heavy requirements I
first used AI to explore alternatives, races, failure windows, framework/runtime
constraints, and verification strategies. I then reduced the requirement to
explicit invariants, chose the design, and only then used AI to implement larger
multi-file changes.

In practice, I used AI for architecture exploration, code generation, focused
verifiers, diff review, PostgreSQL/Prisma/Next.js/React/Supabase checks, regression
analysis, and documentation review. I treated generated code as an implementation
candidate, not as a correctness argument.

R1 is representative. I rejected the naive `SELECT -> inspect -> UPDATE` shape
before implementation because two requests can both observe `claimedById = NULL`
before either write occurs. The chosen transition is one conditional PostgreSQL
`UPDATE ... RETURNING`:
[claim CAS implementation](https://github.com/borosias/Triage/blob/baa1fd2/app/api/workspaces/%5BworkspaceId%5D/items/%5BitemId%5D/claim/route.ts#L45-L74).

The reason is not merely that "PostgreSQL is atomic". Under PostgreSQL's normal
`READ COMMITTED` behavior, concurrent updates of the same tuple do not both commit
against the same row version. One updater acquires the row write lock; a competing
updater waits, then its conditional `UPDATE` is evaluated against the current row
state. Once the first claim has changed the tuple, the second claim predicate no
longer matches and `RETURNING` yields no winner row. The important property is that
availability testing and the state transition are one database statement, with no
application-visible read/write gap.

I used TDD selectively where it bought evidence rather than as blanket coverage.
For R5, for example, the verifier existed before production behavior; I did not
count sandbox/process failures as RED. The useful RED was an authorized GET still
returning a 31-minute-old claim when the test expected physical expiration.

I also used AI as an adversarial reviewer after feature completion. A final
read-only repository audit found two concrete issues rather than stylistic
preferences: repeat seeding did not include `NotificationDelivery` in the reset,
and `Load more` could remain stuck if an Item mutation invalidated its generation
mid-request. I inspected both findings, fixed them, and reran the relevant
lint/type/build/R4/R5/diff checks before finalizing these documents.

## Disagreement 1: dispatch must not depend on the browser

An early AI proposal for R3 was to commit a durable `NotificationDelivery`, return
from Resolve, and let the browser trigger dispatch. It looked like the smallest
`best-effort-with-a-record` design.

I rejected it because persistence and execution initiation are different
guarantees. After:

```text
Item = RESOLVED
NotificationDelivery = PENDING
COMMIT
```

a client-triggered design still needs a second independent event:

```text
browser receives 200
        ↓
browser sends dispatch request
```

That second event is not guaranteed to happen. A Resolve made through `curl` has
no browser follow-up; a browser can also close, crash, lose connectivity, or fail
in JavaScript immediately after the successful response. The durable row proves
the work exists, but it can remain `PENDING` forever without an attempt ever being
initiated.

I instead made the trigger originate from committed server-side state. Resolve
writes the Item transition and `NotificationDelivery` in one transaction:
[resolve + delivery transaction](https://github.com/borosias/Triage/blob/3216675/app/api/workspaces/%5BworkspaceId%5D/items/%5BitemId%5D/resolve/route.ts#L50-L96).
A configured Supabase Database Webhook calls the Vercel worker, whose acquisition
is a conditional `PENDING -> PROCESSING` transition:
[delivery acquisition/state transitions](https://github.com/borosias/Triage/blob/3216675/lib/notification-delivery-store.ts#L10-L64).

This does **not** turn R3 into reliable messaging. The guarantee remains
**best-effort-with-a-record**: a lost/misconfigured webhook can leave `PENDING`;
a worker failure after acquisition can leave `PROCESSING`; a completed side effect
followed by a failed terminal write is ambiguous; `FAILED` is terminal; there are
no retries; exactly-once delivery is not claimed.

## Disagreement 2: the UI must not hide a pagination invariant failure

During R4, AI suggested deduplicating appended pages by `item.id` as defensive
client behavior. I deliberately rejected it.

R4 requires the traversal itself not to repeat or skip rows. If a broken backend
returns:

```text
page 1: A ... X
page 2: X ... Z
```

client dedupe can render `A ... X ... Z` and make the UI look correct while the
server-side pagination invariant is broken. It is also asymmetric: the client can
hide a duplicate, but it cannot reconstruct a row the backend skipped.

I therefore kept continuation appending literal:
[R4 client append](https://github.com/borosias/Triage/blob/da130a7/app/workspace-queue.tsx#L200-L232),
and made the verifier responsible for proving traversal correctness rather than
masking a backend defect.

The backend uses composite keyset order `(createdAt DESC, id DESC)`, with `id` as
the unique tie-breaker. I also kept the cursor boundary at PostgreSQL
`TIMESTAMPTZ(6)` precision instead of passing it through JavaScript `Date`, because
millisecond rounding can collapse distinct microsecond boundaries into a
skip/repeat bug. Full traversal verifies ordering and duplicates, including a
same-millisecond/microsecond boundary.

## How I verified AI output

Compilation was never the acceptance criterion. I used focused executable
verifiers against PostgreSQL:

```text
npm run session:verify
npm run r2:verify
npm run r1:verify
npm run release:verify
npm run r3:verify
npm run r4:verify
npm run r5:verify
npm run r4:explain
```

Specific checks included:

- **R1:** concurrent Alice/Bob claims via `Promise.all`; exactly one `200`, one
  `409`, the loser sees the winner, and a direct PostgreSQL read matches that
  winner.
- **R2:** owner/member/viewer/outsider cases plus adversarial workspace/Item ID
  substitution. I also repeated the Alpha-Item-through-Beta-route case on the
  deployed app and received `404`.
- **R3:** atomic Item + delivery outcome, worker secret/payload validation,
  single `PENDING -> PROCESSING` acquisition, `SENT | FAILED`, and duplicate
  no-op behavior. The deployed Supabase webhook path was tested separately and
  produced real `SENT` and expected random `FAILED` rows.
- **R4:** bounded full traversal, exact composite ordering, repeated-ID failure,
  cursor/workspace validation, deleted boundary behavior, claimant changes,
  non-snapshot behavior, and microsecond precision. `EXPLAIN ANALYZE` compared a
  deep OFFSET query with the production-shaped keyset query; the useful evidence
  is the difference in rows/buffers touched, not absolute timing.
- **R5:** RED → GREEN coverage for 31-minute cleanup, 29-minute freshness, late
  Resolve returning `409` with no delivery, concurrent reclaim with one winner,
  and authorization isolation.

The completed feature tree also passed Prisma validation/generation, ESLint,
TypeScript checking, a Next.js production build, and `git diff --check`. After the
final audit fixes, I reran `lint`, `typecheck`, `build`, `r4:verify`,
`r5:verify`, and `git diff --check`, matching the scope of those fixes.

The rule I used throughout was:

> AI could generate the implementation, but the acceptance condition had to come
> from the requirement, the failure model, and an independently checkable
> invariant.
