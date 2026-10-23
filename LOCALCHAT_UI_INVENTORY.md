# LocalChat UI Element Inventory

**Repository:** `mdimran-mrbd/LocalChat`  
**Branch reviewed:** `feature/localchat-ux-redesign`  
**Primary source files reviewed:** `app/web/index.html`, `app/web/app.js`, `app/web/style.css`  
**Purpose:** A durable working inventory of the existing UI elements, where they appear, and what they do. Use this inventory as the baseline for redesign decisions before implementing further visual or structural changes.

> This is an inventory of the UI and behavior represented in the reviewed source, not a claim that every item has been fully tested in a running build. Some elements are conditional, permission-dependent, or visible only on mobile, in dialogs, or during calls. Verify implementation details against the branch before relying on them for code changes.

## 1. Join / login screen

**Location:** Initial screen shown before entering the main app.

- LocalChat logo and application title.
- Username field: `username`.
- Password field: `password`.
- Join form: `joinForm`.
- Join button to submit the form.
- Status and error feedback: `joinStatus`.
- Join-screen theme toggle: `themeToggleJoin`.

**Purpose:** Let a user identify themselves and enter the app, while providing validation/status feedback and a way to change the theme before joining.

## 2. Primary navigation rail

**Location:** Far-left vertical rail in the main app shell.

- **Chats** — opens the chat-discovery view.
- **Online** — opens the online-users view.
- **Share / QR** — opens sharing or QR-related functionality.

**Important placement note:** Settings was removed from this rail in the latest reviewed version. Settings/profile access belongs beside the signed-in user profile at the bottom of the adjacent sidebar. On responsive/mobile layouts, Chats and Online may also appear as sidebar tabs.

**Purpose:** Provide compact top-level navigation without duplicating account settings in the rail.

## 3. Chat discovery sidebar

**Location:** Immediately to the right of the primary navigation rail.

- LocalChat brand/title.
- Connection/presence status indicator: `statusPill`.
- About button: `aboutBtn`.
- Chats and Online sidebar tabs.
- New conversation control: `sbNewBtn`.
- New-conversation menu: `sbNewMenu`.
- Channel/group creation entry.
- Direct-message (DM) creation entry.
- Share control: `shareBtn`.
- Sidebar search input: `sbSearch`.
- Clear-search control: `sbSearchClear`.
- Conversation list/container: `sbGroups`.
- Conversation rows for available chats.
- Pin indicator/action for pinned conversations.
- Admin entry/link: `adminLink`, when available.
- Signed-in user profile chip: `meChip`.
- Settings/profile control beside the user chip.

**Purpose:** Find and switch between conversations, start a conversation or channel, search the list, access sharing/admin features where permitted, and reach the signed-in user's account controls.

## 4. Main conversation header

**Location:** Top of the active conversation pane.

- Chat avatar: `chAvatar`.
- Chat or channel title: `chTitle`.
- Supporting status/member text: `chSub`.
- End-to-end encryption indicator: `e2eeBadge`, where applicable.
- Saved Messages control: `savedMessagesBtn`.
- Saved Messages count: `savedMessagesCount`.
- Chat/channel information button: `channelInfoBtn`.
- Message-search button: `messageSearchBtn`.
- Join button: `joinBtn`, when relevant.
- Add-people button: `addPeopleBtn`, when available.
- Audio-call button: `callBtn`.
- Video-call button: `videoCallBtn`.

**Purpose:** Identify the current conversation and expose its most relevant actions: information, search, saved messages, membership actions, and calls. Availability can depend on conversation type and permissions.

## 5. Message search

**Location:** Search interface associated with the active conversation, opened from the conversation header.

- Search input: `messageSearchInput`.
- Match count/status: `messageSearchCount`.
- Previous-match control.
- Next-match control.
- Close-search control.
- Keyboard behavior: Enter and Shift+Enter navigate matches; Escape closes search.

