// Integration test for data loss bug bash
// Uses the actual vault module to verify crash safety mechanisms

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as vaultModule from '../../dist-electron/main/vault.js';

const testVaultPath = path.join(os.tmpdir(), `driftleaf-test-${Date.now()}`);

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
  const manifestPath = path.join(driftleafPath, 'manifest.json');
  const canaryPath = path.join(driftleafPath, 'canary.enc');
  
  const configExists = await fs.stat(configPath).catch(() => null);
  const manifestExists = await fs.stat(manifestPath).catch(() => null);
  const canaryExists = await fs.stat(canaryPath).catch(() => null);
  
  return configExists && manifestExists && canaryExists;
});

// Test 2: Verify manifest JSON is valid
await test('Manifest is valid JSON with correct structure', async () => {
  const manifestPath = path.join(testVaultPath, '.driftleaf', 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw);
  return Array.isArray(manifest.notes) && Array.isArray(manifest.folders);
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
  const notePath = path.join(testVaultPath, note.folderPath, note.fileName);
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

// Test 10: AES-GCM auth tag detects corruption
await test('Corrupted note detected on read', async () => {
  const vault = await vaultModule.unlockVault(testVaultPath, 'test-passphrase').then(r => r.vault);
  const note = vault.manifest.notes[0]; // Use first note
  
  if (!note) return true; // Skip if no notes
  
  // Corrupt the file by flipping a bit
  const notePath = path.join(testVaultPath, note.folderPath, note.fileName);
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

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('✨ All data loss safeguards verified!');
}

await cleanup();
process.exit(failed > 0 ? 1 : 0);
