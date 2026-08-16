#!/usr/bin/env node
/**
 * Generate a test vault with N notes for performance benchmarking.
 * Usage: npx ts-node scripts/generateTestVault.ts [noteCount] [outputDir]
 * Example: npx ts-node scripts/generateTestVault.ts 1000 /tmp/test-vault
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

interface GenerateOptions {
  noteCount: number;
  outputDir: string;
  passphrase: string;
}

// Sample markdown content chunks for realistic note generation
const CONTENT_TEMPLATES = [
  "# Lorem Ipsum\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\nUt enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
  "## Meeting Notes\n\n**Date:** {{DATE}}\n**Attendees:** Team\n\n### Discussion Points\n- Point 1\n- Point 2\n- Point 3\n\n### Action Items\n- [ ] Task 1\n- [ ] Task 2",
  "# Project Plan\n\n## Objectives\n- Objective 1\n- Objective 2\n\n## Timeline\n- Week 1: Setup\n- Week 2: Development\n- Week 3: Testing\n\n## Resources\n- Team members\n- Budget allocation",
  "# Daily Log\n\n**Today's Focus:** Work on milestone {{NUM}}\n\n## Completed\n- Task 1\n- Task 2\n\n## In Progress\n- Task 3\n\n## Blocked\n- None",
  "# Code Snippet\n\n```typescript\nfunction example(input: string): void {\n  console.log(`Processing: ${input}`);\n  const result = input.toUpperCase();\n  return result;\n}\n```\n\nThis function demonstrates basic TypeScript syntax.",
];

const FOLDERS = ["Daily", "Projects", "Reference", "Archive", "Ideas"];

function randomContent(index: number): string {
  const template = CONTENT_TEMPLATES[index % CONTENT_TEMPLATES.length];
  return template
    .replace(/{{DATE}}/g, new Date().toISOString().split("T")[0])
    .replace(/{{NUM}}/g, String(Math.floor(index / 10) + 1));
}

function randomFolder(): string {
  return FOLDERS[Math.floor(Math.random() * FOLDERS.length)];
}

async function generateTestVault(options: GenerateOptions): Promise<void> {
  console.log(`Generating test vault with ${options.noteCount} notes...`);

  // Import vault module (requires the app to be built)
  let vaultModule;
  try {
    // Try to import from dist-electron (built output)
    vaultModule = await import("../dist-electron/main/vault.js");
  } catch (e) {
    console.error("Error: Could not import vault module. Make sure to run 'npm run build' first.");
    process.exit(1);
  }

  const { createVault, createNote } = vaultModule;

  try {
    // Create vault
    console.log(`Creating vault at ${options.outputDir}`);
    fs.mkdirSync(options.outputDir, { recursive: true });

    const vault = await createVault(options.outputDir, options.passphrase);
    console.log("Vault created.");

    // Generate notes
    const startTime = Date.now();
    for (let i = 0; i < options.noteCount; i++) {
      const folder = randomFolder();
      const title = `Note ${i + 1}: ${crypto.randomBytes(4).toString("hex")}`;
      const content = randomContent(i);

      try {
        await createNote(vault, folder, title);
        // Read the note and write content
        const notes = vault.listNotes(folder);
        const lastNote = notes[notes.length - 1];
        vault.writeNote(lastNote.id, content);
      } catch (err) {
        console.error(`Error creating note ${i + 1}:`, err);
      }

      if ((i + 1) % 100 === 0) {
        const elapsed = Date.now() - startTime;
        const rate = (i + 1) / (elapsed / 1000);
        console.log(`  ${i + 1}/${options.noteCount} notes (${rate.toFixed(1)} notes/sec)`);
      }
    }

    const totalTime = Date.now() - startTime;
    const avgTime = totalTime / options.noteCount;
    console.log(`\nSuccess! Generated ${options.noteCount} notes in ${totalTime}ms (avg ${avgTime.toFixed(2)}ms/note)`);
    console.log(`Test vault saved to: ${options.outputDir}`);
  } catch (err) {
    console.error("Error generating test vault:", err);
    process.exit(1);
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
const noteCount = args[0] ? parseInt(args[0], 10) : 1000;
const outputDir = args[1] || `/tmp/driftleaf-test-${noteCount}`;
const passphrase = "testpass123";

if (!Number.isFinite(noteCount) || noteCount <= 0) {
  console.error("Invalid note count. Usage: generateTestVault.ts [noteCount] [outputDir]");
  process.exit(1);
}

console.log(`Test Vault Generator`);
console.log(`  Note Count: ${noteCount}`);
console.log(`  Output Directory: ${outputDir}`);
console.log(`  Passphrase: ${passphrase}`);
console.log("");

generateTestVault({ noteCount, outputDir, passphrase }).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
