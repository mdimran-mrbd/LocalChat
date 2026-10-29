# LocalChat 4.0.0 — Authentication UI Inventory
**Scope:** Login, account registration, and account recovery only.  
**Inventory baseline branch:** `feature/localchat-4.0.0-auth-ux`  
**Baseline commit:** `7009b49117bdb8e66af5d1714b70e9e9f4d4d0d3` — “Restore display-name asset cache version”  
**Baseline validation:** LocalChat CI run #308 completed successfully for this commit.  
**Status:** Inventory only. No authentication UI redesign or behavior changes have been made.

## 1. Baseline and branch strategy

- The new redesign branch was created directly from the latest confirmed successful test-build commit above.
- Work for LocalChat 4.0.0 stays on `feature/localchat-4.0.0-auth-ux`.
- Do not merge this branch into `main` until all redesign segments are complete, the app has been tested end-to-end, and the user approves the final result.
- Implement the redesign segment-by-segment. This inventory covers only authentication screens; it does not authorize changing the main chat UI yet.
- Preserve existing account, recovery, session, password, and encryption behavior unless a separate approved change explicitly calls for a behavior change.

## 2. Existing authentication entry screen

Source: `app/web/index.html` (`#join`, `#joinForm`) and `app/web/style.css` (JOIN SCREEN styles).

### 2.1 Brand and introductory area
- LocalChat logo/mark (inline SVG).
- Product name: “LocalChat”.
- Subtitle: “Private messaging for your local network”.
- Screen uses the shared theme variables and reads the saved light/dark theme before first paint.
- Current style is a centered, single-column card over a tinted/gradient background.

### 2.2 Sign-in fields and actions
- Identifier field: label/placeholder “Office email or @unique_username”; element ID `username`; autocomplete `username`; maximum 254 characters.
- Password field: element ID `password`; autocomplete `current-password`; maximum 128 characters; placeholder says “At least 4 characters”.
- Primary submit button: “Sign in”, with a directional arrow icon.
- Inline status/error region: `#joinStatus`.
- Footer links:
  - “Create an account” (`#toggleRegistration`).
  - “Forgot password?” (`#forgotPasswordLink`).
- Security reassurance: “End-to-end encrypted direct messages”.
- A theme-toggle button exists in the markup but is hidden by default.

### 2.3 Existing layout and styling
- Card width is approximately 400px, capped at 94vw.
- Card has a border, rounded corners, shadow, and 32px horizontal padding.
- Header is centered.
- Form uses vertical spacing and a scrollable form region; the registration form can grow substantially taller than the login form.
- Current design tokens are primarily indigo/violet, not the approved LocalChat 4.0.0 “Emerald Studio” direction.
- Form fields use the existing global field/input styles; errors can mark inputs and status text.
- Body scrolling is disabled globally, so internal scrolling and small-height viewport behavior matter.

## 3. Existing registration mode

Registration fields are initially inside `#registrationFields`, hidden until registration mode is enabled. They currently share the same card/form as sign-in rather than being a dedicated page.

### 3.1 Fields currently present
1. Office email:
   - `#officeEmail`, type email, maximum 254 characters.
   - Helper text explicitly says no verification email will be sent.
2. Designation:
   - `#registrationDesignation`, required select.
   - Options: AM, TL, STL, QDE, LRD, EE, CSA, each with a full designation label.
3. Display name:
   - `#registrationDisplayName`, maximum 48 characters.
   - Example placeholder: “e.g. Razzak Islam”.
4. Three account-recovery questions:
   - `#recoveryQuestion1`, `#recoveryQuestion2`, `#recoveryQuestion3`.
   - Each uses the same bank of ten questions.
   - Corresponding answer inputs: `#recoveryAnswer1`, `#recoveryAnswer2`, `#recoveryAnswer3`; answers are password-type inputs, maximum 200 characters.
   - Select placeholders indicate the questions should be different.
5. The sign-in identifier input (`#username`) is also present above the registration fields. Its exact registration-mode label/validation behavior must be verified in the existing client logic before any redesign changes.

### 3.2 Current registration guidance
- The helper text currently tells users to choose their own unique username (example `imran01`), 3–24 characters, English letters/numbers/underscore/hyphen, no spaces, at least one number, and says the username cannot be changed.
- It also says display names are editable and do not need to be unique.
- This wording is inconsistent with the newer approved identity model (see Section 7) and should be treated as a known inventory finding, not as approved copy for the redesigned screen.

### 3.3 Registration interaction / validation points to preserve or improve
- Registration mode is toggled from the footer link.
- Three recovery-question selects need to prevent selecting a question already chosen in another select; this was previously reported as a usability issue.
- Required fields, duplicate email/handle errors, password rules, and server-side validation need clear inline feedback.
- Long-form registration needs usable scrolling on short desktop windows and narrow/mobile viewports.
- Password/recovery-answer fields should not lose entered values unexpectedly when validation fails or the user toggles a mode, unless the existing security flow intentionally clears them.

