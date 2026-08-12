# `@psftw/pets`

Minimalist configuration management for "pet" Debian Linux servers. Declare
intent with primitives, group primitives into a `role`, then `check`/`apply`
across a fleet.

🤖 experimental 🤖

> This was built to learn about swamp extensions, don't use it!

Every model takes a `fleet` (`@swamp/ssh` model instance), and a `hosts`
selector (`all`, `name:X`, `tag:Y`). Convergence logic streams to each host's
`python3` over SSH stdin; nothing is installed on the targets. `check` is
read-only; `apply` converges with sudo. Statuses: `compliant`, `non_compliant`,
`applied` (real changes made), `failed`.

## Quickstart by example: PostgreSQL from PGDG repositories

Define a fleet:

```bash
swamp extension pull @swamp/ssh
swamp model create @swamp/ssh my-fleet
swamp model edit my-fleet
```

```yaml
transport:
  kind: ssh
  user: debian
  identityFile: ~/.ssh/id_ed25519
hosts:
  - name: build
    address: build.example.com
    tags: [build]
```

Declare our APT repository (see: [PGDG](https://wiki.postgresql.org/wiki/Apt)):

```bash
swamp model create @psftw/pets/apt-repository pgdg-repo
swamp model edit pgdg-repo
```

```yaml
fleet: my-fleet
name: pgdg-repo
uris: [https://apt.postgresql.org/pub/repos/apt]
suites: [trixie-pgdg]
components: [main]
gpgKeyUrl: https://www.postgresql.org/media/keys/ACCC4CF8.asc
signedBy: /etc/apt/keyrings/pgdg.asc
```

Declare our package install:

```bash
swamp model create @psftw/pets/apt postgres-package
swamp model edit postgres-package
```

```yaml
fleet: my-fleet
packages:
  - postgresql-18
```

Sequence these into a `role`:

```bash
swamp model create @psftw/pets/role postgres-role
swamp model edit postgres-role
```

```yaml
fleet: my-fleet
members:
  - pgdg-repo
  - postgres-package
```

Apply the `role` to our server:

```bash
swamp model method run postgres-role apply --input hosts=all
[INF] @psftw/pets/role·apply: [1/2] pgdg-repo: apply on all
[INF] @psftw/pets/apt-repository·apply: running on all via my-fleet (sudo)
[INF] @psftw/pets/apt-repository·apply: build: applied — write /etc/apt/sources.list.d/pgdg-repo.sources; fetch key to /etc/apt/keyrings/pgdg.asc
[INF] @psftw/pets/role·apply: [1/2] pgdg-repo: applied=1
[INF] @psftw/pets/role·apply: [2/2] postgres-package: apply on all
[INF] @psftw/pets/apt·apply: running on all via my-fleet (sudo)
[INF] @psftw/pets/apt·apply: build: applied — install postgresql-18
[INF] @psftw/pets/role·apply: [2/2] postgres-package: applied=1
[INF] @psftw/pets/role·apply: build: applied — pgdg-repo: write /etc/apt/sources.list.d/pgdg-repo.sources; pgdg-repo: fetch key to /etc/apt/keyrings/pgdg.asc; postgres-package: install postgresql-18
[INF] @psftw/pets/role·apply: summary[all]: applied
```

View the compliance report:

```bash
swamp report get @psftw/pets/fleet-compliance --model postgres-role
```

> Fleet compliance — postgres-role · apply (succeeded)

**Aggregate:** `applied` across 1 host(s) — selector `all` —
2026-08-11T00:00:00.000Z

| Host  | Status    | Changes |
| ----- | --------- | ------- |
| build | `applied` | 3       |

Members

| Host  | Member           | Status    |
| ----- | ---------------- | --------- |
| build | pgdg-repo        | `applied` |
| build | postgres-package | `applied` |

Changes

- build: pgdg-repo: write /etc/apt/sources.list.d/pgdg-repo.sources
- build: pgdg-repo: fetch key to /etc/apt/keyrings/pgdg.asc
- build: postgres-package: install postgresql-18

## How it works

- **Transport.** All remote execution flows through the configured fleet's
  `resolve`, `script`, and `exec` methods.
- **Payload delivery.** Fact-gathering and convergence logic is written once in
  Python (`payloads/*.py`), embedded at build time into generated TypeScript
  modules (`extensions/models/_payloads/*.ts`), and streamed to each host's
  `python3` over SSH stdin. Using TypeScript everywhere would be a better
  choice, but I wanted to see how I could force business logic into Python, then
  wrap it in TypeScript, with safeguards going both ways.
- **Roll-ups built for automation.** `role` writes a per-host `state` resource
  plus a selector-keyed `summary` resource with a stable name (e.g.
  `tag:build`), so CEL consumers have one address per role:
  `data.latest("build", "tag:build").attributes.status`.
- **Nested runModel.** We can call between models within the extension, as well
  as out to `@swamp/ssh`.

### Fleet protocol

`fleet:` names any model implementing this contract — `@swamp/ssh` is the
reference implementation (pets is tested against 2026.07.28.1):

| Method    | Arguments                                              | Result resources                                                       |
| --------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `resolve` | `hosts` selector                                       | one `selection` resource: `attributes.hosts: [{name, address, tags}]`  |
| `script`  | `hosts`, `script`, `interpreter`, `sudo`, `timeoutSec` | one `runResult` resource per host: `attributes: {host, stdout}`        |
| `exec`    | `hosts`, `command`                                     | consumed for success/failure only; non-zero remote exit ⇒ method error |

A selector matching zero hosts is an error for `script`/`exec` (only `resolve`
tolerates it). Conforming transports should record a `runResult` resource per
host per invocation — that per-trip record is the audit trail consumers rely on.
pets asserts these shapes at runtime and names the offending model when a
transport doesn't conform.

## Development

```sh
deno task preflight
```

`payloads/*.py` are the source of truth for payload logic;
`extensions/models/_lib/cfg.ts` is the source of truth for the cfg wire
contract. `deno task gen` derives both generated layers: the `GENERATED TYPES`
TypedDict block inside each payload, and `extensions/models/_payloads/*.ts` —
one human-diffable module per payload. Generated output is committed; `fmt` and
`lint` exclude `_payloads/` since its content must stay byte-stable with the
payload it came from. `pyScript` validates every cfg against its schema before
it leaves the model, and `typecheck:py` holds the Python side to the same
contract.

`deno task gen:docs` rebuilds the `manifest.yaml` description from this README —
everything above `## How it works` — which lands on the
[extension page](https://swamp-club.com/extensions/@psftw/pets).

`deno task preflight` regenerates the description, runs every local check, plus
the registry-side ones (manifest format, quality score, push dry-run with the
adversarial-review gate) and prints one pass/fail summary. Pass a channel for
prerelease validation: `deno task preflight --channel beta`.

## License

MIT — see [LICENSE.md](./LICENSE.md) for details.
