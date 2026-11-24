import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal } from "@aetherAssembly/ui";
import type { AppSettings, BranchPersonalization, UpdateStatus } from "../../shared/ipc";
import { SecuritySettings } from "./SecuritySettings";

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
  onPatch: (update: Partial<AppSettings>) => Promise<void>;
  personalization: BranchPersonalization;
  onSavePersonalization: (value: BranchPersonalization) => Promise<void>;
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
  personalization,
  onSavePersonalization,
}: SettingsModalProps) {
  const [fontSize, setFontSize] = useState(settings.editorFontSizePx);
  const [autosave, setAutosave] = useState(settings.autosaveIntervalMs);
  const [customCss, setCustomCss] = useState(settings.customCss);
  const [customCssStatus, setCustomCssStatus] = useState<string | null>(null);
  const [customCssBusy, setCustomCssBusy] = useState(false);
  const [displayName, setDisplayName] = useState(personalization.displayName);
  const [greetingLines, setGreetingLines] = useState(personalization.greetingLines.join("\n"));
  const [personalizationStatus, setPersonalizationStatus] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const fontDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setFontSize(settings.editorFontSizePx);
    setAutosave(settings.autosaveIntervalMs);
  }, [settings.editorFontSizePx, settings.autosaveIntervalMs]);

  useEffect(() => {
    setCustomCss(settings.customCss);
  }, [settings.customCss]);

  useEffect(() => {
    setDisplayName(personalization.displayName);
    setGreetingLines(personalization.greetingLines.join("\n"));
  }, [personalization]);

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
    fontDebounce.current = setTimeout(() => void patchSettings({ editorFontSizePx: value }), 300);
  }

  function handleAutosave(value: number) {
    setAutosave(value);
    if (autosaveDebounce.current) clearTimeout(autosaveDebounce.current);
    autosaveDebounce.current = setTimeout(
      () => void patchSettings({ autosaveIntervalMs: value }),
      300,
    );
  }

  async function patchSettings(update: Partial<AppSettings>) {
    try {
      await onPatch(update);
      setSettingsError(null);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveCustomCss(css: string) {
    setCustomCssBusy(true);
    setCustomCssStatus(null);
    try {
      await onPatch({ customCss: css });
      setCustomCssStatus(css ? "Custom CSS applied." : "Custom CSS cleared.");
    } catch (error) {
      setCustomCssStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomCssBusy(false);
    }
  }

  async function savePersonalization() {
    setPersonalizationStatus(null);
    try {
      await onSavePersonalization({
        displayName,
        greetingLines: greetingLines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      });
      setPersonalizationStatus("Personalization saved to this encrypted branch.");
    } catch (error) {
      setPersonalizationStatus(error instanceof Error ? error.message : String(error));
    }
  }

  const themes: Array<{
    value: AppSettings["theme"];
    label: string;
    color: string;
    accent: string;
  }> = [
    { value: "system", label: "System", color: "linear-gradient(135deg,#f8faf8 50%,#24352a 50%)", accent: "#4f7a5c" },
    { value: "light", label: "Light", color: "#f3f5f2", accent: "#4f7a5c" },
    { value: "dark", label: "Dark", color: "#1a211c", accent: "#78a886" },
    { value: "aquatic", label: "Aquatic", color: "#10262d", accent: "#3bbfc0" },
    { value: "mossy", label: "Mossy", color: "#1e2819", accent: "#9bbd72" },
    { value: "sunset", label: "Sunset", color: "#302026", accent: "#ff9f6e" },
    { value: "space", label: "Space", color: "#171b35", accent: "#a89cff" },
    { value: "cherry", label: "Cherry", color: "#321c26", accent: "#f28caf" },
    { value: "arctic", label: "Arctic", color: "#142633", accent: "#72c9e8" },
    { value: "amber", label: "Amber", color: "#302516", accent: "#efb957" },
  ];
  const tabs: Array<{ id: SettingsTab; label: string; detail: string }> = [
    { id: "appearance", label: "Appearance", detail: "Theme and color" },
    { id: "editor", label: "Editor", detail: "Writing preferences" },
    { id: "updates", label: "Updates", detail: "Version and releases" },
    { id: "vault", label: "Branch", detail: "Security and diagnostics" },
    { id: "about", label: "About", detail: "Driftleaf information" },
  ];
  const lastVaultName = settings.lastVaultPath
    ? (settings.lastVaultPath.split(/[\\/]/).pop() ?? settings.lastVaultPath)
    : null;
  const busy = updateStatus.state === "checking" || updateStatus.state === "downloading";
  const activeTheme =
    settings.theme === "system" ? (document.documentElement.dataset.theme ?? "light") : settings.theme;
  const defaultAccent =
    themes.find((theme) => theme.value === activeTheme)?.accent ?? "#4f7a5c";

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
                    onClick={() => void patchSettings({ theme: theme.value })}
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
              <div className="settings__field">
                <label className="settings__color-label" htmlFor="settings-accent-color">
                  Accent color
                  <input
                    id="settings-accent-color"
                    type="color"
                    value={settings.accentColor ?? defaultAccent}
                    onChange={(event) => void patchSettings({ accentColor: event.target.value })}
                  />
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!settings.accentColor}
                  onClick={() => void patchSettings({ accentColor: null })}
                >
                  Use theme accent
                </Button>
              </div>
              <div className="settings__field settings__custom-css">
                <label htmlFor="settings-custom-css">Custom CSS</label>
                <textarea
                  id="settings-custom-css"
                  value={customCss}
                  onChange={(event) => {
                    setCustomCss(event.target.value);
                    setCustomCssStatus(null);
                  }}
                  rows={7}
                  maxLength={65_536}
                  spellCheck={false}
                  aria-describedby="settings-custom-css-hint"
                />
                <p id="settings-custom-css-hint" className="settings__hint">
                  Applies after Driftleaf styles across branches. For example, use
                  <code> .editor__title </code> to style the note title or
                  <code> :root </code> to override theme variables. External resources, imports,
                  and CSS escapes are blocked to keep branch contents private.
                </p>
                <div className="settings__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={customCssBusy}
                    disabled={customCssBusy || customCss === settings.customCss}
                    onClick={() => void saveCustomCss(customCss)}
                  >
                    Apply custom CSS
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={customCssBusy || (!customCss && !settings.customCss)}
                    onClick={() => {
                      setCustomCss("");
                      void saveCustomCss("");
                    }}
                  >
                    Clear custom CSS
                  </Button>
                </div>
                {customCssStatus && <p className="settings__hint" role="status">{customCssStatus}</p>}
              </div>
              <div className="settings__field">
                <span className="settings__field-label">Welcome greeting</span>
                <Input
                  type="text"
                  label="Display name"
                  value={displayName}
                  maxLength={80}
                  onChange={(event) => setDisplayName(event.target.value)}
                  hint="Stored only in this encrypted branch."
                />
                <label className="settings__textarea-label" htmlFor="settings-greeting-lines">
                  Custom greeting lines
                </label>
                <textarea
                  id="settings-greeting-lines"
                  value={greetingLines}
                  onChange={(event) => setGreetingLines(event.target.value)}
                  rows={4}
                  maxLength={3_400}
                  placeholder={"Take it one note at a time.\nA fresh page is a small beginning."}
                  aria-describedby="settings-greeting-lines-hint"
                />
                <p id="settings-greeting-lines-hint" className="settings__hint">
                  One line is chosen each day alongside Driftleaf&rsquo;s built-in greetings. Up to
                  20 lines, 160 characters each.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    displayName === personalization.displayName &&
                    greetingLines === personalization.greetingLines.join("\n")
                  }
                  onClick={() => void savePersonalization()}
                >
                  Save personalization
                </Button>
                {personalizationStatus && (
                  <p className="settings__hint" role="status">{personalizationStatus}</p>
                )}
              </div>
              {settingsError && <p className="settings__error" role="alert">{settingsError}</p>}
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
              <label className="settings__check-row">
                <input
                  type="checkbox"
                  checked={settings.typewriterScrolling}
                  onChange={(event) =>
                    void patchSettings({ typewriterScrolling: event.target.checked })
                  }
                />
                Keep the current line centered in Focus mode (typewriter scrolling)
              </label>
              {settingsError && <p className="settings__error" role="alert">{settingsError}</p>}
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
                Check for updates and announcements when Driftleaf starts
              </label>
              <p className="settings__hint">
                When this is on, Driftleaf asks GitHub for the latest release and reads the
                project&rsquo;s announcement feed once per launch. When it is off, Driftleaf
                makes no network requests on its own.
              </p>
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
              <SecuritySettings settings={settings} onPatch={onPatch} />
              <div className="settings__tools-card">
                <div>
                  <strong>Diagnostics &amp; Branch Health</strong>
                  <p>
                    Back up, export, check branch integrity, verify backups, and clean up
                    attachments.
                  </p>
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
              <div className="settings__about-actions">
                <Button variant="ghost" size="sm" onClick={onCheckUpdates} loading={busy}>
                  Check for updates
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    window.open("https://github.com/AetherAssembly/Driftleaf/blob/main/LICENSE", "_blank")
                  }
                >
                  View license
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}
