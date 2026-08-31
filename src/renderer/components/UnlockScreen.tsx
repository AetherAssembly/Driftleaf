import { useEffect, useState } from "react";
import { Button, Card, Input, Modal } from "@aetherAssembly/ui";
import type { VaultRecoveryReport } from "../../shared/ipc";

interface UnlockScreenProps {
  onUnlocked: (recovery?: VaultRecoveryReport) => void;
}

export function UnlockScreen({ onUnlocked }: UnlockScreenProps) {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [mode, setMode] = useState<"create" | "unlock" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastVaultPath, setLastVaultPath] = useState<string | null>(null);
  const [confirmingNoRecovery, setConfirmingNoRecovery] = useState(false);
  const [acknowledgedNoRecovery, setAcknowledgedNoRecovery] = useState(false);

  useEffect(() => {
    void window.driftleaf.settings.read().then((s) => setLastVaultPath(s.lastVaultPath));
  }, []);

  async function openWithoutPassphrase(path: string) {
    setBusy(true);
    setError(null);
    try {
      const recovery = await window.driftleaf.vault.unlock(path, "");
      onUnlocked(recovery);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open vault");
      setRootPath(path);
      setMode("unlock");
    } finally {
      setBusy(false);
    }
  }

  async function choosePath(next: "create" | "unlock") {
    const picked = await window.driftleaf.vault.pickDirectory();
    if (!picked) return;
    setError(null);

    if (next === "unlock") {
      const needsPassphrase = await window.driftleaf.vault.hasPassphrase(picked);
      if (!needsPassphrase) {
        await openWithoutPassphrase(picked);
        return;
      }
    }

    setRootPath(picked);
    setMode(next);
  }

  async function performSubmit() {
    if (!rootPath || !mode) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await window.driftleaf.vault.create(rootPath, passphrase);
        onUnlocked();
      } else {
        const recovery = await window.driftleaf.vault.unlock(rootPath, passphrase);
        onUnlocked(recovery);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open vault");
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (mode === "create" && passphrase && !acknowledgedNoRecovery) {
      setConfirmingNoRecovery(true);
      return;
    }
    void performSubmit();
  }

  function confirmNoRecovery() {
    setConfirmingNoRecovery(false);
    setAcknowledgedNoRecovery(true);
    void performSubmit();
  }

  return (
    <div className="unlock-screen">
      <Card header={<h1>Driftleaf</h1>}>
        {!mode ? (
          <div className="unlock-screen__actions">
            {lastVaultPath && (
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void openWithoutPassphrase(lastVaultPath)}
              >
                Reopen {lastVaultPath.split("/").pop()}
              </Button>
            )}
            <Button
              variant={lastVaultPath ? "secondary" : "primary"}
              loading={busy}
              onClick={() => choosePath("create")}
            >
              Create a new vault
            </Button>
            <Button variant="secondary" loading={busy} onClick={() => choosePath("unlock")}>
              Open an existing vault
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="unlock-screen__path">{rootPath}</p>
            <Input
              type="password"
              label="Passphrase (optional)"
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                // A prior "I understand, create vault" acknowledgment was for the
                // passphrase that was in the field at the time — editing it afterward
                // (e.g. retrying after a failed create) shouldn't carry that acknowledgment
                // over to a passphrase the user never actually confirmed.
                setAcknowledgedNoRecovery(false);
              }}
              error={error ?? undefined}
              hint={
                mode === "create"
                  ? passphrase
                    ? "There is no password recovery — write this down somewhere safe."
                    : "No passphrase — anyone with access to this device can open this vault."
                  : undefined
              }
            />
            <div className="unlock-screen__actions">
              <Button type="submit" variant="primary" loading={busy}>
                {mode === "create"
                  ? passphrase
                    ? "Create vault"
                    : "Create vault without a passphrase"
                  : "Unlock"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setMode(null);
                  setAcknowledgedNoRecovery(false);
                }}
              >
                Back
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Modal
        open={confirmingNoRecovery}
        onClose={() => setConfirmingNoRecovery(false)}
        title="This passphrase cannot be recovered"
      >
        <p>
          Driftleaf never stores or transmits your passphrase. If you forget it, there is no
          reset — your notes cannot be recovered.
        </p>
        <p>Write it down and keep it somewhere safe before you continue.</p>
        <div className="modal-actions">
          <Button variant="ghost" size="sm" onClick={() => setConfirmingNoRecovery(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={confirmNoRecovery}>
            I understand, create vault
          </Button>
        </div>
      </Modal>
    </div>
  );
}
