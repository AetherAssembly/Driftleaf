# Welcome to Driftleaf

## Local-first, encrypted, yours alone

- Your notes live only on this device (or wherever you point the branch folder) —
  no cloud, no account, no tracking.
- Note content is encrypted at rest with AES-256-GCM. If you set a passphrase,
  it's the only way to unlock the branch — **there is no password reset**. Write
  it down and keep it somewhere safe. You can change it later in Settings, but
  only while the branch is unlocked.
- Note titles, folder names, and database metadata are encrypted too. The app
  decrypts the index only while this branch is unlocked.

## Organization

Notes live in folders, not tags — the sidebar folder tree is private branch
metadata, not the on-disk folder structure. Right-click a folder to rename or delete it;
right-click a note to move it.

Deleted notes and databases go to **Trash** in the sidebar, where you can restore
them for 30 days before they are removed for good.

## Markdown

The editor renders standard markdown inline as you type — the line you're
editing shows raw markdown, everything else shows formatted. Toggle **Source
mode** in the toolbar to see the raw markdown everywhere instead:

- `**bold**`, `*italic*`, `~~strikethrough~~`, `[links](url)`
- `[[Note title]]` links, with backlinks and a note graph
- `# Heading`, `## Subheading`
- Inline code and fenced code blocks (wrap text in backticks)
- `- bullet` or `1. numbered` lists, and `- [ ] checkboxes`

Paste or attach an image or file and it is encrypted into the branch alongside
your notes. Press Ctrl+F (Cmd+F on Mac) to find and replace inside a note, and
Ctrl+K (Cmd+K) to jump to any note or command.

Changes autosave a moment after you stop typing.

## If something goes wrong

Every unlock double-checks the branch against what's actually on disk and
repairs small inconsistencies automatically (e.g. after a crash mid-save). If
a note ever won't decrypt, it's reported as corrupted rather than silently
losing your other notes. See `docs/RECOVERY.md` in the project repo for more.

Delete this note whenever you like — it's a normal note, not a special one.
