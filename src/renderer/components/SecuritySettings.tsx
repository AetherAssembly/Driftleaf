import { useEffect, useId, useState } from "react";
import { Button, Input, Modal } from "@aetherAssembly/ui";
import { AUTO_LOCK_MINUTES_OPTIONS, type AppSettings } from "../../shared/ipc";

interface SecuritySettingsProps {
  settings: AppSettings;
  onPatch: (update: Partial<AppSettings>) => void;
}

function autoLockLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes === 60) return "After 1 hour";
  return minutes === 1 ? "After 1 minute" : `After ${minutes} minutes`;
}

// Auto-lock and passphrase change, shown in Settings → Branch. The passphrase fields live
// only in this component's state while the dialog is open and are cleared on every close.
export function SecuritySettings({ settings, onPatch }: SecuritySettingsProps) {
  const autoLockId = useId();
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (changing) return;
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setBusy(false);
  }, [changing]);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = !busy && next.trim().length > 0 && next === confirm;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await window.driftleaf.vault.changePassphrase(current, next);
      setDone(true);
      setChanging(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the passphrase");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings__field">
        <label className="security__label" htmlFor={autoLockId}>
          Lock this branch automatically
        </label>
        <select
          id={autoLockId}
          className="security__select"
          value={settings.autoLockMinutes}
          onChange={(event) => onPatch({ autoLockMinutes: Number(event.target.value) })}
        >
          {AUTO_LOCK_MINUTES_OPTIONS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {autoLockLabel(minutes)}
            </option>
          ))}
        </select>
        <p className="settings__hint">
          Counts time with no typing, clicking, or scrolling in Driftleaf. Unsaved edits are
          saved first; if they cannot be saved the branch stays open.
        </p>
      </div>

      <div className="settings__tools-card">
        <div>
          <strong>Passphrase</strong>
          <p>
            {done
              ? "Passphrase changed. Use the new one the next time you unlock this branch."
              : "Change the passphrase that unlocks this branch."}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setDone(false);
            setChanging(true);
          }}
        >
          Change passphrase…
        </Button>
      </div>

      <Modal open={changing} onClose={() => setChanging(false)} title="Change passphrase">
        <form className="security__form" onSubmit={(event) => void submit(event)}>
          <Input
            autoFocus
            type="password"
            label="Current passphrase"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <Input
            type="password"
            label="New passphrase"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Input
            type="password"
            label="Confirm new passphrase"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={mismatch ? "The two new passphrases do not match." : undefined}
          />
          <ul className="security__notes">
            <li>There is still no reset. If you forget the new passphrase, the notes are gone.</li>
            <li>
              Backups and copies of this branch made before now keep the old passphrase. Make a
              fresh backup afterwards.
            </li>
            <li>
              Your notes are not re-encrypted, so this is quick. If you think someone has both
              the old passphrase and a copy of this branch, changing it here does not lock them
              out of that copy.
            </li>
          </ul>
          {error && (
            <p className="security__error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!canSubmit} loading={busy}>
              Change passphrase
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
