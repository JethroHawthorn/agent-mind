# AgentMind

AgentMind gives OpenAI Codex CLI, Anthropic Claude Code and Google Gemini CLI persistent project memory and reusable Agent Skills. Keep useful decisions and solutions across sessions, with local storage and human-supervised skill approval.

Install the **unpublished local candidate** from a supplied, reviewed tarball:

```sh
npm install --global ./agentmind-1.0.0.tgz
cd my-project
agentmind setup --cli all --dry-run
agentmind setup --cli all --apply
agentmind doctor
```

Requires Node.js 22.13 or later and at least one supported coding-agent CLI. No pnpm is needed to use the installed package. See [installation](docs/v1/INSTALLATION.md) for the tested artifact workflow and platform limits. No public npm release is provided or approved yet.

## Why AgentMind?

Coding agents lose context between sessions, so useful solutions get rediscovered. AgentMind preserves project knowledge for later sessions and other authorized agents working on that project. Reviewed, approved skills can turn repeated solutions into reusable guidance.

## Features

- Persistent project memory and experience capture.
- Continuous-learning proposals and a review queue.
- Skill discovery and retrieval.
- Human-supervised skill approval.
- Codex, Claude and Gemini integration.
- Local-first SQLite storage.

## Installation

The package name in this repository is `agentmind`, version `1.0.0`. Registry installation is reserved for a future approved publication; package-name availability and registry ownership are not established here. Use the tested local tarball command above with the artifact supplied to you.

For a disposable installation that leaves your normal global prefix alone:

```sh
npm install --global --prefix /tmp/agentmind-prefix ./agentmind-1.0.0.tgz
/tmp/agentmind-prefix/bin/agentmind --help
/tmp/agentmind-prefix/bin/agentmind --version
```

The SQLite dependency may download a native binary or need Python and a C/C++ build toolchain. macOS arm64 with Node 22.13.1 has local artifact evidence; other platforms and Node versions need verification. Windows is not an officially verified target. Direct GitHub installation is not supported; use a prepared tarball.

## Quick Start

Run these commands inside the project you want to connect:

```sh
cd my-project
agentmind setup --cli all --dry-run
agentmind setup --cli all --apply
agentmind doctor
```

`--dry-run` previews managed configuration and router changes. `--apply` authorizes those changes. Setup targets detected installed CLIs and defaults to project scope. Restart your coding agent after setup. You do not need to edit MCP configuration by hand.

Ordinary doctor does not start MCP or invoke a model. It may exit with code 2 to report incomplete verification. Setup does not create a database; the first MCP startup initializes local storage. Read the [upgrade guide](docs/v1/UPGRADE.md) before starting a newer binary on an existing registry.

## How It Works

1. An agent stores useful project knowledge through AgentMind tools.
2. AgentMind saves it locally, normally under `~/.agentmind`.
3. Other authorized agents connected to the same project can retrieve it.
4. Reusable experiences can become skill proposals.
5. Approved and activated skills can be retrieved for later work.

Creating a proposal does not approve or activate it. Agent-facing tools and advisory review commands cannot grant trusted operator approval.

## Common Commands

Run knowledge commands after MCP has initialized the registry.

| Task | Command |
| --- | --- |
| Preview setup | `agentmind setup --cli all --dry-run` |
| Apply setup | `agentmind setup --cli all --apply` |
| Check configuration | `agentmind status` |
| Diagnose integration | `agentmind doctor` |
| Find memories | `agentmind memory search "sqlite"` |
| Find experiences | `agentmind experience search "sqlite"` |
| Find skills | `agentmind skills search "sqlite"` |
| List skills | `agentmind skills list` |
| View learning inbox | `agentmind learning inbox` |
| View review queue | `agentmind review list` |
| Remove managed integrations | `agentmind uninstall --cli all --dry-run`, then `agentmind uninstall --cli all --apply` |

Use `agentmind --help` for all command groups, including database maintenance, evaluation and distribution. Shared router dependencies can require uninstalling Gemini before Codex; follow the generated plan.

## Safety and Privacy

Data stays local by default. Access is scoped to the configured project; local storage does not imply encryption or protection from other processes running as your user. Do not store secrets in memories or skill content.

Setup preserves user-owned settings and requires explicit consent for noninteractive changes. It does not log in, call models, or approve or promote skills automatically. Advanced protected capabilities require independently verified deployment. Protected OS separation and executable behavioral sandbox isolation remain **NOT VERIFIED**.

Uninstall retains your registry, memories, experiences and backups. Read [security and privacy](docs/v1/SECURITY.md) for the trust boundaries.

## Documentation

- [Installation and provider differences](docs/v1/INSTALLATION.md)
- [Detailed quick start](docs/v1/QUICK_START.md)
- [Commands, MCP tools and workflows](docs/v1/REFERENCE.md)
- [Database backup, upgrade and migration](docs/v1/UPGRADE.md)
- [Troubleshooting and removal](docs/v1/TROUBLESHOOTING.md)
- [Architecture and maintainer guidance](docs/v1/MAINTAINERS.md)
- [Security reporting](SECURITY.md)

## Development

Contributors need pnpm 11.6.0 and the declared Node.js runtime:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
```

[Maintainer instructions](docs/v1/MAINTAINERS.md) cover local npm packaging and isolated installation tests. Publication, native model acceptance and clean-machine certification remain separate release gates.

## License

No license grant is present. Package metadata declares `UNLICENSED`; public distribution requires an owner-approved license and release authorization.
