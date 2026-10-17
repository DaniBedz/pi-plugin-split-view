# Changelog

Notable changes to `pi-split-view`. Versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Double-click a line in the Edits panel (inside herdr, fullscreen mode) to open the file
  at that line in neovim, in a reused herdr tab of the current workspace (`herdr-nvim.ts`).

### Changed

- `/split-diff` now toggles a standalone **Edits panel** in the right dock, independent of
  the files list: a scrollable history of the last 10 edit diffs (newest at the bottom).
  Its saved default follows `files` when `diff` is absent from `ui-panels.json`.
- The status bar below the editor (`📂 N file · file …`) is gone.
- The conversation below the thinking/tools band is now fully framed (side edges and a
  bottom border), not just a top rule with corners. The editor stays outside the frame.
- Status rows padded to centre on the full terminal (e.g. a custom working-indicator
  spinner) are re-centred on the space left of the right dock.
- Thinking entries no longer carry leading/trailing/repeated blank lines.

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
