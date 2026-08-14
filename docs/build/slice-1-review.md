# Slice 1 — honest review

Written at the end of session 1.11, as the session prompt asks: a list of what is
weak, not diplomatic.

The instruction was "don't be diplomatic about it", so this leads with the
things that would embarrass us in a review, not the things that went well.

---

## 1. The slice's headline claim is not yet true end to end

ROADMAP §6 says Slice 1 exits when *"Show me customers who haven't logged in for
30 days" works in the demo app, and the trace screen explains exactly how.*

**It does not work end to end.** Every component exists and is tested in
isolation, and the seams between them are not wired:

| Seam | State |
|---|---|
| `/rt/v1` runs → agent runtime | **Not wired.** The run driver emits a scripted AG-UI sequence. |
| Agent runtime `ModelPort` → `@keel/model-providers` | **Not wired.** Tests use in-memory fakes. |
| Agent runtime `PolicyPort` → `@keel/policy-engine` | **Not wired.** Tests use a fake returning a fixed decision. |
| Agent runtime `ToolPort` → generated OpenAPI contracts | **Not wired.** No adapter dispatches to Northwind's API. |
| Agent runtime `StepLogPort` → `runsRepo` | **Not wired.** Tests use an in-memory log. |
| Run-detail screen → real `run_steps` | **Not wired.** The view renders from props; nothing fetches. |

This is the single most important thing in this document. Each part is real, but
"a set of correct parts" is not a vertical slice, and I would not claim
otherwise in a demo.

## 2. No Playwright E2E

The session asked for one: log into demo-saas, open the widget, ask the
question, assert the tool was called with the right arguments, assert the trace
screen shows the policy decision. **It does not exist.** It cannot meaningfully
exist until §1 is resolved — an E2E over a scripted driver would assert that the
script runs, which is worse than no test because it would look like coverage.

The denial test *does* exist and is real (`tests/integration/slice-1-denial.test.ts`),
runs against the committed artifacts, and was mutation-tested.

## 3. The agent runtime has never executed against a real model

`packages/agent-runtime` is tested entirely with in-memory fakes, which was the
session's own exit criterion. But that means the read path has never seen a real
model's output: no malformed tool arguments, no model that ignores the schema,
no truncated stream. The first contact with reality will find bugs the fakes
cannot.

## 4. Verification is nominal

`Verifying` returns `{ complete: true }` unconditionally. Doc 01 §4.2 wants
post-condition checks — read back after a mutation and confirm — which is
deferred with the write path, and that is fine. What is not fine is that the
state exists and does nothing, which reads as implemented at a glance.

## 5. Recovery does not exist

`Recovering` is declared and unreachable. A failed observation goes straight to
`Failed`. The error taxonomy has a full retry model (`shouldRetryToolCall`) with
nothing calling it. The runtime and the taxonomy currently disagree about
whether retries exist.

## 6. The in-process run registry will not survive a second process

`services/api/src/modules/realtime/registry.ts` holds live runs in a `Map`. Two
API instances behind a load balancer means a cancel hitting instance B cannot
stop a run on instance A — it will 404 and the run continues. This is stated in
the file's own comment, and it is a correctness bug the moment anyone scales
past one process. It needs Redis before any deployment that is not a laptop.

## 7. Sessions are in-memory too

`/rt/v1/sessions` stores sessions in a `Map`. Restarting the API logs everyone
out, and the identity verification built in session 1.7 is **not actually wired
into the endpoint** — it accepts any string as an identity token and only checks
whether one is present. The verification code is correct and well tested; the
endpoint does not call it. That gap is security-relevant and should be closed
before anything else in slice 2.

## 8. Bound parameters are generated but never applied

The OpenAPI importer emits `bind:` entries correctly. Nothing reads them. When
the tool adapter lands it must apply them, and until then the design property
they exist for — the model cannot supply a tenant id — is only true because no
tool executes at all.

## 9. `@keel/ui` primitives are thinner than the doc

Doc 05 §E3 lists ~33 primitives. Seventeen exist. Missing and needed soon:
`Table` (virtualised), `JSONViewer`, `DiffViewer`, `Timeline`, `CommandPalette`,
`Drawer`, `Combobox`. The run-detail screen uses `CodeBlock` where it wants
`JSONViewer`, and the step timeline is a plain `<ol>` where doc 05 §E5 asks for
virtualisation — fine at 11 steps, wrong at 10,000.

## 10. Test-shaped gaps I know about

- The dashboard has no test that mounts the real router with the run-detail
  route; `RunDetailView` is tested directly.
- The widget is tested outside its Shadow root, because jsdom does not carry
  ARIA across the boundary. So the a11y guarantees are proven for the markup,
  not for the mounted widget.
- `@keel/react`'s provider is not tested against a live SSE stream; the
  transport is tested in `@keel/client` and the provider's event reducer is not.
- No load test, no benchmark, no p50/p95 numbers. ROADMAP promises them in
  slice 8, so this is on schedule, but nothing about performance is known.

## 11. Documentation debt

Thirteen of twenty ADRs are unwritten (001–004, 007–015 minus 005/006). ROADMAP
§6 lists "ADRs 001–015 written" as a Slice 0 exit item, so this has been
outstanding for five sessions.

---

## What is genuinely solid

Stated briefly, because the list above is the point of the document.

- **RLS is real and proven.** Forced on every tenant table, tested with a
  non-superuser role over its own connection, and mutation-tested — weakening
  one policy to `USING (true)` fails six tests in CI.
- **The policy engine is total and default-deny**, with I1/I2 unoverridable by
  any document rule, verified by property tests over generated policies.
- **The identity attack corpus is thorough** and found a real
  misclassification bug in my own code.
- **Determinism where it was promised**: OpenAPI import is byte-stable, the
  agent runtime replays exactly, the seed is fixed.
- **CI asserts its own guards fire.** Five separate jobs deliberately break
  something and assert the check catches it. That pattern is worth keeping.

## What I would do next, in order

1. Wire identity verification into `/rt/v1/sessions` (§7). Security-relevant and
   small.
2. Move the run registry and sessions to Redis (§6, §7).
3. Wire the runtime's ports to the real implementations (§1), then write the
   Playwright E2E that becomes meaningful once they are.
4. Then slice 2.

Doing slice 2 before §1 would mean building approvals on top of a runtime that
has never run.
