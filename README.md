# AgentMind

Local-first, project-scoped memory, experiences, learning signals and immutable Agent Skills shared by Codex CLI, Claude Code and Gemini CLI through a TypeScript/Node.js core and SQLite/FTS5.

**Release candidate preparation only. No V1 release is approved.** Offline service/adapter tests are distinct from actual native model use. Protected OS separation and behavioral sandbox isolation remain **NOT VERIFIED**. Autonomous approval/promotion is disabled. Advisory review, static validation, behavioral verification, approval, activation and distribution are different operations.

The primary installation is a **source workspace**, not a published npm package. Node.js 22.13+ and pnpm 11.6.0 are declared; macOS arm64 with Node 22.13.1 is the tested development environment. Other Node/OS combinations require separate verification. Dependencies may need network access and a native build toolchain.

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/mcp-server/dist/agentmind.js --help
```

Before enrollment, follow the [quick start](docs/v1/QUICK_START.md). Setup defaults to project scope and read-only planning; explicit `--apply` is required to change managed integration files. Status and ordinary doctor do not invoke coding models. Uninstall retains the registry, memories and backups.

- [Installation, provider differences and platform/profile matrix](docs/v1/INSTALLATION.md)
- [Upgrade, WAL-aware backup, migration and recovery](docs/v1/UPGRADE.md)
- [CLI/MCP contracts and daily workflows](docs/v1/REFERENCE.md)
- [Security, privacy and retention](docs/v1/SECURITY.md)
- [Troubleshooting and removal](docs/v1/TROUBLESHOOTING.md)
- [Maintainer build, packaging and evidence](docs/v1/MAINTAINERS.md)
- [Security reporting policy](SECURITY.md)
- [V1 contract freeze candidate](contracts/README.md)

Use the same explicit canonical project and database for all three integrations. Startup-selected scope is enforced by shared services; a caller-supplied project ID is not authorization. Local storage is not automatically private: same-UID processes may bypass application controls. Never point disposable tests at live user data.

No license grant or public distribution authorization is currently present. Local source candidate artifacts do not grant publishing rights or establish clean-machine acceptance. P6-004 must verify the candidate on clean machines; protected/native/behavioral profiles require their own evidence.

Release preparation: [unreleased V1.0.0 notes](docs/v1/RELEASE_NOTES_1_0_0.md), [changelog](CHANGELOG.md), and [controlled publication proposal](docs/v1/PUBLICATION.md). Current package metadata remains 0.0.1; all publication profiles remain NO-GO. These documents do not authorize publication.
