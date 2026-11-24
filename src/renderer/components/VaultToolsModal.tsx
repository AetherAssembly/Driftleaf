import { draftWrites } from "../lib/draft-writes";
import { useEffect, useState } from "react";
import { Button, Input, Modal } from "@aetherAssembly/ui";
import type {
  AppDiagnostics,
  AppSettings,
  PlaintextExportResult,
  UnusedAttachments,
  VaultHealthReport,
} from "../../shared/ipc";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface VaultToolsModalProps {
  open: boolean;
  onClose: () => void;
  theme: AppSettings["theme"];
  noteCount: number;
  onOpenAttachments: () => void;
}

function formatDiagnostics(diagnostics: AppDiagnostics, theme: AppSettings["theme"]): string {
  return diagnosticEntries(diagnostics, theme)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

function diagnosticEntries(
  diagnostics: AppDiagnostics,
  theme: AppSettings["theme"],
): Array<[string, string]> {
  const activeTheme =
    theme === "system" ? `${document.documentElement.dataset.theme ?? "light"} (System)` : theme;
  const isWindows = diagnostics.platform === "win32";
  const environmentEntries: Array<[string, string]> = isWindows
    ? []
    : [
        ["Display server", diagnostics.displayServer],
        ["Desktop / compositor", diagnostics.desktopEnvironment],
      ];
  const osRelease =
    diagnostics.osRelease.toLowerCase() === "unknown" ? "Not detected" : diagnostics.osRelease;
  return [
    ["Driftleaf", diagnostics.version],
    [
      isWindows ? "Windows version" : "Operating system",
      isWindows ? osRelease : `${diagnostics.platform} ${osRelease}`,
    ],
    ["Architecture", diagnostics.architecture],
    ...environmentEntries,
    ["Backend runtime", diagnostics.runtime],
    ["Driftleaf theme", activeTheme],
  ];
}

function HealthChecks({ report }: { report: VaultHealthReport }) {
  return (
    <div className="tools-modal__health">
      <p className="settings__about">Checked {new Date(report.checkedAt).toLocaleString()}</p>
      {report.checks.map((check) => (
        <div className={`tools-modal__check tools-modal__check--${check.status}`} key={check.name}>
          <strong>{check.name}</strong>
          <span>{check.details}</span>
        </div>
      ))}
    </div>
  );
}

export function VaultToolsModal({
  open,
  onClose,
  theme,
  noteCount,
  onOpenAttachments,
}: VaultToolsModalProps) {
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [healthReport, setHealthReport] = useState<VaultHealthReport | null>(null);
  const [backupReport, setBackupReport] = useState<VaultHealthReport | null>(null);
  const [createdBackupPath, setCreatedBackupPath] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupNeedsPassphrase, setBackupNeedsPassphrase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<PlaintextExportResult | null>(null);
  const [unusedAttachments, setUnusedAttachments] = useState<UnusedAttachments | null>(null);
  const [attachmentStatus, setAttachmentStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setExportResult(null);
    setAttachmentStatus(null);
    setUnusedAttachments(null);
    // Unsaved edits may be the only place a just-pasted attachment is referenced, so they
    // are written before anything is counted as unused.
    void draftWrites
      .flush()
      .then(() => window.driftleaf.attachments.unused())
      .then(setUnusedAttachments)
      .catch(() => setUnusedAttachments(null));
  }, [open]);

  async function exportPlaintext() {
    setBusy(true);
    setError(null);
    setExportResult(null);
    try {
      await draftWrites.flush();
      setExportResult(await window.driftleaf.vault.exportPlaintext());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export the branch");
    } finally {
      setBusy(false);
    }
  }

  async function removeUnusedAttachments() {
    setBusy(true);
    setError(null);
    setAttachmentStatus(null);
    try {
      await draftWrites.flush();
      const removed = await window.driftleaf.attachments.removeUnused();
      setAttachmentStatus(
        `Removed ${removed.count} unused attachment(s), freeing ${formatBytes(removed.bytes)}.`,
      );
      setUnusedAttachments(await window.driftleaf.attachments.unused());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove unused attachments");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    void window.driftleaf.diagnostics
      .read()
      .then(setDiagnostics)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not read diagnostics"),
      );
  }, [open]);

  async function copyDiagnostics() {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(formatDiagnostics(diagnostics, theme));
      setCopyStatus("Diagnostics copied. They do not include note contents or passphrases.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not copy diagnostics");
    }
  }

  async function runHealthCheck() {
    setBusy(true);
    setError(null);
    setHealthReport(null);
    try {
      setHealthReport(await window.driftleaf.vault.healthCheck());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Branch health check failed");
    } finally {
      setBusy(false);
    }
  }

  async function verifySelectedBackup(path: string, passphrase: string) {
    setBusy(true);
    setError(null);
    setBackupReport(null);
    try {
      setBackupReport(await window.driftleaf.vault.verifyBackup(path, passphrase));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup verification failed");
    } finally {
      setBackupPassphrase("");
      setBusy(false);
    }
  }

  async function chooseBackup() {
    setError(null);
    setBackupReport(null);
    setBackupPath(null);
    setBackupNeedsPassphrase(false);
    setBackupPassphrase("");
    try {
      const path = await window.driftleaf.vault.pickBackupDirectory();
      if (!path) return;
      setBackupPath(path);
      const needsPassphrase = await window.driftleaf.vault.hasPassphrase(path);
      setBackupNeedsPassphrase(needsPassphrase);
      if (!needsPassphrase) await verifySelectedBackup(path, "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not select backup folder");
    }
  }

  async function createBackup() {
    setBusy(true);
    setError(null);
    setCreatedBackupPath(null);
    try {
      const destination = await window.driftleaf.vault.pickBackupDestination();
      if (!destination) return;
      await draftWrites.flush();
      setCreatedBackupPath(await window.driftleaf.vault.createBackup(destination));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create backup");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Diagnostics & Branch Health">
      <div className="tools-modal">
        <section className="settings__panel tools-modal__section">
          <span className="settings__eyebrow">RECOVERY</span>
          <h2>Create a backup</h2>
          <p className="settings__about">
            Copy the open branch, including its hidden encrypted database files, into a new dated
            folder. Existing backups are never overwritten. Choose a destination outside the branch.
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void createBackup()}
          >
            Create backup…
          </Button>
          {createdBackupPath && (
            <p className="settings__about" role="status">
              Backup created at <span className="unlock-screen__path">{createdBackupPath}</span>
            </p>
          )}
        </section>

        <section className="settings__panel tools-modal__section">
          <span className="settings__eyebrow">PORTABILITY</span>
          <h2>Export as plain files</h2>
          <p className="settings__about">
            Writes every note as a Markdown file in its folder, every database as CSV and JSON,
            and every attachment as an ordinary file, packed into one .zip named after this branch
            and the date, in a folder you choose.{" "}
            <strong>The export is not encrypted.</strong> Anyone who can read that file can read
            your notes, so put it somewhere you trust and delete it when you are done. Items in
            Trash are not exported.
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void exportPlaintext()}
          >
            Export unencrypted copy…
          </Button>
          {exportResult && (
            <div className="settings__about" role="status">
              <p>
                Exported {exportResult.notes} note(s), {exportResult.databases} database(s), and{" "}
                {exportResult.attachments} attachment(s) to{" "}
                <span className="unlock-screen__path">{exportResult.path}</span>
              </p>
              {exportResult.skipped.length > 0 && (
                <p className="tools-modal__check--error">
                  Could not export: {exportResult.skipped.join("; ")}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="settings__panel tools-modal__section">
          <span className="settings__eyebrow">STORAGE</span>
          <h2>Unused attachments</h2>
          <p className="settings__about">
            Images and files stay in the branch after the note that used them is edited or
            permanently deleted. This removes attachments that no note refers to, including notes
            in Trash. Anything added in the last 24 hours is always kept.
          </p>
          <p className="settings__about" role="status">
            {attachmentStatus ??
              (unusedAttachments === null
                ? "Checking…"
                : unusedAttachments.count === 0
                  ? "No unused attachments."
                  : `${unusedAttachments.count} unused attachment(s), ${formatBytes(unusedAttachments.bytes)}.`)}
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy || !unusedAttachments || unusedAttachments.count === 0}
            onClick={() => void removeUnusedAttachments()}
          >
            Remove unused attachments
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenAttachments}>
            Manage attachments…
          </Button>
        </section>

        <section className="settings__panel tools-modal__section">
          <span className="settings__eyebrow">APP DETAILS</span>
          <h2>Diagnostics</h2>
          <p className="settings__about">
            Copy safe environment details to include in a bug report. Note contents, branch paths,
            and passphrases are not included.
          </p>
          {diagnostics ? (
            <dl className="tools-modal__diagnostics">
              {diagnosticEntries(diagnostics, theme).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="settings__field">
              <p className="settings__about">Loading diagnostics…</p>
            </div>
          )}
          <div className="settings__actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={!diagnostics}
              onClick={() => void copyDiagnostics()}
            >
              Copy diagnostics
            </Button>
          </div>
          {copyStatus && <p className="settings__about">{copyStatus}</p>}
        </section>

        <section className="settings__panel tools-modal__section">
          <span className="settings__eyebrow">INTEGRITY</span>
          <h2>Branch health</h2>
          <p className="settings__about">
            Checks branch metadata, encrypted note contents, recoverable files, and the search index.
            This may take a while for large branches.
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void runHealthCheck()}
          >
            Run health check ({noteCount} notes)
          </Button>
          {healthReport && <HealthChecks report={healthReport} />}
        </section>

        <section className="settings__panel tools-modal__section">
          <span className="settings__eyebrow">RECOVERY</span>
          <h2>Verify a backup</h2>
          <p className="settings__about">
            Select a copied branch folder to verify its key check, manifest, and encrypted notes.
            Verification does not change the selected folder.
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void chooseBackup()}
          >
            Choose backup folder…
          </Button>
          {backupPath && <p className="tools-modal__path">{backupPath}</p>}
          {backupNeedsPassphrase && (
            <>
              <Input
                type="password"
                label="Backup passphrase"
                value={backupPassphrase}
                onChange={(event) => setBackupPassphrase(event.target.value)}
                hint="Used only to verify this backup; it is not stored."
              />
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={busy}
                onClick={() =>
                  backupPath && void verifySelectedBackup(backupPath, backupPassphrase)
                }
              >
                Verify backup
              </Button>
            </>
          )}
          {backupReport && <HealthChecks report={backupReport} />}
        </section>
        {error && <p className="tools-modal__check--error">{error}</p>}
      </div>
    </Modal>
  );
}
