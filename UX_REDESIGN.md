# LocalChat UX Redesign

Status: Approved — implementation in progress (Phase 1: Emerald Studio foundation)  
Branch: `feature/localchat-ux-redesign`

## Approved product direction

Rebuild the complete LocalChat interface as **Emerald Studio**: light-first, balanced information density, and smooth restrained motion. Use A. O. Smith-inspired color and typography cues only; never include its name, logo, mark, wordmark, or brand asset in LocalChat. The implementation is a complete UI replacement, not a color-only polish. The application must use LocalChat branding only: do not include any third-party company name, logo, mark, wordmark, or brand asset in the app UI, metadata, icons, splash/join screen, settings, or generated assets.

- Light theme: white primary surfaces, soft neutral gray secondary surfaces, deep forest-green navigation and restrained green action/selection states.
- Dark theme: premium deep forest-green and charcoal surfaces, muted green borders, accessible high-contrast text, and the same semantic green actions.
- Typography: modern sans-serif system stack, consistent weights and line heights; avoid introducing a remote font dependency.
- Shape and motion: consistent 8–14px component radii, subtle borders/elevation, short purposeful transitions (roughly 160–220ms), and respect reduced-motion preferences.
- Tone: modern, minimal, balanced information density, polished but functional; avoid copying another product's exact interface.
- Preserve all existing product behavior, keyboard access, responsive layout, and security/privacy guarantees.

## P0 — Inventory and safety guardrails

### Existing architecture

- Desktop app embeds the web UI from `app/web/` in the Rust application using `rust-embed`; the frontend is vanilla JavaScript and CSS with no frontend build step.
- Primary UI files are `app/web/index.html`, `app/web/style.css`, and `app/web/app.js`.
- Theme selection is stored as `localchat-theme` and applied through `data-theme="light|dark"` on the document element before paint.
- The current stylesheet uses a dark-default token set and a separate light-theme override; existing rules have accumulated over time, so avoid adding another pile of late overrides.
- The frontend has many stable DOM IDs, classes, inline handlers, and JS query selectors. Treat them as compatibility contracts unless their call sites are audited and migrated together.
- Direct messages use Web Crypto E2EE (ECDH P-256 + AES-GCM). Do not add DM plaintext or extracted DM URLs to server-side indexes, logs, or shared-content APIs.
- CI validates Rust, runs Rust tests, checks JavaScript syntax, and builds a Windows test executable after validation succeeds.

### UI inventory

1. **Entry and identity**
   - Join/login panel, username/password fields, status and validation messaging, theme initialization, product mark/title.
   - Account identity, avatar, designation, online/connection state.
2. **Application shell and navigation**
   - Main sidebar/header, connection pill, About dialog, My Chats/Online tabs, new-conversation menu, QR/pairing action, admin link, browser-notification menu, current-user footer.
3. **Chat list and discovery**
   - Search chats/messages, clear-search action, filtered results, conversation rows, group/channel/DM distinctions, unread counts, timestamps, previews, presence, empty/loading states.
4. **Conversation header**
   - Avatar/title/subtitle, E2EE indicator, saved messages, chat-info drawer, message search, join/invite actions, audio/video call actions.
5. **Message timeline**
   - Messages and date separators, delivery/read states, reactions, reply/forward/delete, pin/save, context toolbar/menus, mentions, link previews, attachment cards, polls, typing state, scrolling and search result navigation.
6. **Composer**
   - Text area, reply preview/cancel, @mention jump, emoji picker, poll creation, file/image attachment, send state and keyboard behavior.
7. **Drawers and information views**
   - Private/group/channel info, description and edit controls, notification preferences, shared Media/Links/Files tabs, member list/roles, view-all and item detail interactions.
8. **Settings and profile**
   - Profile picture upload/presets, username and designation editing, appearance/theme, notifications, password change, sign-out.
9. **Dialogs and transient UI**
   - Create channel, direct-message picker, invite picker, designation, password, About/release notes, share/QR, confirm/delete, poll, toast/status messages, dropdowns and tooltips.
10. **Responsive/accessibility behavior**
    - Narrow viewport/sidebar behavior, scroll containers, focus rings, keyboard navigation, semantic labels, modal/drawer focus and close behavior, reduced motion, light/dark contrast.

### Non-negotiable behavior and privacy checks

- Preserve stable IDs/event handlers or explicitly migrate every dependency.
- Do not alter message delivery, encryption, authorization, upload rules, or server APIs merely for visual styling.
- No direct-message plaintext, DM link extraction, or DM shared-content indexing on the server.
- Keep group membership checks and role/owner/moderator permissions intact.
- Never make destructive or permission-changing controls look like ordinary navigation.
- Do not remove working capabilities to simplify the UI.
- Keep the existing release branch and main untouched; do not merge or publish a final release without explicit approval.

