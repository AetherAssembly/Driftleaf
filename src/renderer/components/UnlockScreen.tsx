import { useEffect, useState } from "react";
import { Button, Card, Input } from "@aetherAssembly/ui";

interface UnlockScreenProps {
  onUnlocked: () => void;
}

export function UnlockScreen({ onUnlocked }: UnlockScreenProps) {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [mode, setMode] = useState<"create" | "unlock" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastVaultPath, setLastVaultPath] = useState<string | null>(null);

  useEffect(() => {
    void window.driftleaf.settings.read().then((s) => setLastVaultPath(s.lastVaultPath));
  }, []);

  async function openWithoutPassphrase(path: string) {
    setBusy(true);
    setError(null);
    try {
      await window.driftleaf.vault.unlock(path, "");
      onUnlocked();
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

  async function submit() {
    if (!rootPath || !mode) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await window.driftleaf.vault.create(rootPath, passphrase);
      } else {
        await window.driftleaf.vault.unlock(rootPath, passphrase);
      }
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open vault");
    } finally {
      setBusy(false);
    }
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
              onChange={(e) => setPassphrase(e.target.value)}
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
              <Button type="button" variant="ghost" onClick={() => setMode(null)}>
                Back
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
