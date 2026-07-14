import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal } from "@aetherAssembly/ui";
import type { AppSettings } from "../../shared/ipc";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onPatch: (update: Partial<AppSettings>) => void;
}

export function SettingsModal({ open, onClose, settings, onPatch }: SettingsModalProps) {
  const [fontSize, setFontSize] = useState(settings.editorFontSizePx);
  const [autosave, setAutosave] = useState(settings.autosaveIntervalMs);
  const fontDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state if settings prop changes (e.g. on open)
  useEffect(() => {
    setFontSize(settings.editorFontSizePx);
    setAutosave(settings.autosaveIntervalMs);
  }, [settings.editorFontSizePx, settings.autosaveIntervalMs]);

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

  const themes: Array<{ value: AppSettings["theme"]; label: string }> = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  const lastVaultName = settings.lastVaultPath
    ? settings.lastVaultPath.split("/").pop() ?? settings.lastVaultPath
    : null;

  return (
    <Modal open={open} onClose={onClose} title="Settings">
      <div className="settings">
        <section className="settings__section">
          <label className="settings__label">Theme</label>
          <div className="settings__theme-row">
            {themes.map((t) => (
              <Button
                key={t.value}
                variant={settings.theme === t.value ? "primary" : "ghost"}
                size="sm"
                onClick={() => onPatch({ theme: t.value })}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </section>

        <section className="settings__section">
          <Input
            type="number"
            label="Editor font size (px)"
            value={fontSize}
            min={12}
            max={24}
            onChange={(e) => handleFontSize(Number(e.target.value))}
          />
        </section>

        <section className="settings__section">
          <Input
            type="number"
            label="Autosave delay (ms)"
            value={autosave}
            min={200}
            max={5000}
            onChange={(e) => handleAutosave(Number(e.target.value))}
          />
        </section>

        {lastVaultName && (
          <section className="settings__section">
            <label className="settings__label">Last opened vault</label>
            <div className="settings__vault-row">
              <span className="settings__vault-name" title={settings.lastVaultPath ?? ""}>
                {lastVaultName}
              </span>
              <Button variant="ghost" size="sm" onClick={() => onPatch({ lastVaultPath: null })}>
                Forget
              </Button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
