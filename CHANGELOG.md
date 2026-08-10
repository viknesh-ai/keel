# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches a first release.

## [Unreleased]

### Added

- Architecture, security and roadmap documentation.
- Monorepo scaffold: pnpm workspaces, Turborepo, Biome, TypeScript strict, Vitest, Changesets.
- CI running lint, typecheck, dependency-boundary checks, unit tests and build, plus a job that
  verifies the boundary rule actually fires on a violating import.
- Local infrastructure stack: PostgreSQL with pgvector, Redis, MinIO.
- Empty workspace packages and services with no implementation.

### Not yet implemented

Everything else. See `docs/build/session-prompts.md`.
