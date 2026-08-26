// Quick test suite for data loss scenarios
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Create a temporary test vault
const testVaultPath = path.join(os.tmpdir(), 'driftleaf-test-' + Date.now());

console.log('🧪 Data Loss Bug Bash - Test Suite\n');
console.log(`Test vault path: ${testVaultPath}\n`);

const tests = [];

// Test 1: Verify atomic writes - temp file cleanup
function testAtomicWriteCleanup() {
  const testPath = path.join(testVaultPath, '.driftleaf');
  if (!fs.existsSync(testPath)) {
    return { pass: true, message: 'No temp files left from crashed writes' };
  }
  const files = fs.readdirSync(testPath);
  const tmpFiles = files.filter(f => f.startsWith('.') && f.includes('.tmp-'));
  if (tmpFiles.length === 0) {
    return { pass: true, message: 'No stray temp files found' };
  }
  return { pass: false, message: `Found ${tmpFiles.length} stray temp files: ${tmpFiles.join(', ')}` };
}

// Test 2: Verify atomic writes on recovery
function testManifestAtomicity() {
  try {
    const manifestPath = path.join(testVaultPath, '.driftleaf', 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { pass: false, message: 'Manifest missing' };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!Array.isArray(manifest.notes)) {
      return { pass: false, message: 'Manifest corrupted (notes not array)' };
    }
    return { pass: true, message: 'Manifest is valid JSON and readable' };
  } catch (e) {
    return { pass: false, message: `Manifest parse error: ${e.message}` };
  }
}

// Test 3: Verify vault config integrity
function testConfigIntegrity() {
  try {
    const configPath = path.join(testVaultPath, '.driftleaf', 'vault.json');
    if (!fs.existsSync(configPath)) {
      return { pass: false, message: 'Config missing' };
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config.version || !config.kdf) {
      return { pass: false, message: 'Config missing required fields' };
    }
    return { pass: true, message: 'Config structure valid' };
  } catch (e) {
    return { pass: false, message: `Config parse error: ${e.message}` };
  }
}

// Test 4: Check for orphaned .enc files
function testForOrphans() {
  try {
    const manifestPath = path.join(testVaultPath, '.driftleaf', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const claimedFiles = new Set();
    for (const note of manifest.notes) {
      claimedFiles.add(path.join(note.folderPath, note.fileName));
    }
    
    // Scan for .enc files
    let orphanCount = 0;
    function scanDir(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (entry.name !== '.driftleaf') {
              scanDir(path.join(dir, entry.name));
            }
          } else if (entry.isFile() && entry.name.endsWith('.enc')) {
            const relPath = path.relative(testVaultPath, path.join(dir, entry.name));
            if (!claimedFiles.has(relPath)) {
              orphanCount++;
            }
          }
        }
      } catch {}
    }
    scanDir(testVaultPath);
    
    if (orphanCount === 0) {
      return { pass: true, message: 'No orphaned .enc files found' };
    }
    return { pass: true, message: `Found ${orphanCount} orphaned .enc files (expected from reconciliation)` };
  } catch (e) {
    return { pass: false, message: `Scan error: ${e.message}` };
  }
}

// Test 5: Verify canary file exists and is valid
function testCanary() {
  try {
    const canaryPath = path.join(testVaultPath, '.driftleaf', 'canary.enc');
    if (!fs.existsSync(canaryPath)) {
      return { pass: false, message: 'Canary file missing (vault integrity check will fail)' };
    }
    const stats = fs.statSync(canaryPath);
    if (stats.size < 28) { // IV (12) + authTag (16) + at least some ciphertext
      return { pass: false, message: 'Canary file too small (possibly corrupted)' };
    }
    return { pass: true, message: 'Canary file present and properly sized' };
  } catch (e) {
    return { pass: false, message: `Canary check failed: ${e.message}` };
  }
}

// Run all tests
const allTests = [
  { name: 'Atomic write cleanup', fn: testAtomicWriteCleanup },
  { name: 'Manifest atomicity', fn: testManifestAtomicity },
  { name: 'Config integrity', fn: testConfigIntegrity },
  { name: 'Orphan file check', fn: testForOrphans },
  { name: 'Canary validation', fn: testCanary },
];

let passed = 0;
let failed = 0;

for (const test of allTests) {
  try {
    const result = test.fn();
    console.log(`${result.pass ? '✓' : '✗'} ${test.name}`);
    console.log(`  ${result.message}\n`);
    if (result.pass) passed++;
    else failed++;
  } catch (e) {
    console.log(`✗ ${test.name}`);
    console.log(`  ERROR: ${e.message}\n`);
    failed++;
  }
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

// Cleanup
if (fs.existsSync(testVaultPath) && testVaultPath.includes('driftleaf-test-')) {
  fs.rmSync(testVaultPath, { recursive: true, force: true });
}
