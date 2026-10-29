# LocalChat 4.0.0 — Authentication UX/UI Redesign Proposal
**Scope:** Login, account registration, and forgotten-password recovery only.  
**Branch:** `feature/localchat-4.0.0-auth-ux`  
**Status:** Proposal for user approval — no UI implementation included.  
**Design direction:** Emerald Studio · light-first · balanced density · smooth, restrained motion.

## 1. Principles

- Redesign the authentication journey as a coherent experience, not a recolor of the existing card.
- Use a clean, premium, light-first interface with a restrained emerald accent, clear typography, calm surfaces, and strong contrast. Dark mode remains supported.
- Keep the visual hierarchy compact and reassuring. Avoid unnecessary decoration, oversized gradients, and marketing-style filler.
- Use consistent field geometry, button styles, status messaging, spacing, focus rings, and iconography across all auth screens.
- Provide a clear way to move among Sign in, Create account, and Recover account.
- The app runs on a local LAN server. Do not imply cloud accounts, email verification, or email-delivered password resets.
- This proposal changes UI and interaction presentation only. Any required API/database/security changes must be separately identified and approved.

## 2. Shared auth shell

### Layout
- A full-viewport, responsive authentication shell using the approved Emerald Studio language.
- Main content in a centered, carefully sized surface with generous but controlled whitespace. On wide screens, a restrained supporting panel may explain LocalChat's local-network privacy model; on narrow screens, the form becomes the focus and the supporting content collapses.
- Use the LocalChat product mark and wordmark, with no third-party corporate branding.
- Keep the form width comfortable for reading and input. Registration/recovery may scroll within the page naturally; avoid a nested, short scrolling form inside a fixed-height card.
- Ensure the primary action and inline status remain reachable on short laptop windows and small mobile screens.
- Use a subtle entrance transition (fade/short slide) and state transitions; respect `prefers-reduced-motion`.

### Theme
- Light-first default, using white/soft-neutral surfaces, deep readable text, quiet borders, and emerald for primary actions/focus/selected states.
- Dark mode uses a deep neutral background and elevated surfaces, with accessible emerald accents and the same hierarchy.
- Do not use color alone to indicate errors or success.

### Shared components
- Consistent labeled fields, field hints, password visibility toggle with accessible name, primary/secondary buttons, inline status panel, loading/disabled states, and back navigation.
- Status and validation messages use `role=status` or `aria-live` where appropriate and are associated with the affected field where feasible.
- Keep form values after recoverable validation errors; do not unexpectedly clear credentials or recovery answers.
- Avoid displaying raw server stack traces or implementation details.

## 3. Screen A — Sign in

### Hierarchy
1. LocalChat mark and name.
2. Heading: **Welcome back**.
3. Short supporting line: “Sign in to your LocalChat network.”
4. Identifier field labelled **Email or @username**.
5. Password field with show/hide control and a **Forgot password?** text action aligned with the password label or immediately below it.
6. Full-width **Sign in** primary button, with a clear loading state.
7. Divider or quiet secondary prompt: “New to this network?” with **Create an account**.
8. Quiet security note: “Direct messages are end-to-end encrypted.” Avoid claiming all app content is end-to-end encrypted.

### Interaction and validation
- Identifier accepts either account email or the generated unique handle. Normalize case consistently according to server rules; never make identity depend on display-name capitalization.
- Use correct autocomplete hints (`username` and `current-password`) and sensible input lengths.
- Enter submits the form when valid; keyboard focus remains visible.
- Show a concise inline error for invalid credentials, unavailable server, or other expected failures. Do not disclose whether an account exists unless the security policy explicitly permits it.
- Disable the submit action while the request is in flight and prevent duplicate submissions.
- A successful sign-in proceeds into the existing app flow without changing session or E2EE key-handling behavior.

## 4. Screen B — Create account

### Hierarchy
1. Back-to-sign-in navigation.
2. Heading: **Create your account**.
3. Brief note: “Your account stays on this LocalChat network. No verification email is sent.”
4. Required account fields in a clear sequence:
   - **Work email** — unique account email; explicitly state it is used for sign-in and cannot be changed by the user after registration.
   - **Display name** — editable name shown to coworkers; not required to be unique.
   - **Designation** — preserve existing options: AM, TL, STL, QDE, LRD, EE, CSA.
   - **Password** and **Confirm password**, if both are supported by the current registration API. If current implementation accepts only one password, do not add a confirm field without confirming that the client can validate it consistently.
5. **Account recovery** section with three question-and-answer pairs, visually grouped and clearly numbered.
6. Full-width **Create account** primary button.
7. Existing-account prompt with **Sign in**.

### Generated handle
- Do not ask the user to create a username.
- Explain that LocalChat assigns a unique `@username` after account creation and that it can be used to sign in and be mentioned in chats.
- After successful registration, show a distinct **Account created** confirmation that reveals the assigned handle, provides a copy action, and explains that the display name is editable while the email is admin-managed.
- Only show the generated handle if it is returned authoritatively by the backend. Never fabricate one client-side.

