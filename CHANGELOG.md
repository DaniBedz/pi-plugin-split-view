# Changelog

Notable changes to `pi-split-view`. Versioning is [SemVer](https://semver.org/).

## [1.1.0] — 2026-10-16

### Added

- `/split-diff` — toggle the files dock's edit-diff subpanel independently, keeping just
  the touched-files list.
- A dim dashed rule between **successive assistant answers** in response-only mode
  (`/split-trim-response`). It never appears around user messages, and can be switched
  back to plain blank-line spacing with `/split-divider space` or the `answerDivider`
  config key (`"rule"` | `"space"`, default `"rule"`).
- `tsconfig.json` and `npm run typecheck` (`tsc --noEmit`).

### Changed

- `peerDependencies` floored to `>=1.2.0` (was `*`) so API drift is visible.
- Files-dock width computation deduplicated onto one helper.

### Fixed

- `/split-save` now uses a valid notification severity (previously an unsupported
  `"success"`, which pi silently downgraded to a neutral status).
- The `setWidget` factory returns a conformant `Component` (`invalidate()`) and uses the
  theme passed by pi instead of reading a non-existent `tui.theme`.
- The `tool_result` edit-path value is guarded to a string (`{}` → `string` type error).

## [1.0.x] and earlier

See the git history for releases before 1.1.0.