## Implementation sequence

### P1 — Design-system foundation
- Replace legacy indigo/violet accents with semantic green tokens.
- Define paired light/dark tokens for surfaces, text, borders, actions, status, focus, and shadows.
- Normalize typography, spacing, radii, buttons, inputs, badges, focus states, scrollbar treatment, and motion.
- Update app mark/favicon to a LocalChat-only design; remove any external branding.
- Validate every component in both themes before moving on.

### P2 — App shell and chat discovery
- Refine shell/sidebar hierarchy, chat list rows, search, filters, unread states, presence and account footer.
- Improve selected/hover/focus states and empty states without changing list behavior.

### P3 — Conversation experience
- Refine header, timeline, message bubbles, date separators, reaction and action toolbar, reply/forward/pin/save states, attachments, polls, and search navigation.
- Preserve long-message wrapping, viewport-aware toolbar placement, scrolling, and keyboard interactions.

### P4 — Composer and transient interactions
- Redesign composer, reply preview, attachment flow, emoji and mention pickers, dropdowns, dialogs, toasts, tooltips, and loading/error states.
- Keep existing IDs and JS behavior compatible.

### P5 — Info panels and settings
- Apply the approved compact profile header and balanced information density.
- Keep inline Media · Links · Files tabs, compact media previews, correct shared-item counts/listing, member roles, notification controls, profile editing and settings.

### P6 — Regression and test build
- Review all key screens in light and dark themes, keyboard flows, reduced motion, resizing, long conversations, empty/loading/error states.
- Run CI validation and Windows build. Only then instruct the user to download the test executable.
- Do not merge or publish until the user approves the tested result.

## Design tokens — target values

These are starting values for implementation, not a claim that every component already uses them.

| Token | Light | Dark |
|---|---|---|
| App canvas | `#F4F7F5` | `#101A16` |
| Primary surface | `#FFFFFF` | `#17231D` |
| Secondary surface | `#F0F4F1` | `#1D2B24` |
| Hover surface | `#E7EFEA` | `#26382E` |
| Primary text | `#17241D` | `#F1F6F2` |
| Secondary text | `#52645A` | `#B2C2B8` |
| Subtle text | `#6C7D73` | `#8FA397` |
| Border | `#DCE5DF` | `#2B4034` |
| Primary action | `#087A50` | `#35A875` |
| Primary action hover | `#066641` | `#48B985` |
| Soft action surface | `#E1F2E8` | `#203E2F` |
| Danger | `#C83D43` | `#F07176` |

Typography target: system sans-serif stack led by `Inter` when locally available, then `Segoe UI Variable`, `Segoe UI`, `Roboto`, `Arial`, sans-serif. Do not require downloading a font at runtime.

## P0 completion criteria

- [x] Confirmed embedded vanilla-JS/CSS architecture and existing theme mechanism.
- [x] Identified major screens, drawers, menus, dialogs, and interaction groups.
- [x] Documented E2EE, permission, stable-selector, and release guardrails.
- [x] Created a dedicated redesign branch from the latest tested Chat Info UX branch.
- [x] Began implementation incrementally on the dedicated redesign branch; updated shared tokens, core shell/message/composer styling, Info/settings styling, favicon, and generated avatar accents.\n- [ ] Validate in CI and a Windows test executable before asking the user to test.
- [x] Added a first cohesive styling pass for the composer, emoji/mention pickers, menus, dialogs, and Info/settings surfaces; behavior selectors remain unchanged.
- [ ] Review the resulting UI in both themes and fix any contrast/layout regressions found by validation.


## Implementation log

- **Phase 1 — design foundation:** Added `app/web/emerald-studio.css` and loaded it after the legacy stylesheet. This establishes the approved semantic palette, typography, desktop three-part workspace, redesigned join surface, message/composer surfaces, consistent right-side drawers, and responsive/reduced-motion behavior while retaining existing DOM IDs and JavaScript hooks.
- **Validation:** GitHub Actions CI run #208 was queued for commit `6efca20e43540424c85aeb008d0e0f32f5b2c1b5`. A passing build is necessary but not sufficient; UI interactions and privacy-sensitive behavior still require verification.
- **Next phases:** Continue migrating the message and composer interactions, shared-content browser, settings/profile, dialogs/pickers, call surfaces, responsive behavior, and theme contrast. Fix and test Links/Files list rendering rather than relying on counts. Keep the existing encrypted-DM privacy boundary and permission checks unchanged.
- **Release policy:** Keep the work on the feature branch and draft PR. Do not merge or publish a final release until implementation, CI, and the consolidated manual test pass are complete and explicitly approved.
