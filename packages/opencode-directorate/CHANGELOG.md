# @rc312/opencode-directorate

## 0.1.3

### Patch Changes

- bfa02e6: Support OpenCode 2.4.2 with the host's Effect 4.1.0 runtime.

## 0.1.2

### Patch Changes

- **Upgrade note.** Earlier seal, ledger, and ship records may no longer load. Finish active reviews and ships and export any retained reviews you need with `/directorate-export` before upgrading. Start fresh reviews and ships after the upgrade.

  - Save the review seal and finding ledger together so an interrupted write cannot expose mismatched records. Review exports include only committed patches and snapshots.
  - Record subagent launches and session claims before acting on them. Restrict review tools and dispatches to recognized Directorate agents.
  - Correct changed-file status and line counts in review evidence. Surface capture, file-read, and Git history errors. Withhold binary installed dependencies and installed dependency files larger than 4 MiB.
  - Reload settings when the file changes during configuration and keep pending edits when a save fails. Report why settings reads or saves failed.
  - Reorganize the plugin around the review and ship workflows, with tests for OpenCode registrations, persisted records, and module boundaries.
