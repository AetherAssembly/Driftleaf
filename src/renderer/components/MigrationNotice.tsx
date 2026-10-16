import { useEffect, useState } from "react";
import { Button } from "@aetherAssembly/ui";

export function MigrationNotice() {
  const [platform, setPlatform] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    void window.driftleaf.diagnostics
      .read()
      .then((info) => setPlatform(info.platform))
      .catch(() => {});
  }, []);
  if (dismissed) return null;
  return (
    <aside className="update-banner migration-notice" aria-label="Planned desktop upgrade">
      <div className="update-banner__copy">
        <strong>A lighter Driftleaf is planned</strong>
        <span>
          A future release will move from Electron to Tauri, keeping the familiar interface. This
          release still uses Electron.
        </span>
        {platform === "win32" && (
          <span>
            Windows: automatic updates will not carry you across the planned migration. You will
            need to install that release manually once; automatic updates are planned to resume
            afterward. Current Electron updates are unchanged.
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss planned upgrade notice"
      >
        ×
      </Button>
    </aside>
  );
}
