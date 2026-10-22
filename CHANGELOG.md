# Changelog

All notable changes to LocalChat are documented here. The dedicated release notes are also published with each GitHub release.

## [3.0.123] — Build 123

LocalChat 3.0.123 brings the chat information panel, profile and settings improvements, group/channel management updates, and a refreshed Windows release package.

## Chat and shared content
- Added a WhatsApp-style information panel for private and group chats.
- Improved shared Media, Links, and Files summaries and item browsing, including link and file listing fixes.
- Improved compact media previews and the handling of shared-content counts.
- Kept links clickable in chat and supported links in channel descriptions.

## Profiles and settings
- Added editable usernames with uniqueness checks and editable user designations.
- Added profile-picture upload and predefined avatar choices.
- Consolidated appearance, notification, account-security, and logout controls in Settings.
- Preserved the selected light/dark theme.

## Channels, groups, and messaging
- Added channel-name editing and improved channel-description editing.
- Added group-wide @all mentions.
- Improved message action toolbar placement and interaction, including reply, forward, and reactions.
- Improved pinned-message controls and visibility for group conversations.

## Administration and reliability
- Improved the admin user list so persisted historical accounts are not omitted when the in-memory list is incomplete.
- Added database migration support for the new profile and group metadata.
- Added Rust test execution to continuous integration.
- Embedded the LocalChat icon in the Windows executable and published a SHA-256 checksum alongside the installer executable.

## HTTPS certificate limitation
LocalChat uses a local certificate authority for HTTPS on private networks. This does **not** automatically make other devices trust the certificate. Browsers can still show `ERR_CERT_AUTHORITY_INVALID` until the LocalChat CA certificate is trusted on each connecting device. Do not bypass certificate warnings on a connection you have not verified. See [the LAN HTTPS trust guide](../../docs/lan-https-trust.md).

## Credits
LocalChat is maintained by Md. Imran Islam and retains attribution to the original project by Bipul Raman. Released under the MIT License.

## [2.0.1] — Build 1

### Added
- Search channel message history with match navigation and highlighting.
- Pin and unpin channel messages.
- A mention-jump button for messages that mention the current user.
- In-app release notes in About.
- Optional update checks, controlled by the host in About.

### Improved
- Message action toolbar placement and viewport handling.
- Windows update integrity checks using SHA-256.
- Update installation remains explicit: the app never silently installs or restarts.

### Credits
- Maintains attribution to the original LocalChat project by Bipul Raman.
