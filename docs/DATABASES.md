# Databases

Driftleaf can import CSV and JSON data as encrypted, editable databases. Databases
appear in the vault's folder in the sidebar and open in a table view. Their rows
and property definitions are stored encrypted in the vault; they are not
converted into Markdown notes.

## Import a database

Choose **Import** and select a `.csv`, `.json`, or `.zip` file. CSV and JSON
files can be selected directly or included in a ZIP archive. Import places each
database in the currently selected vault folder. ZIP paths are preserved as
vault folders. Markdown files in the same import can be imported alongside
databases.

- **CSV:** the header row becomes the property names. Driftleaf infers common
  number, checkbox, date, and URL fields, and recognizes common header names
  such as `tags`, `status`, `email`, and `phone`. A `Name` or `Title` column is
  used as the title property when present; otherwise, the first column becomes
  the title. Other cells retain their imported values.
- **JSON:** accepts an array of row objects, or an object containing a `data`,
  `results`, or `records` array. Common Notion-style property values and type
  hints are normalized where supported.
- **ZIP:** imports `.md`, `.csv`, and `.json` entries and retains their
  archive-relative folder paths. Other entry types are ignored. To limit
  resource use, each imported CSV or JSON file may be up to 20 MiB, and a ZIP
  archive may contain up to 20,000 entries.

If an item cannot be imported, Driftleaf reports it as skipped while continuing
with other selected files or archive entries.

## Edit a table

- Use **+ Row** to add a row. Edit the cells directly in the table; changes are
  saved to the encrypted database.
- Use **+ Property** to add a property. Supported property types include text,
  title, number, checkbox, date, select, multi-select, URL, email, phone,
  people, files, formula, relation, and rollup.
- Use **Delete** on a row to remove it. References to that row in relation
  properties are cleared.
- Use **Delete database** to remove the database. Driftleaf prevents deletion
  while another database has a relation to it.

## Formulas

Create a **formula** property, then choose **Formula** in its cell or **Edit
formula** in the column header. Reference a property by name with
`prop("Property name")`. For example:

```text
if(prop("Done"), "Complete", "Open")
```

The safe formula evaluator supports arithmetic and comparison operators,
`&&`, `||`, `!`, property references, and common functions including
`if`, `ifs`, `and`, `or`, `not`, `empty`, `length`, `contains`, `startsWith`,
`endsWith`, `replace`, `replaceAll`, `lower`, `upper`, `trim`, `abs`, `ceil`,
`floor`, `round`, `min`, `max`, `sum`, `average`, `mod`, `pow`, `sqrt`, `sign`,
`join`, `slice`, `concat`, `toNumber`, `toString`, `format`, `now`, `today`,
`dateAdd`, `dateSubtract`, `dateBetween`, `dateStart`, `dateEnd`, and
`formatDate`.

Formula results are calculated in the table and are not written back into row
cells. Errors appear in the affected formula cell. This is a common-functions
subset, not full Notion formula-language compatibility.

## Relations and rollups

Create a **relation** property and choose another Driftleaf database. Select
one or more rows in the relation cell. A **rollup** property can use an existing
relation and a property from its linked database, with `show_original`, `count`,
`sum`, `average`, `min`, or `max` calculation.

Notion CSV exports do not include formula definitions. JSON exports may contain
formula results, but those results do not restore the original formula
definition. Separately imported Notion databases are not connected
automatically: recreate their relation properties in Driftleaf. Relations are
not required for importing and browsing the source CSV or JSON data.

## Privacy and backups

The manifest stores database titles, IDs, folder paths, and timestamps in
plaintext so Driftleaf can list databases. Property definitions and row values
are encrypted together in `.driftleaf/<database-id>.db.enc` with the vault key.
When backing up a vault, copy the complete vault folder, including the hidden
`.driftleaf/` directory. Health checks and backup verification also validate
encrypted database files.

The database index metadata is stored in `manifest.json`. Unlike Markdown notes,
database files cannot currently be re-indexed automatically if that manifest is
lost. Restore the manifest or `.driftleaf/` directory from a backup; see
[Vault Recovery](RECOVERY.md).
