# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-09

> **⚠ BREAKING CHANGE — data loss**: 0.4 uses a new storage engine
> (IBM `rgw-standalone` base image with the native Ceph POSIX driver). Data
> written by 0.3.x or earlier is **not readable** by this version: buckets,
> objects, users and configuration from a prior installation will be lost on
> upgrade. There is no in-place migration — back up your data, undeploy the
> old release (including its data volume), and re-install/re-upload. See
> [Upgrading to 0.4](docs/operations/migration-0.4.md).

### Changed

- **Container base image**: RGW now runs from `icr.io/cpopen/ibm-ceph/rgw-standalone-rhel10:v9.9.2-27322`
  (IBM Storage Ceph 9.9.2 / Ceph Tentacle 20.2.2, UBI 10 minimal) instead of
  `quay.io/rh-aiservices-bu/radosgw-posix`. Binaries are renamed to
  `rgw-standalone` / `rgw-standalone-admin`, and the POSIX backend replaces
  the DBStore + POSIX filter combination.
- **RGW now uses the POSIX driver natively** (`rgw backend store = posix`):
  files inside the backend storage (`/var/lib/ceph/radosgw/buckets`) are
  directly readable on the volume as plain files — no RADOS layer — which
  makes inspection, backup and re-import with filesystem tools straightforward.
- **Process supervision**: the base image ships no init system (and no EPEL),
  so `docker/entrypoint.sh` now supervises RGW and Node.js itself with a
  bounded restart policy (`S4_MAX_RESTARTS`, default 3) and SIGTERM
  forwarding. `docker/supervisord.conf` was removed.
- **Node.js 22.15+ is required** (Node.js 20 is end-of-life). The builder
  stage, CI and the bundled runtime are aligned on Node.js 22.
- `@fastify/static` 9 → 10; the `setHeaders` callback now receives a
  `FastifyReply`, and the code uses `reply.header(...)`.
- Frontend build tooling: webpack 5.112, `copy-webpack-plugin` 14,
  `css-minimizer-webpack-plugin` 8, `webpack-dev-server` 6. The Monaco Editor
  import uses the package root to follow its new `exports` map.

### Removed

- **Bundled `s5cmd`** (#74): the debugging-only S3 CLI was dropped from the
  image. Clair read Go buildinfo out of the static binary and attributed ~40
  CVE findings to it (none reachable); all S3 operations use
  `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, which ship as backend
  dependencies regardless. Run S3 CLIs (mc, rclone) against the S4 endpoint
  from outside the pod — see
  [Container Architecture → S3 Debugging](docs/architecture/container.md#s3-debugging).

### Security

- Cleared all critical/high vulnerabilities from production dependency trees
  (root, backend, frontend): axios 1.21.0, fastify 5.12.7 (fast-uri,
  find-my-way), `@fastify/static` 10.1.8, lodash 4.18.1, js-yaml 4.3.2,
  form-data 4.0.6, ws 8.22.0, react-router 7.18.5, postcss 8.5.32,
  uuid 13.0.2, plus `dompurify` 3.4.17 and `qs` 6.17.1 overrides.
- Removed unused/abandoned ESLint config packages (`eslint-config-esnext`,
  `eslint-config-node`, `babel-eslint`, `eslint-plugin-node`,
  `eslint-plugin-babel`) and moved lint/test tooling out of
  `optionalDependencies`, so production installs no longer include the
  vulnerable `eslint`/`inquirer`/`tmp` chain.
- Added `.github/dependabot.yml` (npm, Docker and GitHub Actions) and a
  production-dependency audit gate in CI (`npm run audit`).
- Remaining `npm audit` findings are low-severity, dev-only advisories in
  jest/ts-jest with no valid upgrade path (npm only offers a downgrade).

### Fixed

- RGW user provisioning, S3 credentials and stored objects survive container
  restarts with the new POSIX backend (verified against the pulled base
  image).

## [0.3.2] - 2026-03-04

### Fixed

- Content Security Policy blocking resources by adding `useDefaults: false` to Helmet CSP configuration (#15)

## [0.3.1] - 2026-03-03

### Security

- Upgrade Fastify 4 to Fastify 5 to remediate CVE-2026-25223

### Changed

- Require Node.js 20 or later as the minimum supported version

### Documentation

- Update Node.js and Fastify version references across architecture and development docs

## [0.3.0] - 2026-03-03

### Added

- Bucket notification system with webhook delivery support
- Optional S3 API Route/Ingress for direct external access to the S3 endpoint

### Fixed

- HSTS header causing forced HTTPS redirects in non-TLS environments
- OpenShift liveness and readiness probes using an authenticated endpoint instead of the health endpoint

### Documentation

- Add S3 API Route and Ingress configuration documentation
- Add OpenShift quickstart deployment notes
- Fix broken documentation links

## [0.2.2] - 2026-02-10

### Added

- Internationalization (i18n) framework with multi-language support
- Language selector on the login page
- Web UI with storage browser for buckets and objects
- REST API backend with S3-compatible storage operations
- JWT-based optional authentication
- Helm chart for Kubernetes and OpenShift deployment

### Fixed

- Large file S3-to-S3 transfers failing by switching to stream-through approach
- PatternFly card layout warnings on mobile viewports
- Login error messages not using translated strings
- Folder name validation in the DestinationPicker component
- GitHub API calls proxied through backend for Content Security Policy compliance

### Documentation

- Add Helm quick start guide
- Remove cloud-specific storage class references from deployment docs

[Unreleased]: https://github.com/rh-aiservices-bu/s4/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/rh-aiservices-bu/s4/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/rh-aiservices-bu/s4/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/rh-aiservices-bu/s4/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rh-aiservices-bu/s4/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/rh-aiservices-bu/s4/releases/tag/v0.2.2
