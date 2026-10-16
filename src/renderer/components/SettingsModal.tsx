import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal } from "@aetherAssembly/ui";
import type { AppSettings, UpdateStatus } from "../../shared/ipc";

type SettingsTab = "appearance" | "editor" | "updates" | "vault" | "about";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onOpenTools: () => void;
  settings: AppSettings;
  updateStatus: UpdateStatus;
  onCheckUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onOpenUpdateDownload: () => void;
  onPatch: (update: Partial<AppSettings>) => void;
}

export function SettingsModal({
  open,
  onClose,
  onOpenTools,
  settings,
  updateStatus,
  onCheckUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenUpdateDownload,
  onPatch,
}: SettingsModalProps) {
  const [fontSize, setFontSize] = useState(settings.editorFontSizePx);
  const [autosave, setAutosave] = useState(settings.autosaveIntervalMs);
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const fontDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setFontSize(settings.editorFontSizePx);
    setAutosave(settings.autosaveIntervalMs);
  }, [settings.editorFontSizePx, settings.autosaveIntervalMs]);

  useEffect(
    () => () => {
      if (fontDebounce.current) clearTimeout(fontDebounce.current);
      if (autosaveDebounce.current) clearTimeout(autosaveDebounce.current);
    },
    [],
  );

  function handleFontSize(value: number) {
    setFontSize(value);
    if (fontDebounce.current) clearTimeout(fontDebounce.current);
    fontDebounce.current = setTimeout(() => onPatch({ editorFontSizePx: value }), 300);
  }

  function handleAutosave(value: number) {
    setAutosave(value);
    if (autosaveDebounce.current) clearTimeout(autosaveDebounce.current);
    autosaveDebounce.current = setTimeout(() => onPatch({ autosaveIntervalMs: value }), 300);
  }

  const themes: Array<{ value: AppSettings["theme"]; label: string; color: string }> = [
    { value: "system", label: "System", color: "linear-gradient(135deg,#f8faf8 50%,#24352a 50%)" },
    { value: "light", label: "Light", color: "#f3f5f2" },
    { value: "dark", label: "Dark", color: "#1a211c" },
    { value: "aquatic", label: "Aquatic", color: "#10262d" },
    { value: "mossy", label: "Mossy", color: "#1e2819" },
    { value: "sunset", label: "Sunset", color: "#302026" },
    { value: "space", label: "Space", color: "#171b35" },
    { value: "cherry", label: "Cherry", color: "#321c26" },
    { value: "arctic", label: "Arctic", color: "#142633" },
    { value: "amber", label: "Amber", color: "#302516" },
  ];
  const tabs: Array<{ id: SettingsTab; label: string; detail: string }> = [
    { id: "appearance", label: "Appearance", detail: "Theme and color" },
    { id: "editor", label: "Editor", detail: "Writing preferences" },
    { id: "updates", label: "Updates", detail: "Version and releases" },
    { id: "vault", label: "Branch", detail: "Privacy and diagnostics" },
    { id: "about", label: "About", detail: "Driftleaf information" },
  ];
  const lastVaultName = settings.lastVaultPath
    ? (settings.lastVaultPath.split(/[\\/]/).pop() ?? settings.lastVaultPath)
    : null;
  const busy = updateStatus.state === "checking" || updateStatus.state === "downloading";

  return (
    <Modal open={open} onClose={onClose} title="Settings">
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings sections">
          {tabs.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`settings__nav-item${tab === item.id ? " settings__nav-item--active" : ""}`}
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? "page" : undefined}
            >
              <span>{item.label}</span>
              <small>{item.detail}</small>
            </button>
          ))}
        </nav>
        <div className="settings__content">
          {tab === "appearance" && (
            <section className="settings__panel">
              <div>
                <span className="settings__eyebrow">PERSONALIZE</span>
                <h2>Make Driftleaf yours</h2>
                <p>Choose a comfortable color palette. Your choice follows you between sessions.</p>
              </div>
              <div className="settings__theme-grid" role="group" aria-label="Color theme">
                {themes.map((theme) => (
                  <button
                    type="button"
                    key={theme.value}
                    className={`settings__theme-card${settings.theme === theme.value ? " settings__theme-card--active" : ""}`}
                    onClick={() => onPatch({ theme: theme.value })}
                    aria-pressed={settings.theme === theme.value}
                  >
                    <span className="settings__theme-swatch" style={{ background: theme.color }}>
                      <span />
                    </span>
                    <span>{theme.label}</span>
                  </button>
                ))}
              </div>
              <p className="settings__hint">
                System follows your operating-system color preference. The remaining palettes are
                dark themes.
              </p>
            </section>
          )}

          {tab === "editor" && (
            <section className="settings__panel">
              <span className="settings__eyebrow">WRITING</span>
              <h2>Editor preferences</h2>
              <p>Set up a writing space that feels right.</p>
              <div className="settings__field">
                <Input
                  type="number"
                  label="Editor font size"
                  value={fontSize}
                  min={12}
                  max={24}
                  onChange={(event) => handleFontSize(Number(event.target.value))}
                  hint="12–24 px. Applies to the markdown editor pane."
                />
              </div>
              <div className="settings__field">
                <Input
                  type="number"
                  label="Autosave delay"
                  value={autosave}
                  min={200}
                  max={5000}
                  onChange={(event) => handleAutosave(Number(event.target.value))}
                  hint="200–5000 ms after you stop typing."
                />
              </div>
            </section>
          )}

          {tab === "updates" && (
            <section className="settings__panel">
              <span className="settings__eyebrow">STAY CURRENT</span>
              <h2>Software updates</h2>
              <div className="settings__update-card">
                <div className="settings__update-mark" aria-hidden="true">↻</div>
                <div>
                  <strong>Driftleaf {updateStatus.currentVersion}</strong>
                  <p>{updateStatus.message}</p>
                  {updateStatus.availableVersion && (
                    <p className="settings__update-version">
                      Available version <strong>{updateStatus.availableVersion}</strong>
                    </p>
                  )}
                </div>
              </div>
              <div className="settings__actions">
                <Button variant="secondary" size="sm" onClick={onCheckUpdates} loading={busy}>
                  Check for updates
                </Button>
                {updateStatus.state === "available" &&
                  (updateStatus.automaticInstall ? (
                    <Button variant="primary" size="sm" onClick={onDownloadUpdate}>
                      Download update
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" onClick={onOpenUpdateDownload}>
                      Download release
                    </Button>
                  ))}
                {updateStatus.state === "downloaded" && (
                  <Button variant="primary" size="sm" onClick={onInstallUpdate}>
                    Restart to install
                  </Button>
                )}
                {updateStatus.state === "error" && updateStatus.downloadUrl && (
                  <Button variant="ghost" size="sm" onClick={onOpenUpdateDownload}>
                    Open release page
                  </Button>
                )}
              </div>
              <label className="settings__check-row">
                <input
                  type="checkbox"
                  checked={settings.checkUpdatesAutomatically}
                  onChange={(event) =>
                    onPatch({ checkUpdatesAutomatically: event.target.checked })
                  }
                />
                Check for updates automatically when Driftleaf starts
              </label>
              <p className="settings__hint">
                {updateStatus.automaticInstall
                  ? "Updates can be downloaded and installed in-app on this platform."
                  : "Updates are detected here and installed manually."}
              </p>
            </section>
          )}

          {tab === "vault" && (
            <section className="settings__panel">
              <span className="settings__eyebrow">YOUR PRIVATE SPACE</span>
              <h2>Branch and privacy</h2>
              <p>
                Notes and branch metadata are encrypted at rest. Driftleaf does not sync or send
                branch contents anywhere.
              </p>
              {lastVaultName && (
                <div className="settings__vault-card">
                  <div>
                    <small>LAST OPENED BRANCH</small>
                    <strong title={settings.lastVaultPath ?? ""}>{lastVaultName}</strong>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => onPatch({ lastVaultPath: null })}>
                    Forget
                  </Button>
                </div>
              )}
              <div className="settings__tools-card">
                <div>
                  <strong>Diagnostics &amp; Branch Health</strong>
                  <p>Inspect app details, check branch integrity, and verify backups.</p>
                </div>
                <Button variant="secondary" size="sm" onClick={onOpenTools}>
                  Open tools
                </Button>
              </div>
              <p className="settings__hint">
                There is no passphrase reset. Keep a secure backup of your passphrase and branch.
              </p>
            </section>
          )}

          {tab === "about" && (
            <section className="settings__panel settings__about-panel">
              <div className="settings__brand-mark" aria-hidden="true">D</div>
              <span className="settings__eyebrow">LOCAL-FIRST · ENCRYPTED · YOURS</span>
              <h2>Driftleaf</h2>
              <p className="settings__version-pill">Version {updateStatus.currentVersion}</p>
              <p>
                A calm, private place for notes, connected ideas, and flexible databases.
                Everything stays in your encrypted branch.
              </p>
              <Button variant="ghost" size="sm" onClick={onCheckUpdates} loading={busy}>
                Check for updates
              </Button>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}
