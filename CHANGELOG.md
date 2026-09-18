# Changelog

All notable changes to Torn Company Training Manager are documented here.

## [1.2.5] - 2026-09-18

### Distribution

- Moved public install/update authority to https://voidsmithindustries.com/torn/install/company-training-manager.user.js.
- Support metadata now points to the Voidsmith Torn support page instead of a GitHub install-time destination.
- Runtime training behavior is unchanged from v1.2.4.

## [1.2.4] - 2026-09-12

### Changed

- Retired the legacy large floating **Company Training** global badge that appeared on Forums, City, Items, Gym and other non-company Torn pages.
- The compact premium Voidsmith launcher/dock remains the persistent entry point. Outside Job / Company it navigates to the company manager; inside Job / Company it continues to open/minimize the full Training Manager.
- Removed the obsolete **Show global launcher outside Company** and **Show available train count on launcher** settings because they belonged only to the retired panel.
- Legacy saved global-badge position/collapse data is no longer read by the active UI, so old coordinates cannot resurrect or reposition the retired panel.

### Verification status

- Added regression coverage proving non-company Torn pages never mount the retired global badge, regardless of legacy saved visibility settings.
- Added settings coverage proving the retired controls are no longer exposed.
- Existing compact launcher, Job / Company manager, training transaction and safety behavior remain covered by the automated suite.

## [1.2.3] - 2026-09-12

### Changed

- Train actions can now be initiated from any Torn Job / Company tab without manually opening Employees first.
- If the selected employee row is not already rendered, the manager clicks Torn's native **Employees** tab and waits for the exact selected employee row before the training transaction begins.
- The director remains on the Employees tab after the action instead of being automatically bounced back to the previous company view.

### Safety

- Employee-tab preparation happens before the fresh training preflight and before any persistent training receipt is reserved.
- If Torn fails to render the exact selected employee row within the preparation timeout, the action fails closed and no training POST is attempted.
- Existing exact-employee targeting, fresh preflight checks, duplicate protection, accepted-versus-verified state, and Company News verification remain unchanged.

### Verification status

- Added regression coverage proving a Train action from another Job / Company tab opens Employees before the controller training call starts.
- Full automated build/test verification is required before merge to `main`; live Torn interaction remains covered by the manual verification checklist.

## [1.2.2] - 2026-09-12

### Fixed

- Fixed training writes being blocked on Torn's current hash-style Job / Company routes such as `companies.php#/option=employees`. The manager UI and the write guard now use the same strict Torn `/companies.php` route policy while retaining support for the older `?step=your` form.
- Fixed a pre-submit safety refusal being misclassified as `submission_unknown`. Failures that are proven to happen before the POST boundary now clear the reserved training receipt and surface as a normal failed/blocked action instead of creating a false verification lock.
- Added targeted recovery for the legacy v1.2.1 fake verification lock whose exact persisted error is `not_company_management_page`. That marker proves the old write guard rejected the operation before any Torn POST was sent, so it is safely cleared during initialization.
- Preserved fail-closed behavior for genuinely ambiguous post-boundary failures such as network errors, invalid/unrecognized responses, or HTTP failures where Torn may have processed the request.

### Verification status

- Added regression coverage for a real current hash-only Company Employees route crossing the exact training POST boundary.
- Added regression coverage proving pre-submit `unsafe_dom` failures do not leave duplicate-blocking receipts.
- Added regression coverage proving only the exact legacy v1.2.1 fake route lock is auto-cleared; other unresolved submission receipts remain protected by the existing verification model.

## [1.2.1] - 2026-09-12

### Changed

