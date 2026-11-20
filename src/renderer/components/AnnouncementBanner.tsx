import { useState } from "react";
import { Button } from "@aetherAssembly/ui";
import type { AnnouncementItem } from "../../shared/ipc";

const SEEN_KEY = "driftleaf-seen-announcement-guid";

interface AnnouncementBannerProps {
  item: AnnouncementItem | null;
}

export function AnnouncementBanner({ item }: AnnouncementBannerProps) {
  // Persisted (not just in-memory, unlike UpdateBanner's dismiss) so a seen announcement
  // stays dismissed across restarts instead of reappearing every launch.
  const [seenGuid, setSeenGuid] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SEEN_KEY);
    } catch {
      return null;
    }
  });

  if (!item || item.guid === seenGuid) return null;

  function dismiss() {
    setSeenGuid(item!.guid);
    try {
      localStorage.setItem(SEEN_KEY, item!.guid);
    } catch {
      // Best-effort — losing the "seen" marker just means this reappears next launch.
    }
  }

  return (
    <aside className="update-banner announcement-banner" role="status">
      <span className="update-banner__icon announcement-banner__icon" aria-hidden="true">
        🗞
      </span>
      <div className="update-banner__copy">
        {item.link ? (
          <a href={item.link} target="_blank" rel="noreferrer">
            <strong>{item.title}</strong>
          </a>
        ) : (
          <strong>{item.title}</strong>
        )}
        {item.description && <span>{item.description}</span>}
      </div>
      <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss announcement">
        ×
      </Button>
    </aside>
  );
}
