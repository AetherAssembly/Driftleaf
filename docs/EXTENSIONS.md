# Extensions

Extensions add local features using JavaScript files. They are stored inside
the encrypted vault manifest and never downloaded by Driftleaf.

## Installing and Running

1. Open **Extensions** in the sidebar and choose **Install JavaScript extension**.
2. Select a `.js` file smaller than 512 KB.
3. Grant only the capabilities the extension needs; all capabilities start off.
4. Choose **Run** to open the extension in its own window.

Removing an extension also closes its open windows. Changing or removing a
permission takes effect on the next API request.

## Available API

The isolated window receives a `window.driftleafExtension` object from a
dedicated preload bridge:

```js
const notes = await window.driftleafExtension.listNotes();
const content = await window.driftleafExtension.readNote(notes[0].id);
const graph = await window.driftleafExtension.graph();
const databases = await window.driftleafExtension.listDatabases();
const data = await window.driftleafExtension.readDatabase(databases[0].id);
```

- `listNotes()` returns note IDs, titles, folder paths, and update timestamps.
- `readNote(id)` returns the decrypted Markdown content for a note.
- `graph()` returns note metadata and resolved links and mentions.
- `listDatabases()` returns only explicitly selected databases.
- `readDatabase(id)` returns properties and rows for an explicitly selected
  database. Relation properties and dependent rollups are omitted unless their
  related database is also selected.

`listNotes()` and `readNote()` require **Read note titles, folders, and
contents**. `graph()` requires **Read note graph and links**.
`listDatabases()` and `readDatabase(id)` require **Read selected databases**
and a separate per-database grant. Calls without the required grant fail with
an error. The API is read-only: extensions cannot write notes or databases,
access settings, file paths, or arbitrary IPC.

## Starter Gallery and SDK

The in-app starter gallery contains small, source-reviewed examples (a vault
note count and a selected-database summary). They are installed into the
encrypted manifest like other extensions and start with no permissions.

Use `window.driftleafExtension` as the extension SDK. Its API is promise-based,
read-only, and scoped to the grants shown in **Extensions**. API calls should
handle permission-denied errors and missing notes/databases; extensions should
not assume they have been granted access.

## Isolation and Trust

Extension windows use Electron sandboxing, context isolation, no Node
integration, a unique non-persistent session, and a restrictive CSP. Network
connections, external resources, popups, and navigation are disabled. API
requests are authorized by the main process against the extension's current
encrypted permissions; the extension renderer does not receive the regular
application preload or unrestricted vault API.

Extensions are still executable code from a source you choose. Review code
before installing it, grant only the capabilities needed, and do not use
extensions from sources you do not trust. A malicious extension with note
access can read and process the data covered by that permission while it is
running. The extension host is not a defense against vulnerabilities in
Electron or the operating system.
