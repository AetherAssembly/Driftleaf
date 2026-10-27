// Integration test for data loss bug bash
// Uses the actual vault module to verify crash safety mechanisms

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import * as vaultModule from '../../src/main/vault.ts';
import { exportDatabase } from '../../src/main/database-export.ts';
import { parseCsvDatabase, parseJsonDatabase } from '../../src/main/database-import.ts';
import { evaluateFormula } from '../../src/shared/formula.ts';
import { decrypt, unpackPayload } from '../../src/main/crypto.ts';

const testVaultPath = path.join(os.tmpdir(), `driftleaf-test-${Date.now()}`);
const legacyVaultPath = `${testVaultPath}-legacy`;
const recoverySourcePath = `${testVaultPath}-recovery-source`;
const recoveryBackupParent = `${testVaultPath}-backups`;
const recoveryRestorePath = `${testVaultPath}-restored`;

console.log('🧪 Data Loss Bug Bash - Vault Integration Test\n');
console.log(`Test vault path: ${testVaultPath}\n`);

const tests = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    const result = await fn();
    console.log(`${result ? '✓' : '✗'} ${name}`);
    if (!result && result !== undefined) {
      console.log(`  Assertion failed\n`);
      failed++;
    } else if (result === false) {
      failed++;
    } else {
      passed++;
    }
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ERROR: ${e.message}\n`);
    failed++;
  }
}

async function cleanup() {
  try {
    await fs.rm(testVaultPath, { recursive: true, force: true });
    await fs.rm(legacyVaultPath, { recursive: true, force: true });
    await fs.rm(recoverySourcePath, { recursive: true, force: true });
    await fs.rm(recoveryBackupParent, { recursive: true, force: true });
    await fs.rm(recoveryRestorePath, { recursive: true, force: true });
  } catch {}
}

// Test 1: Create vault and verify structure
await test('Vault creation creates required files', async () => {
  await cleanup();
  const vault = await vaultModule.createVault(testVaultPath, 'test-passphrase');
  
  // Check .driftleaf directory
  const driftleafPath = path.join(testVaultPath, '.driftleaf');
  const stats = await fs.stat(driftleafPath).catch(() => null);
  if (!stats?.isDirectory()) return false;
  
  // Check config, manifest, canary
  const configPath = path.join(driftleafPath, 'vault.json');
  const manifestPath = path.join(driftleafPath, 'manifest.enc');
  const canaryPath = path.join(driftleafPath, 'canary.enc');
  
  const configExists = await fs.stat(configPath).catch(() => null);
  const manifestExists = await fs.stat(manifestPath).catch(() => null);
  const canaryExists = await fs.stat(canaryPath).catch(() => null);
  
  return configExists && manifestExists && canaryExists;
});

// Test 2: Verify private metadata is encrypted at rest
await test('Manifest metadata is encrypted at rest', async () => {
  const manifestPath = path.join(testVaultPath, '.driftleaf', 'manifest.enc');
  const data = await fs.readFile(manifestPath);
  return data.length > 28 && !data.toString('utf-8').includes('Welcome to Driftleaf');
});

// Test 3: Verify atomic write - no temp files
await test('Atomic writes leave no temp files', async () => {
  const driftleafPath = path.join(testVaultPath, '.driftleaf');
  const files = await fs.readdir(driftleafPath);
  const tmpFiles = files.filter(f => f.includes('.tmp-'));
  return tmpFiles.length === 0;
});

// Test 4: Create note and verify it's encrypted
await test('Created notes are encrypted on disk', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const note = await vaultModule.createNote(vault, '', 'Test Note');
  
  // Read the encrypted file
  const notePath = path.join(testVaultPath, '.driftleaf', 'notes', `${note.id}.enc`);
  const encData = await fs.readFile(notePath);
  
  // Should be binary (not readable as text)
  const asText = encData.toString('utf-8');
  return !asText.includes('Test Note');
});

// Test 5: Unlock vault verifies passphrase correctly
await test('Vault passphrase verification with wrong key fails', async () => {
  try {
    await vaultModule.unlockVault(testVaultPath, 'wrong-passphrase');
    return false; // Should have thrown
  } catch (e) {
    return e.message.includes('passphrase');
  }
});

// Test 6: Unlock with correct passphrase succeeds
await test('Vault unlocks with correct passphrase', async () => {
  const result = await vaultModule.unlockVault(testVaultPath, 'test-passphrase');
  return result.vault && result.recovery;
});

// Test 7: Write note and verify read returns same content
await test('Note write/read roundtrip preserves content', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const testContent = '# Test\n\nThis is a test note with unicode: 你好世界 🚀';
  const note = await vaultModule.createNote(vault, '', 'Roundtrip Test');
  await vaultModule.writeNote(vault, note.id, testContent);
  const read = await vaultModule.readNote(vault, note.id);
  return read === testContent;
});

// Test 8: Manifest updates reflect on disk
await test('Manifest persistence across unlocks', async () => {
  // Create note and unlock again
  let vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const notesBefore = vault.manifest.notes.length;
  
  // Unlock fresh
  vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const notesAfter = vault.manifest.notes.length;
  
  return notesBefore === notesAfter;
});

// Test 9: Folder operations update manifest
await test('Folder creation persists in manifest', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  await vaultModule.createFolder(vault, 'TestFolder');
  
  // Unlock fresh to verify
  const freshVault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  return freshVault.manifest.folders.includes('TestFolder');
});

// Test 9b: B03 regression — a createFolder() whose manifest write fails must not leave the
// folder visible in memory, or a retry would see it via `includes` and skip the write,
// falsely reporting success while the folder never actually lands on disk.
await test('Failed folder creation rolls back in-memory state (B03)', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const driftleafPath = path.join(testVaultPath, '.driftleaf');
  const movedAway = `${driftleafPath}-away-b03`;
  await fs.rename(driftleafPath, movedAway);
  let threw = false;
  try {
    await vaultModule.createFolder(vault, 'RollbackFolder');
  } catch {
    threw = true;
  } finally {
    await fs.rename(movedAway, driftleafPath);
  }
  const rolledBack = !vault.manifest.folders.includes('RollbackFolder');
  await vaultModule.createFolder(vault, 'RollbackFolder'); // retry, now that writes succeed again
  const freshVault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  return threw && rolledBack && freshVault.manifest.folders.includes('RollbackFolder');
});

// Test 9c: B04 regression — a renameNote() whose manifest write fails must not leave the new
// title visible in memory; listNotes()/search would otherwise disagree with what's on disk.
await test('Failed note rename rolls back in-memory state (B04)', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const note = await vaultModule.createNote(vault, '', 'Original Title');
  const driftleafPath = path.join(testVaultPath, '.driftleaf');
  const movedAway = `${driftleafPath}-away-b04`;
  await fs.rename(driftleafPath, movedAway);
  let threw = false;
  try {
    await vaultModule.renameNote(vault, note.id, 'New Title');
  } catch {
    threw = true;
  } finally {
    await fs.rename(movedAway, driftleafPath);
  }
  const rolledBack = vault.manifest.notes.find(n => n.id === note.id)?.title === 'Original Title';
  await vaultModule.renameNote(vault, note.id, 'New Title'); // retry, now that writes succeed again
  const freshVault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const persisted = freshVault.manifest.notes.find(n => n.id === note.id);
  return threw && rolledBack && persisted?.title === 'New Title';
});

// Test 10: AES-GCM auth tag detects corruption
await test('Corrupted note detected on read', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const note = vault.manifest.notes[0]; // Use first note
  
  if (!note) return true; // Skip if no notes
  
  // Corrupt the file by flipping a bit
  const notePath = path.join(testVaultPath, '.driftleaf', 'notes', `${note.id}.enc`);
  const data = await fs.readFile(notePath);
  data[0] ^= 1; // Flip first bit
  await fs.writeFile(notePath, data);
  
  try {
    await vaultModule.readNote(vault, note.id);
    return false; // Should have thrown
  } catch (e) {
    return e.message.includes('corrupted');
  }
});

// Test 11: Extension code and grants remain encrypted in the vault
await test('Extensions and permissions persist encrypted in the vault', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const source = 'document.body.textContent = "offline extension";';
  const extension = await vaultModule.installExtension(vault, 'Offline helper', source);
  await vaultModule.setExtensionPermissions(vault, extension.id, ['read_notes']);

  const freshVault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const stored = vaultModule.getExtension(freshVault, extension.id);
  const encryptedManifest = await fs.readFile(path.join(testVaultPath, '.driftleaf', 'manifest.enc'));
  return (
    stored?.source === source &&
    stored.permissions.length === 1 &&
    stored.permissions[0] === 'read_notes' &&
    !encryptedManifest.toString('utf-8').includes(source)
  );
});

// Test 12: Extension database access is explicitly scoped and survives an unlock
await test('Extensions persist selected database access', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const database = await vaultModule.createDatabase(
    vault,
    'Private table',
    '',
    [{ id: randomUUID(), name: 'Name', type: 'title' }],
    [],
  );
  const extension = await vaultModule.installExtension(vault, 'Database reader', 'void 0;');
  await vaultModule.setExtensionPermissions(vault, extension.id, ['read_databases'], [database.id]);
  const freshVault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const stored = vaultModule.getExtension(freshVault, extension.id);
  let rejectedInvalidGrant = false;
  try {
    await vaultModule.setExtensionPermissions(freshVault, extension.id, ['read_databases'], ['invalid']);
  } catch (error) {
    rejectedInvalidGrant = error.message.includes('permissions');
  }
  return (
    stored?.permissions.includes('read_databases') &&
    stored.databaseIds.length === 1 &&
    stored.databaseIds[0] === database.id &&
    rejectedInvalidGrant
  );
});

// Test 13: Canvas cards persist encrypted and disappear with their targets
await test('Canvas items persist and are pruned when targets are deleted', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const note = await vaultModule.createNote(vault, '', 'Canvas note');
  const database = await vaultModule.createDatabase(
    vault,
    'Canvas table',
    '',
    [{ id: randomUUID(), name: 'Name', type: 'title' }],
    [],
  );
  const items = [
    { id: randomUUID(), kind: 'note', targetId: note.id, x: 120, y: 80 },
    { id: randomUUID(), kind: 'database', targetId: database.id, x: 460, y: 90 },
  ];
  await vaultModule.updateCanvas(vault, items);
  const freshVault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const persisted = vaultModule.readCanvas(freshVault);
  await vaultModule.deleteNote(freshVault, note.id);
  await vaultModule.deleteDatabase(freshVault, database.id);
  const empty = vaultModule.readCanvas(freshVault);
  return (
    persisted.length === 2 &&
    persisted[0].x === 120 &&
    persisted[1].targetId === database.id &&
    empty.length === 0
  );
});

// Test 14: Multiple properties and calculated columns persist and export cleanly
await test('Database supports multiple properties and formula-preserving JSON roundtrip', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const titleId = randomUUID();
  const doneId = randomUUID();
  const totalId = randomUUID();
  const formulaId = randomUUID();
  const startDateId = randomUUID();
  const endDateId = randomUUID();
  const statusId = randomUUID();
  const tagsId = randomUUID();
  const rowId = randomUUID();
  const properties = [
    { id: titleId, name: 'Task', type: 'title' },
    { id: doneId, name: 'Done', type: 'checkbox' },
    { id: totalId, name: 'Estimate', type: 'number' },
    {
      id: formulaId,
      name: 'Summary',
      type: 'formula',
      formula: 'if(prop("Done"), "Complete", "Open")',
    },
    { id: startDateId, name: 'Start date', type: 'date' },
    { id: endDateId, name: 'End date', type: 'date' },
    { id: statusId, name: 'Status', type: 'select', options: ['To do', 'In progress', 'Done'] },
    { id: tagsId, name: 'Tags', type: 'multi_select', options: ['Planning', 'Review'] },
  ];
  const rows = [{
    id: rowId,
    values: {
      [titleId]: 'Ship, "database" improvements',
      [doneId]: true,
      [totalId]: 3,
      [startDateId]: '2026-10-12',
      [endDateId]: '2026-10-16',
      [statusId]: 'In progress',
      [tagsId]: ['Planning', 'Review'],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }];
  const view = {
    id: randomUUID(),
    name: 'Open tasks',
    type: 'table',
    sortPropertyId: totalId,
    sortDirection: 'descending',
    filters: [{ propertyId: doneId, operator: 'equals', value: 'true' }],
  };
  const galleryView = { id: randomUUID(), name: 'Cards', type: 'gallery' };
  const listView = { id: randomUUID(), name: 'Compact list', type: 'list' };
  const timelineView = {
    id: randomUUID(),
    name: 'Project timeline',
    type: 'timeline',
    datePropertyId: startDateId,
    endDatePropertyId: endDateId,
  };
  const database = await vaultModule.createDatabase(
    vault,
    'Interoperability',
    '',
    properties,
    rows,
    [view, galleryView, listView, timelineView],
    galleryView.id,
  );
  const renamed = await vaultModule.renameDatabase(vault, database.id, 'Renamed interoperability');
  const reopened = await vaultModule.readDatabase(vault, database.id);
  const formula = reopened.properties.find(property => property.id === formulaId);
  const formulaResult = evaluateFormula(formula.formula, name => {
    const property = reopened.properties.find(candidate => candidate.name === name);
    return property ? reopened.rows[0].values[property.id] ?? null : null;
  });
  const exportedJson = await exportDatabase(vault, database.id, 'json');
  const parsed = parseJsonDatabase(exportedJson.content, 'fallback');
  const imported = await vaultModule.createDatabase(
    vault,
    parsed.title,
    '',
    parsed.properties,
    parsed.rows,
    parsed.views,
    parsed.activeViewId,
  );
  const importedData = await vaultModule.readDatabase(vault, imported.id);
  const csv = await exportDatabase(vault, database.id, 'csv');
  const csvParsed = parseCsvDatabase(csv.content, 'CSV roundtrip');
  const manifestBytes = await fs.readFile(path.join(testVaultPath, '.driftleaf', 'manifest.enc'));
  const databaseBytes = await fs.readFile(path.join(testVaultPath, '.driftleaf', `${database.id}.db.enc`));
  const propertiesWithoutTags = reopened.properties.filter(property => property.id !== tagsId);
  const rowsWithoutTags = reopened.rows.map(row => {
    const values = { ...row.values };
    delete values[tagsId];
    return { ...row, values };
  });
  await vaultModule.updateDatabase(
    vault,
    database.id,
    propertiesWithoutTags,
    rowsWithoutTags,
    reopened.views,
    reopened.activeViewId,
  );
  const afterPropertyDelete = await vaultModule.readDatabase(vault, database.id);
  return (
    reopened.properties.length === 8 &&
    renamed.title === 'Renamed interoperability' &&
    reopened.meta.title === 'Renamed interoperability' &&
    reopened.rows[0].values[doneId] === true &&
    reopened.rows[0].values[totalId] === 3 &&
    formulaResult === 'Complete' &&
    importedData.properties.find(property => property.id === formulaId)?.formula === formula.formula &&
    importedData.rows[0].values[totalId] === 3 &&
    importedData.views[0].name === 'Open tasks' &&
    importedData.views.some(savedView => savedView.id === galleryView.id && savedView.type === 'gallery') &&
    importedData.views.some(savedView => savedView.id === listView.id && savedView.type === 'list') &&
    importedData.views.some(savedView =>
      savedView.id === timelineView.id &&
      savedView.type === 'timeline' &&
      savedView.datePropertyId === startDateId &&
      savedView.endDatePropertyId === endDateId
    ) &&
    importedData.properties.find(property => property.id === statusId)?.options?.join(',') === 'To do,In progress,Done' &&
    importedData.properties.find(property => property.id === tagsId)?.options?.join(',') === 'Planning,Review' &&
    importedData.rows[0].values[statusId] === 'In progress' &&
    importedData.rows[0].values[tagsId]?.join(',') === 'Planning,Review' &&
    !afterPropertyDelete.properties.some(property => property.id === tagsId) &&
    !Object.hasOwn(afterPropertyDelete.rows[0].values, tagsId) &&
    importedData.activeViewId === galleryView.id &&
    csv.content.includes('"Ship, ""database"" improvements",true,3,Complete') &&
    csvParsed.rows[0].values[csvParsed.properties.find(property => property.name === 'Task').id] === 'Ship, "database" improvements' &&
    csvParsed.rows[0].values[csvParsed.properties.find(property => property.name === 'Summary').id] === 'Complete' &&
    !manifestBytes.toString('utf-8').includes('Interoperability') &&
    !databaseBytes.toString('utf-8').includes('Ship database improvements')
  );
});

// Test 15: A copied backup validates and can be restored as an independent vault
await test('Community template ZIP imports into its designated encrypted folder', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const archive = new AdmZip();
  archive.addFile('Getting started.md', Buffer.from('# Getting started\n\nTemplate contents.'));
  const result = await vaultModule.importTemplateArchive(vault, archive.toBuffer(), 'Test pack');
  if (result.imported.length !== 1 || result.skipped.length !== 0) return false;
  const note = result.imported[0];
  return (
    note.folderPath === 'Community templates/Test pack' &&
    (await vaultModule.readNote(vault, note.id)) === '# Getting started\n\nTemplate contents.'
  );
});

// Test 16: A copied backup validates and can be restored as an independent vault
await test('Vault backup verifies and restores database contents', async () => {
  await fs.mkdir(recoveryBackupParent, { recursive: true });
  const vault = await vaultModule.createVault(recoverySourcePath, 'recovery-passphrase');
  const titleId = randomUUID();
  const row = {
    id: randomUUID(),
    values: { [titleId]: 'Backup row' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const database = await vaultModule.createDatabase(
    vault,
    'Backup database',
    '',
    [{ id: titleId, name: 'Title', type: 'title' }],
    [row],
  );
  const backupPath = await vaultModule.createVaultBackup(vault, recoveryBackupParent);
  const report = await vaultModule.verifyVaultBackup(backupPath, 'recovery-passphrase');
  await fs.cp(backupPath, recoveryRestorePath, { recursive: true });
  const restored = await vaultModule.unlockVault(recoveryRestorePath, 'recovery-passphrase');
  const restoredDatabase = await vaultModule.readDatabase(restored.vault, database.id);
  return (
    report.checks.every(check => check.status === 'ok') &&
    restoredDatabase.rows[0].values[titleId] === 'Backup row'
  );
});

// Test 17: Migrate a legacy plaintext manifest and named note path
await test('Legacy vault metadata migrates to encrypted opaque paths', async () => {
  await cleanup();
  let vault = await vaultModule.createVault(legacyVaultPath, 'legacy-passphrase');
  const note = await vaultModule.createNote(vault, 'Legacy Folder', 'Secret Legacy Title');
  await vaultModule.writeNote(vault, note.id, 'Legacy note contents survive migration.');

  const driftleafPath = path.join(legacyVaultPath, '.driftleaf');
  const oldManifestPath = path.join(driftleafPath, 'manifest.enc');
  const legacyManifest = JSON.parse(
    decrypt(unpackPayload(await fs.readFile(oldManifestPath)), vault.key).toString('utf-8'),
  );
  const migratedNote = legacyManifest.notes.find((entry) => entry.id === note.id);
  migratedNote.fileName = 'Secret Legacy Title.md.enc';
  const oldFolder = path.join(legacyVaultPath, 'Legacy Folder');
  await fs.mkdir(oldFolder, { recursive: true });
  await fs.rename(
    path.join(driftleafPath, 'notes', `${note.id}.enc`),
    path.join(oldFolder, migratedNote.fileName),
  );
  await fs.writeFile(
    path.join(driftleafPath, 'manifest.json'),
    JSON.stringify(legacyManifest, null, 2),
  );
  await fs.rm(oldManifestPath);

  vault.key.fill(0);
  const result = await vaultModule.unlockVault(legacyVaultPath, 'legacy-passphrase');
  const migrated = result.vault.manifest.notes.find((entry) => entry.id === note.id);
  const encryptedManifest = await fs.readFile(path.join(driftleafPath, 'manifest.enc'));
  const oldManifestExists = await fs
    .access(path.join(driftleafPath, 'manifest.json'))
    .then(() => true)
    .catch(() => false);
  const oldFolderExists = await fs
    .access(oldFolder)
    .then(() => true)
    .catch(() => false);

  return (
    result.recovery.renamedLegacy.includes(note.id) &&
    migrated?.fileName === `${note.id}.enc` &&
    (await vaultModule.readNote(result.vault, note.id)) ===
      'Legacy note contents survive migration.' &&
    !oldManifestExists &&
    !oldFolderExists &&
    !encryptedManifest.toString('utf-8').includes('Secret Legacy Title')
  );
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('✨ All data loss safeguards verified!');
}

await cleanup();
process.exit(failed > 0 ? 1 : 0);