## 4. Account recovery inventory

### 4.1 Visible entry point
- “Forgot password?” link (`#forgotPasswordLink`) is present below the main form.
- The current HTML segment does not expose a separate, dedicated recovery page alongside the join form. The exact recovery steps, modal/inline presentation, field IDs, API calls, and success/error states must be traced through the existing client/server handlers before redesigning them.

### 4.2 Recovery-related current elements
- Registration captures three recovery question IDs and answers.
- A helper note says recovery answers are stored as password hashes.
- Existing account-security UI also has a Change Password modal with current password, new password, confirm password, and a live status region; this is an authenticated password-change flow, not the same as forgotten-password recovery.
- Keep these flows distinct in the redesign: **forgot-password recovery** is unauthenticated; **change password** is for a signed-in user.

### 4.3 Recovery states to inventory during implementation discovery
Before changing recovery UI, map the actual implementation and document each supported state:
- Identifier/account lookup (email and/or unique handle, according to the approved identity model).
- Recovery-question prompt(s) and answer validation.
- Password reset / new password and confirmation, if supported by the current server flow.
- Unknown account, incomplete recovery setup, incorrect answer, rate-limit/temporary failure, network/server failure, and successful completion.
- Return path to sign-in and status/feedback after reset.
- Whether a user can recover an account when the server has no configured recovery answers.
Do not invent a reset flow or imply email-based recovery is available unless the backend actually supports it.

## 5. Shared states, accessibility, and responsive behavior

- Light/dark theme is applied before paint; both themes must remain legible.
- Use explicit visible labels, not placeholder-only labels.
- Provide visible keyboard focus, logical tab order, keyboard-operable links/buttons, and accessible names for icon-only actions.
- Status/error messages should be associated with the relevant form/field where feasible and announced accessibly (`role=status` / `aria-live`).
- Distinguish validation errors from general progress/success messages; never communicate state through color alone.
- Maintain readable contrast, comfortable hit targets, and non-clipped controls.
- Test at common desktop sizes, short-height laptop windows, narrow mobile widths, browser zoom, and long registration content.
- Ensure the primary submit action remains reachable without scrolling the entire page unexpectedly.

## 6. Visual inventory issues / opportunities (not yet design decisions)

- Login, registration, and recovery do not yet read as a coordinated, purpose-built authentication journey.
- Registration is embedded in the login form and creates a long scrollable card.
- The current palette/visual language is indigo-violet; the approved 4.0.0 direction is Emerald Studio, light-first, balanced density, with smooth restrained motion.
- Registration copy still describes a user-chosen immutable username, conflicting with the newer generated-handle account model.
- Recovery is exposed only as a footer link in the inspected markup; the full flow must be mapped from code before any screen redesign.
- Current identifier wording (“Office email or @unique_username”) needs to match the final login rules and whether the handle is shown with an @ prefix.
- Security copy and account-recovery explanations should be concise, accurate, and avoid promising email verification/reset when the local LAN server does not send email.

## 7. Approved identity and security requirements for the redesigned auth journey

These are prior user decisions that the new UI must reflect; they are requirements, not claims about what the current UI already does.

- Each account has a unique email address, but registration does **not** send a verification email.
- Email is immutable to ordinary users; only a server Admin can change it in Admin settings.
- Users can sign in with either email or their unique generated `@handle`.
- The app generates the unique handle (example: `@imran07`); users should not be asked to invent one during registration unless the user explicitly changes this decision later.
- Display name is editable, does not need to be unique, and is capitalized appropriately after save.
- Users can be mentioned by display name or `@handle`.
- Preserve designation selection and all existing supported account-security behavior.
- Preserve end-to-end encrypted DM privacy. Never expose DM plaintext or extracted DM URLs in server-side indexes as part of auth work.
- Do not change backend authentication semantics merely to make a visual prototype work. UI, API, database migrations, and compatibility tests must agree before shipping.

## 8. Pre-redesign discovery checklist

- [ ] Trace `#toggleRegistration` and `#forgotPasswordLink` event handlers in `app/web/app.js`.
- [ ] Locate all recovery endpoints and server handlers; document the exact current recovery sequence.
- [ ] Verify the actual current registration identifier/username behavior against the latest account-model code.
- [ ] Verify password minimum/maximum rules, required fields, and error responses from the server (do not rely only on HTML attributes).
- [ ] Verify whether the recovery question uniqueness constraint is enforced client-side, server-side, or both.
- [ ] Record existing success, validation, duplicate-account, network-error, and recovery states.
- [ ] Agree the redesigned login, registration, and recovery screens before implementing this segment.
- [ ] Keep this branch separate from `main`; run validation and a Windows test build after implementation, then ask the user to test before any merge.

---
**Next step:** Review and approve this inventory. After approval, prepare the screen-by-screen redesign proposal for Login, Sign up, and Account recovery only; do not start the implementation until that proposal is approved.