**Purpose:** Search within the current conversation and navigate between matching messages.

## 6. Message timeline

**Location:** Main scrollable conversation area.

- Message stream/container: `messages`.
- Date separators.
- Incoming and outgoing message bubbles.
- Sender name and/or avatar where applicable.
- Message timestamps.
- Delivery/read indicators where applicable.
- Clickable message URLs.
- File and media attachments.
- Message reactions.
- Message action toolbar/menu, subject to permissions and context:
  - Reply.
  - Forward.
  - Pin/unpin.
  - Save to Saved Messages.
  - Delete, with rules depending on ownership and group permissions.
- Reply context/quoted-message preview.
- Mentions, including mention presentation in the message.
- Pinned-message banner/state.
- Poll messages and poll-related presentation.
- Typing indicator: `typing`.
- Empty, loading, and error states as applicable.

**Purpose:** Display conversation history and support normal messaging plus contextual message actions. Actions must respect the relevant ownership, membership, role, and privacy rules.

## 7. Message composer

**Location:** Bottom of the active conversation pane.

- Message input: `msgInput`.
- Send form: `sendForm`.
- Reply preview: `replyPreview`.
- Close reply preview: `replyPreviewClose`.
- Mention-jump control: `mentionJumpBtn`.
- Create-poll button: `createPollBtn`.
- Emoji button: `emojiBtn`.
- File input: `fileInput`.
- Input auto-grow behavior.
- Dynamic mention picker.
- Emoji picker.

**Purpose:** Compose and send messages, reply to a specific message, mention users, create polls, insert emoji, and attach files.

## 8. Chat Info drawer

**Location:** Right-side drawer opened from the conversation header.

- Backdrop: `channelInfoBackdrop`.
- Drawer: `channelInfoDrawer`.
- Drawer title: `channelInfoTitle`.
- Drawer content container: `channelInfoContent`.
- Rendering entry point: `renderChannelInfo()`.

### Group / channel information

- Group/channel avatar or photo.
- Group/channel name.
- Member count.
- Contextual name-edit control; the intended interaction is an edit icon beside the name, revealed on hover/focus, with in-place editing.
- Description and description editor.
- Photo edit/upload control where authorized.
- Notification preference control.
- Member search.
- Member list and role information.
- Shared-content counts.
- Inline **Media · Links · Files** tabs.
- Shared-item previews/listing.
- Shared-content overlay or “View All” browsing.

### Private-chat information

- Contact identity/profile information.
- Notification preference control.
- Shared-content navigation and previews, subject to the private-chat encryption/privacy boundary.

### Known verification issue

In prior testing, the Links and Files counts could be correct while the corresponding list entries were missing. Treat successful counts alone as insufficient evidence that the lists work. Verify retrieval, rendering, deletion updates, and empty states for both sections.

**Purpose:** Provide contextual information and conversation-level controls without leaving the active conversation.

**Privacy requirement:** Do not index private-DM plaintext or extracted private-DM URLs on the server. Shared-content behavior for private chats must preserve the established encrypted-DM privacy boundary.

## 9. Settings / profile panel

**Location:** Panel opened from the settings/profile control near the signed-in user chip.

- Backdrop: `settingsBackdrop`.
- Panel: `settingsPanel`.
- Avatar preview: `profileAvatarPreview`.
- Avatar upload button: `profileAvatarUploadBtn`.
- Avatar file input: `profileAvatarFileInput`.
- Avatar presets.
- Username display/edit: `profileUsername`.
- Username edit/save controls.
- Designation display/edit: `profileDesignation`.
- Designation edit/save controls.
- Theme toggle: `themeToggle`.
- Notification settings.
- Change-password entry.
- Logout entry.
- Status and validation feedback.
- Close control.

**Purpose:** Manage the signed-in user's profile and account preferences, including avatar, username, designation, theme, notifications, password, and logout.

**Requirement to preserve:** Usernames must be unique. User-editable name and designation controls should show clear validation and save status.