### Recovery questions
- Preserve the existing question bank and answer-hashing behavior.
- Each of the three question selectors must exclude options already selected in the other selectors, so duplicate questions cannot be chosen.
- Keep answers masked by default; allow optional reveal controls if consistent with password-field behavior.
- Use clear labels and help text. Do not expose answers in logs, URLs, analytics, or client storage.
- Keep question/answer validation close to the corresponding field and preserve values after a recoverable submission error where safe.
- Explain briefly that recovery answers are needed if the user forgets their password and should be answers they can reliably reproduce.

### Validation and success
- Validate required fields, email syntax, password policy, matching confirmation (if present), distinct recovery questions, and non-empty recovery answers before sending.
- The server remains authoritative for uniqueness, handle generation, password policy, and account creation.
- Present duplicate email, invalid input, connection failure, and server failure in human-readable inline states.
- After success, show the generated handle and a clear next action: **Continue to sign in** or continue automatically only if the existing session contract supports it. Do not silently change authentication/session behavior as part of a visual redesign.

## 5. Screen C — Forgot password / account recovery

**Important dependency:** Before implementation, trace the current `#forgotPasswordLink` handler and backend endpoints. This proposal defines the presentation structure but does not assume that every recovery step exists today.

### Step 1 — Identify account
- Heading: **Recover your account**.
- Explain: “Enter the email or @username for your account.”
- One identifier field and **Continue** action.
- Secondary **Back to sign in** action.
- Use neutral errors that do not unnecessarily reveal whether an account exists.

### Step 2 — Verify recovery answers
- Show the recovery question(s) returned by the existing recovery API, in the order required by the backend.
- Provide labelled answer fields, masked by default where appropriate, and an explicit **Verify answers** action.
- Do not hardcode a new question sequence in the UI; render only the questions requested by the server.
- Handle wrong answers, incomplete recovery setup, temporary lockout/rate limiting, unknown account, and network/server errors using clear messages.
- Never reveal stored answer hashes or answers.

### Step 3 — Set a new password
- Only show this step if the existing backend supports a safe reset flow after successful recovery verification.
- New password and confirmation fields, show/hide controls, password guidance, and a **Reset password** action.
- Reuse the same password policy as registration and authenticated password change.
- On success, show **Password updated** and return the user to sign in with a clear confirmation.
- Do not offer an email reset link because the local LAN server does not send email.

### If current backend does not support these steps
- Do not build a front-end-only simulation or claim that a password has been reset.
- First document the actual supported recovery flow and its limitations; any backend/security change needed to enable the proposed flow must be separately approved.

## 6. State inventory across the three screens

Every screen must be designed and tested for:
- Initial / idle state.
- Focused and filled fields.
- Password hidden and revealed.
- Client-side validation error.
- Server validation error.
- Loading / request in progress.
- Duplicate submission prevention.
- Network unavailable / server error.
- Successful completion.
- Keyboard-only navigation and screen-reader announcements.
- Light and dark theme.
- Short-height viewport, narrow width, browser zoom, and reduced-motion preference.

Specific registration states:
- Recovery question choices dynamically filtered to prevent duplicates.
- Email already in use.
- Registration succeeds and server returns generated handle.
- Registration succeeds but handle cannot be shown due to malformed/missing response: display a safe support/retry message, never invent a handle.

Specific recovery states:
- Account identifier submitted.
- Recovery questions loaded.
- Incorrect answers / retry policy.
- Recovery setup missing or incomplete.
- Password reset in progress.
- Password reset success.
- Backend capability unavailable.

## 7. Accessibility, responsive behavior, and quality bar

- Semantic headings and forms; every field has a persistent visible label.
- Keyboard-operable links and buttons; visible focus indicators and logical tab order.
- Adequate text/control contrast in both themes.
- Password reveal buttons announce their current action/state.
- Errors are specific enough to help users recover but do not leak account secrets.
- No clipped labels, horizontal scrolling, hidden primary actions, or trapped keyboard focus.
- Smooth, restrained transitions; reduced-motion support.
- Test on desktop widths, short laptop heights, narrow mobile widths, browser zoom, and both themes.
- Keep all existing authentication API contracts intact unless a separately approved backend change is required.

## 8. Implementation boundaries and acceptance criteria

This segment is accepted only when:
- Login, signup, and recovery form a visually consistent Emerald Studio experience.
- Generated handle and display-name copy matches the approved identity model.
- Three recovery questions cannot be duplicated through the UI and are still validated server-side.
- Recovery UI matches the actual supported backend flow; no fake reset behavior exists.
- Login, registration, password recovery, and authenticated password change remain distinct flows.
- Existing account/session behavior and E2EE key handling are unchanged unless explicitly approved.
- Automated validation/tests pass and a Windows test build is produced.
- User tests the build and approves this auth segment before the project moves to the next UI segment.
- No merge into `main` until the full 4.0.0 redesign is completed, tested, and approved.

## 9. Open implementation checks (not design blockers, but must be resolved before coding)

- Confirm exact current recovery API sequence, endpoint names, response states, rate limiting, and reset token/session semantics.
- Confirm whether registration currently requires a confirm-password field and the authoritative password length/policy.
- Confirm how the generated handle is returned and displayed after successful registration.
- Confirm whether sign-in error responses can be surfaced safely without account enumeration.
- Confirm that a user with no recovery answers can be handled safely and clearly.

---
**Approval requested:** Approve this screen-by-screen proposal, or provide edits. No authentication UI code has been changed as part of preparing this proposal.
