# Contributing

Bug reports, docs fixes and patches are all welcome. This file is about the
handful of conventions that are not obvious from reading the code.

Found a security issue? Do not open an issue — see [SECURITY.md](SECURITY.md).

## Getting set up

```bash
git clone https://github.com/SwapzyCC/ltc-replay.git
cd ltc-replay
npm ci
npm run check    # lint + typecheck + test
```

That is the whole setup. **The test suite needs no Litecoin node, no network
and no database file** — every test builds its own in-memory journal and feeds
it fixtures. If a change makes the suite need a live node, the change is wrong;
put the node-dependent part behind an interface and fake it, the way
`test/api.test.ts` fakes `LitecoinRpc`.

Node 22 or newer. `better-sqlite3` and `zeromq` are native, so a first install
may compile them — that is normal and only happens once.

To run it for real you need a node; `.env.example` and
[docs/deployment.md](docs/deployment.md) cover that, and
[docs/pruned-nodes.md](docs/pruned-nodes.md) is worth five minutes before you
configure Core.

## Before you push

```bash
npm run check
npm run format
```

CI runs the same thing on Node 22 and 24, plus a Docker build. A PR that
fails `npm run check` locally will fail there too.

Lint is [oxlint](https://oxc.rs), not ESLint — typescript-eslint has no peer
support for TypeScript 7 yet, and oxlint runs a comparable rule set in a
fraction of the time.

## What a good change looks like

**Money correctness needs a failing test first.** Anything touching the
journal, the tap, catch-up or reorg handling: write the test that fails, then
the fix. "It works on my node" is not reviewable, and the whole point of this
service is that its failures are silent.

**Absence stays distinguishable from nothing-happened.** Every lookup reports
the range it can speak for. A change that returns an empty result without a
coverage range turns "I have no record" into "it did not happen", and a
consumer downstream drops a deposit. This is the single most important
invariant in the codebase.

**No silent fallbacks on a security path.** `tls://` does not degrade to
`tcp://`. A missing credential fails the boot rather than connecting
anonymously. A malformed endpoint throws with the variable's name and without
its password. If you find yourself writing `catch {}` around one of these,
that is the bug.

**Credentials never reach a string that might be logged.** There are tests that
assert this by searching every error message for the fixture password — see
`test/rpc-uri.test.ts`. Keep them passing; they exist because this failure is
invisible until it is in someone's log aggregator.

**SQL lives in `.sql` files.** Named statements in
`src/journal/sql/queries.sql` are validated against the code in both directions
at boot: a statement with no caller, or a caller with no statement, is a
startup failure rather than a route that throws in production three weeks
later. If you add a query, add it there.

**Behaviour changes update the docs.** `docs/` is not an afterthought — it is
how anyone deploying this avoids losing money. The table in
[docs/README.md](docs/README.md) says which file covers what.

## Code style

Prettier and oxlint settle formatting; do not argue with them.

Beyond that, match what is there. The codebase is written to be read by someone
debugging a missed deposit at an unpleasant hour:

- Comments explain **why**, not what. If a line needs a comment to say what it
  does, rename something instead.
- Error messages name the setting or input that caused them, and never their
  value if that value could be a secret.
- One route per file under `src/http/routes/`; boot order lives in `src/app.ts`.
- `strict` TypeScript with no `any` escape hatches. If the types are fighting
  you, the model is probably wrong.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org) —
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with an optional
scope like `feat(zmq):`. Look at `git log` for the house style: the subject
says what changed, and the body says why it needed to.

One logical change per commit. A refactor and a behaviour change in the same
commit cannot be reviewed, and cannot be reverted separately when the behaviour
change turns out to be wrong.

Pull requests go against `main`. Say what breaks if the change is wrong — that
sentence is usually more useful to a reviewer than the diff.

## Licence

Contributions are accepted under the [BSD 3-Clause Licence](LICENSE). There is
no CLA; opening a pull request means you are fine with your work being
distributed under those terms.