- Rebuilt the Training Manager shell around a premium Voidsmith Industries graphite, black and restrained red design system, with layered surfaces, stronger edge treatment, inset highlights and clearer visual hierarchy inspired by structured desktop tooling without adding Pythagoras-style clutter.
- Reworked **Gear** settings into a legible structured desktop layout with vertical section navigation, explicit high-contrast labels and isolated content panels. Narrow/mobile layouts collapse to a horizontal section selector instead of squeezing desktop navigation into the viewport.
- Rebuilt employee contextual actions as a dedicated premium action sheet with a clear player header, status context, full-width actions, descriptive subtext and a separated training-details footer.
- Replaced the old `T◆` launcher treatment with an inline vector Voidsmith Training Manager glyph while retaining ready/warning/error status indication.
- Job / Company continues to mount the full manager immediately. A fresh/default window now appears locked near the top-right unless the director previously saved a different window state.
- Added a persistent **Lock / Unlock** control beside the window controls. Locked windows cannot be dragged; unlocked windows may be freely repositioned; re-locking pins the current location rather than snapping it elsewhere.
- Window lock state is stored with position, size, minimize and maximize state. Resizing remains available while locked.
- Minimizing continues to hide the entire manager and leaves only the compact Voidsmith launcher for restoration.

### Fixed

- Fixed Torn page styles bleeding into the new settings structure and producing low-contrast or overlapping labels/navigation.
- Fixed the employee three-dot action menu appearing visually mangled because it reused under-styled generic modal classes.
- Fixed the launcher looking like an unstyled text token instead of a first-class Voidsmith control.

### Verification status

- Automated coverage verifies lock persistence/defaults, locked drag suppression, unlocked movement, top-right default placement, structured settings hooks, premium employee action-sheet hooks and vector launcher rendering in addition to the existing training/payroll safety suite.
- Live Torn/TornPDA visual and interaction verification remains explicitly covered by `docs/manual-verification.md` and is not represented here as completed automated evidence.

## [1.2.0] - 2026-09-12

### Added

- Training-focused premium cockpit with a deliberately compact default surface: available trains, eligibility summary, next recommendation, primary Train action, short queue preview and contextual employee actions.
- Fixed 72-hour / 3-day new-hire training hold. Employees become eligible at exactly 72 hours when all other rules pass; missing tenure data fails closed.
- Paid train agreements with FIFO priority, explicit director reorder, active-contract amendment/top-up, manual pause/resume, automatic ineligibility pause/resume, completion/cancellation/forfeiture outcomes, and optional training-contract price/reference metadata.
- Paid-train verification accounting: a commitment balance decreases only after independent Company News verification confirms the exact train.
- Bonus Train override for active paid employees, preserving the paid balance while still recording the verified training event in normal history/fairness.
- Configurable prolonged paid-train non-compliance threshold with suggested 2/3/7-day presets and custom durations. The manager can surface removal eligibility but never dismisses an employee automatically.
- Two normal training modes: default **Fair Rotation** and optional **Balanced Fairness**.
- Balanced Fairness rolling eligibility-adjusted ledger with a 30-day default window, 7/14/30/60/90-day presets, custom window support, trustworthy tracking-start coverage, and optional fairness-debt accrual while ineligible.
- **Priority Once**, consumed only after the selected employee receives a verified train.
- Skip/Snooze modes for next rotation, until tomorrow, timed duration and manual-until-cleared behavior.
- Training-focused attention/notification modes: Important only, Everything, Silent and Custom.
- Native Torn employee-row training badges for relevant states such as NEXT, PAID, PRIORITY, PAUSED, NEW HIRE and INELIGIBLE, without adding a custom Train button beside Torn's Fire control.
- Copy-only reminder helper for inactivity/addiction/new-hire cases. Messages are never sent automatically.
- Local non-secret Data & Recovery export/import with schema validation and pre-import backup, plus existing history rebuild/reset controls. API keys are excluded from export.
- Progressive Gear settings sections for General, Training Rules, Paid Trains, Fairness, Notifications, Appearance, Data & Recovery and Advanced tools.
- Responsive manager rules intended for narrow/mobile/TornPDA-sized layouts.

### Changed

