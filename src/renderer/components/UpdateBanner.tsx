import { useState } from "react";
import { Button } from "@aetherAssembly/ui";
import type { UpdateStatus } from "../../shared/ipc";

interface UpdateBannerProps {
  status: UpdateStatus;
  onDownload: () => void;
  onInstall: () => void;
  onOpenDownload: () => void;
}

export function UpdateBanner({
  status,
  onDownload,
  onInstall,
  onOpenDownload,
}: UpdateBannerProps) {
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  if (status.state !== "available" && status.state !== "downloaded") return null;
  const downloaded = status.state === "downloaded";
  const statusKey = `${status.state}:${status.availableVersion ?? ""}`;
  if (dismissedFor === statusKey) return null;

  return (
    <aside className="update-banner" role="status">
      <span className="update-banner__icon" aria-hidden="true">✦</span>
      <div className="update-banner__copy">
        <strong>{downloaded ? "Update ready" : "A new Driftleaf is available"}</strong>
        <span>{downloaded ? status.message : `Version ${status.availableVersion} is ready.`}</span>
      </div>
      {downloaded ? (
        <Button variant="primary" size="sm" onClick={onInstall}>
          Restart to update
        </Button>
      ) : status.automaticInstall ? (
        <Button variant="primary" size="sm" onClick={onDownload}>
          Download
        </Button>
      ) : (
        <Button variant="primary" size="sm" onClick={onOpenDownload}>
          Get update
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDismissedFor(statusKey)}
        aria-label="Dismiss update notice"
      >
        ×
      </Button>
    </aside>
  );
}