## 10. Dialogs and overlays

**Location:** Layered over the main app when the related action is invoked.

- Create modal: `createModal`.
- Direct-message modal: `dmModal`.
- Invite modal: `inviteModal`.
- Poll-creation modal: `pollCreateModal`.
- Designation-assignment modal: `designationModal`.
- Change-password modal: `changePwModal`.
- About modal: `aboutModal`.
- Share / QR modal: `shareModal`.
- Confirmation dialog: `confirmModal`.
- Emoji picker.
- Reaction picker.
- Forward-message dialog.
- Saved Messages view.
- Shared-content browsing overlay.
- Media lightbox.
- Toast notifications: `toast`.

**Purpose:** Handle focused workflows and confirmations without navigating away from the current screen. Overlays should have consistent dismissal, keyboard, focus, contrast, and responsive behavior.

## 11. Audio calls and video

**Location:** Call UI layered over or alongside the main app.

### Incoming-call UI

- Incoming-call container: `incomingCall`.
- Caller avatar: `icAvatar`.
- Caller name: `icName`.
- Caller supporting text: `icSub`.
- Call title/status: `icTitle`.
- Accept and decline controls.

### Active-call panel

- Call panel: `callPanel`.
- Participant avatar: `cbAvatar`.
- Participant name: `cbName`.
- Call status: `cbStatus`.
- Mute control: `muteBtn`.
- Camera control: `camBtn`.
- Speaker control: `speakerBtn`.
- End-call control: `endBtn`.

### Video stage

- Video stage: `videoStage`, hidden until video call is active.
- Local video: `localVideo`.
- Remote video: `remoteVideo`.
- Remote audio: `remoteAudio`.

**Purpose:** Support incoming-call decisions, active audio-call controls, and the video/audio media stage.

## 12. Notifications, updates, and system feedback

- Browser-notification control: `browserNotificationsBtn`.
- Browser-notification menu: `browserNotificationMenu`.
- Update banner: `updateBanner`.
- Update version label: `updateVersion`.
- Update status: `updateStatus`.
- Update-now button: `updateNowBtn`.
- Dismiss-update-banner control: `dismissUpdateBanner`.
- App version label: `appVersionLabel`.
- Update-check opt-in: `updateChecksOptIn`.
- Toast feedback: `toast`.

**Purpose:** Explain permission/status changes, provide app-update information and consent-based update actions, and give transient feedback for user actions.

## 13. Cross-cutting behavior and design considerations

- Light and dark themes.
- Responsive behavior, including sidebar/navigation adaptations on smaller screens.
- Independent scrolling for the sidebar, conversation timeline, and Info/settings panels where applicable.
- Keyboard interaction and focus states.
- Presence, unread, selected, pinned, and active states.
- Empty, loading, error, and success states.
- Permission-sensitive actions and UI.
- Accessible text/background contrast in both themes.
- Consistent spacing, alignment, typography, icon sizing, and responsive overflow behavior.
- Safe clickable URLs.
- Group membership checks for group reads and actions.
- Owner/moderator permissions and member-removal behavior.
- Migration and deletion behavior should be reviewed where affected by feature changes.
- Encrypted-DM privacy: no server-side indexing of DM plaintext or extracted DM URLs.

## How to use this inventory

1. Treat this document as the baseline map of existing UI elements and their purposes.
2. Before redesigning a section, identify its current controls, placement, states, permissions, and dependencies.
3. Separate **existing behavior**, **known defects**, and **proposed redesign** so visual proposals are not mistaken for implemented functionality.
4. Prefer structural redesign when needed; do not treat color or spacing changes alone as completion of a redesigned layout.
5. Update this inventory when the source changes materially, and keep any redesign specification separate from this baseline inventory.
6. Before asking for a consolidated test, ensure the relevant implementation and CI checks are complete. Do not treat a successful build as proof that every UI behavior has passed manual testing.