- Recommendation precedence is now: first eligible active paid-train commitment, then Priority Once, then the selected normal rotation mode. Directors retain manual control to train any other eligible employee.
- Paid commitments never override inactivity/addiction/new-hire eligibility rules; ineligible paid employees are paused rather than trained.
- Fair Rotation remains the safe default: never-trained eligible employees first, then the longest time since last verified train.
- Audit Log and Diagnostics moved behind **Gear -> Advanced** so the ordinary manager remains intentionally simple.
- The floating manager remains movable, fully resizable, maximizable and minimizable, with the compact sidebar/dock launcher acting as its persistent open/minimize control.
- Job / Company route detection now supports Torn's current hash-style routes such as `companies.php#/option=employees` as well as the older `?step=your` form.
- Bootstrap/native-indicator DOM handling is defensive when optional Torn UI containers are not yet available.

### Fixed

- Fixed the manager failing to appear on current Torn Job / Company routes that omit the legacy `step=your` query parameter.
- Fixed test/bootstrap assumptions around optional native-indicator DOM APIs and derived attention state.
- Preserved fail-closed training receipts, exact employee targeting, fresh preflight checks, cross-tab duplicate protection, payroll verification and credential redaction while extending the training model.

### Verification status

- Automated build and test gates cover core eligibility, paid commitments, fairness, overrides, notifications, storage/recovery, training receipts, payroll safeguards, route detection, dock behavior and release integrity.
- Live Torn/TornPDA interaction remains explicitly covered by `docs/manual-verification.md` and is not represented here as completed automated evidence.

## [1.1.3] - 2026-09-10

### Added

- Always-visible Training Manager dock icon in Torn's status/sidebar icon area.
- Small dock status indicator: green when trains are available, amber for pending or unverified training states, red for stale/API errors, and neutral while idle.
- Dock tooltip with available train count and next employee when known.
- Small fallback launcher when Torn's status/sidebar area is temporarily unavailable.
- SPA-aware dock reattachment when Torn redraws or replaces the status icon area.

### Changed

- Minimizing the Company Training Manager now hides the full floating window completely instead of leaving the previous wide 64px minimized shell on screen.
- The sidebar dock remains visible while the manager is open and while it is minimized, acting as the consistent open/minimize toggle.
- On Company -> Employees, clicking the dock toggles the existing manager window without recreating it, preserving saved position and dimensions.
- Outside Company -> Employees, clicking the dock opens the company Employees manager page.
- The dock is independent of the legacy global badge visibility setting and remains available even when that badge is disabled.

### Fixed

- Removed the oversized minimized-manager footprint while retaining the existing persisted minimize state and exact normal-window geometry for restoration.

## [1.1.2] - 2026-09-09

### Added

- Row-based payroll diagnostics for the employee involved in the current action, including employee-row presence, `.pay input` count, native Submit Changes control count, dirty employee IDs, and API wage-coverage health.
- Regression coverage for payroll pages that do not expose one unique page-level form.
- Cache-bust support for employee API reads used to verify payroll changes.

### Changed

- Dock Pay and Restore Pay now target the exact employee row and its native `.pay input` rather than relying on a unique page-level payroll form.
- Payroll submission now uses Torn's native wage-field `input`, `change`, and `blur` events followed by exactly one enabled **SUBMIT CHANGES** control.
- Payroll verification uses cache-busted employee API reads while a Dock/Restore action is pending, avoiding false `unverified` results caused by stale Torn API responses.
- Payroll diagnostics expose structural/dirty-state health without exposing wage values.

### Fixed

- Fixed `payroll_form_not_unique` preventing Dock Pay on Torn's current employee-page layout.
- Prevented payroll actions from overwriting an unsaved wage edit already present in the target employee field.
- Prevented payroll actions from submitting when another visible employee has an unrelated unsaved/dirty wage field.
- Prevented a successful Torn wage change from being incorrectly reported as unverified merely because a cached employee response still contained the old wage.
- Payroll actions continue to fail closed when the exact employee row, wage input, API wage snapshot, or unique Submit Changes control cannot be verified.

## [1.1.1] - 2026-09-09

### Added

