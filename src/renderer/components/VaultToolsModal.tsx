import { useEffect, useState } from "react";
import { Button, Input, Modal } from "@aetherAssembly/ui";
import type { AppDiagnostics, AppSettings, VaultHealthReport } from "../../shared/ipc";

interface VaultToolsModalProps {
  open: boolean;
  onClose: () => void;
  theme: AppSettings["theme"];
  noteCount: number;
}

function formatDiagnostics(diagnostics: AppDiagnostics, theme: AppSettings["theme"]): string {
  const activeTheme =
    theme === "system" ? `${document.documentElement.dataset.theme ?? "light"} (System)` : theme;
  return [
    `Driftleaf: ${diagnostics.version}`,
    `OS: ${diagnostics.platform} ${diagnostics.osRelease}`,
    `Architecture: ${diagnostics.architecture}`,
    `Display server: ${diagnostics.displayServer}`,
    `Desktop/compositor: ${diagnostics.desktopEnvironment}`,
    `Electron: ${diagnostics.electron}`,
    `Chromium: ${diagnostics.chromium}`,
    `Driftleaf theme: ${activeTheme}`,
  ].join("\n");
}

function HealthChecks({ report }: { report: VaultHealthReport }) {
  return (
    <div>
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

export function VaultToolsModal({ open, onClose, theme, noteCount }: VaultToolsModalProps) {
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [healthReport, setHealthReport] = useState<VaultHealthReport | null>(null);
  const [backupReport, setBackupReport] = useState<VaultHealthReport | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupNeedsPassphrase, setBackupNeedsPassphrase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

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
      setError(err instanceof Error ? err.message : "Vault health check failed");
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

  return (
    <Modal open={open} onClose={onClose} title="Diagnostics & Vault Health">
      <div className="tools-modal">
        <section className="tools-modal__section">
          <strong>Diagnostics</strong>
          <p className="settings__about">
            Copy safe environment details to include in a bug report. Note contents, vault paths,
            and passphrases are not included.
          </p>
          {diagnostics ? (
            <pre className="tools-modal__diagnostics">{formatDiagnostics(diagnostics, theme)}</pre>
          ) : (
            <p className="settings__about">Loading diagnostics…</p>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!diagnostics}
            onClick={() => void copyDiagnostics()}
          >
            Copy Diagnostics
          </Button>
          {copyStatus && <p className="settings__about">{copyStatus}</p>}
        </section>

        <section className="tools-modal__section">
          <strong>Vault health</strong>
          <p className="settings__about">
            Checks vault metadata, encrypted note contents, recoverable files, and the search index.
            This may take a while for large vaults.
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

        <section className="tools-modal__section">
          <strong>Verify a backup</strong>
          <p className="settings__about">
            Select a copied vault folder to verify its key check, manifest, and encrypted notes.
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
          {backupPath && <p className="unlock-screen__path">{backupPath}</p>}
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
