# ux

Contents: Where defects hide (States · Actions · Accessibility · Responsiveness & devices · Command-line interfaces) · Investigate · Calibration · Not a finding · Evidence · By mode · Seams

Ask: can people, including keyboard and assistive-technology users, and the scripts that drive a CLI, complete the flow and recover when it fails?

Scope: user-facing interfaces: web and mobile UIs, CLIs, and messages and errors that people read. A user who cannot complete or recover from a supported flow is a defect in every mode; polish is a full-mode quality item.

## Where defects hide

### States

- Every async view needs loading, empty, error, partial, and success states: a spinner that never ends when the request fails; an error swallowed into an empty list; an empty state that hides the primary action.
- Stale state after navigation, refetch, or a failed mutation; optimistic updates never rolled back on error.
- State lost on error, refresh, or back navigation (a form cleared after a failed submit).

### Actions

- Double submit: buttons not disabled while pending, so a payment or create runs twice.
- Destructive actions with no confirmation or undo.
- Race between quick actions (typing ahead of a search, clicking two tabs).
- Validation only on the server with an unreadable error, or only on the client with a different rule from the server.

### Accessibility

- Interactive elements that are not reachable or operable by keyboard or assistive technology: custom controls that lack the platform's semantics (for example, on the web, a clickable `div` without a role, focusability, and key handling); keyboard traps in modals; focus not moved into or restored after dialogs.
- Missing accessible names: icon-only buttons without labels, inputs without labels, images that convey meaning without alt text.
- Status changes (errors, notifications, loading) not announced to screen readers.
- Information conveyed only by color; contrast too low for text that matters.

### Responsiveness and devices

- Layouts that hide or overlap the primary action on supported viewports; touch targets too small; hover-only interactions on touch devices.

### Command-line interfaces

- Exit codes: failure with exit 0, or success with nonzero.
- Output: data on stderr or diagnostics on stdout, breaking pipes; color or progress output when not attached to a terminal; interactive prompts that hang in CI.
- Errors that do not say what failed or what to do next; help text that disagrees with behavior.

## Investigate

1. Identify the flow and its supported users, devices, and assistive technologies (README, design docs, existing tests, or accessibility lint rules).
2. Read the component's state transitions: what renders for each request state, and what happens on failure.
3. Follow the action handlers: pending state, duplicate protection, error handling, rollback.
4. Check the elements' semantics: native elements, roles, labels, focus management. Prefer the platform's native controls over added accessibility attributes (ARIA on the web).
5. For CLIs, read the exit paths and where each message is written.

## Calibration

- **blocking:** keyboard-only users cannot complete checkout; a double click submits a payment twice; a CLI reports success after failing, so automation proceeds on bad data.
- **important:** a transient error loses everything the user entered; a loading state never ends after a failed request; a modal traps focus; an icon-only primary button has no accessible name.
- **minor:** focus jumps after a recoverable action; an unclear but correct error message.
- **not a finding:** visual or aesthetic preferences.

## Not a finding

- Subjective design critiques: spacing, color choice, copy tone.
- Demands for accessibility attributes on native controls that already provide the role and name.
- Polish beyond the accessibility standard the project targets (for example, WCAG AAA when the target is AA) where no flow is impaired.
- Devices or browsers the project does not support.

## Evidence this lens needs

The user (and their device or assistive technology), the step they cannot complete or recover from, and the code that causes it at `path:line`.

## By mode

- **default and code-quality:** blocked or unrecoverable flows, lost input, double submits, inaccessible primary actions, and misleading CLI exit codes, as defects.
- **full:** consistency with the design system, copy clarity, secondary accessibility improvements, and responsive polish, as quality items.

## Seams

- Slow responses are performance; the missing loading or timeout state is here.
- Validation that differs between client and server can also be correctness or security; record the defect where its consequence is worst.