- Persistent train-attempt receipts stored in Tampermonkey storage for unresolved training actions.
- Fresh preflight checks immediately before every training POST, covering roster, eligibility, available train count, and newer Company News.
- Cross-tab train ownership with unique attempt IDs and a shared-storage settle check so simultaneous same-employee attempts from this userscript do not both reach Torn.
- Explicit UI states for **Train Pending Verification**, preflight state changes, and unknown submission outcomes.
- Diagnostics for pending train-receipt count and sanitized receipt states.
- Audit phases for training preflight, pending-receipt blocks, and unknown submission outcomes.

### Changed

- Pending/unverified employees are excluded from the training rotation until matching Company News reconciles the receipt.
- Pending train locks survive Refresh, page reloads, navigation, and other open tabs.
- The direct training POST no longer depends on Torn's native Train button remaining present or unique in the DOM; native controls are diagnostic only.
- Direct training still fails closed unless the script is on Torn company management, the exact employee row exists, and a current RFC token is available.
- Before spending a train, stale recommendations caused by another trainer or userscript are aborted and recalculated.

### Fixed

- Fixed the v1.1.0 bug where a successful Refresh cleared the in-memory `accepted_unverified` duplicate guard.
- Fixed duplicate protection being lost after page reload or in another tab.
- Fixed a same-second cross-tab race where two controllers could previously generate the same local train-attempt identifier.
- Reduced interference from userscripts that modify or replace Torn's native Train controls.
- Prevented a blind retry when a training POST has an unknown outcome; the employee remains locked until verification resolves it.

### Known limitation

- A completely separate userscript can still independently issue its own Torn training request. Torn's training endpoint does not expose a client idempotency key, so unrelated scripts posting at the exact same instant cannot be made transactionally impossible by this userscript alone. Avoid enabling overlapping automatic company-training features in multiple scripts simultaneously.

## [1.1.0] - 2026-09-08

### Added

- Local-only **Audit Log** for training, pay docking/restoration, refresh failures, history rebuilds, and settings changes.
- Rolling retention of the latest 500 audit entries.
- Audit filters by action, result, employee name, or Torn ID.
- Copy-visible-log, JSON export, and confirmation-gated audit clearing.
- **Diagnostics / Self-Test** panel with controller, history, audit, page-integration, and training-action health information.
- Copy Diagnostics action with recursive credential/session redaction.
- Explicit userscript `@updateURL`, `@downloadURL`, and `@supportURL` metadata.
- Release-integrity tests to keep package, userscript, README and metadata versions aligned.

### Changed

- Training now uses Torn's exact user-triggered company training POST instead of synthetic mouse events on the native Train control.
- Training transport validates the exact employee target and requires the current Torn RFC token before submitting.
- Training verification now distinguishes Torn acceptance from Company News/API verification.
- Accepted trains receive one immediate Company News check, then a 31-second cache-aware retry with a unique API timestamp before being classified as `accepted_unverified`.
- Duplicate training retries are blocked while a prior accepted train is still unverified.
- `package.json` is now the single source of release-version truth; the build injects that version into userscript metadata.

### Fixed

- Avoids treating an accepted Torn training request as failed merely because Torn's Company News/API cache has not refreshed within a few seconds.
- Avoids silently succeeding or fabricating local history from the training POST response alone.
- Prevents raw RFC values, API keys, authorization headers, cookies, session values, and authenticated response bodies from entering the Audit Log or Diagnostics output.
- Corrects README release-version drift by tying release checks to the package version.

## [1.0.6] - 2026-09-07

### Fixed

- Improved Company -> Employees route detection when Torn keeps the Employees tab active without legacy URL state.
- Improved native Torn employee-row and Train-control detection using exact employee IDs and current button-based controls.
- Surfaced failed and unverified Train results instead of letting them disappear silently.

## [1.0.4] - 2026-09-07

### Changed

- Training inactivity policy uses actual `last_action.timestamp` with a fixed 24-hour cutoff.
- Added high-contrast manager text/statuses.
- Added movable, resizable, minimizable and maximizable manager-window behavior.
- Replaced the text Settings control in the full manager header with a gear icon.
