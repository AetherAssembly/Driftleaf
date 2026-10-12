import { useState } from "react";
import { Button, Modal } from "@aetherAssembly/ui";
import type {
  CommunityReleaseItem,
  DatabaseMeta,
  ExtensionPermission,
  ExtensionSample,
  ExtensionSummary,
} from "../../shared/ipc";

interface ExtensionsModalProps {
  open: boolean;
  extensions: ExtensionSummary[];
  samples: ExtensionSample[];
  communityItems: CommunityReleaseItem[];
  communityLoading: boolean;
  communityError: string | null;
  databases: DatabaseMeta[];
  onClose: () => void;
  onInstall: () => void;
  onInstallSample: (sampleId: string) => void;
  onRefreshCommunity: () => void;
  onInstallCommunityExtension: (assetId: number) => void;
  onInstallCommunityTemplate: (assetId: number) => void;
  onRun: (id: string) => void;
  onRemove: (id: string) => void;
  onPermissionsChange: (
    id: string,
    permissions: ExtensionPermission[],
    databaseIds: string[],
  ) => void;
}

export function ExtensionsModal({
  open,
  extensions,
  samples,
  communityItems,
  communityLoading,
  communityError,
  databases,
  onClose,
  onInstall,
  onInstallSample,
  onRefreshCommunity,
  onInstallCommunityExtension,
  onInstallCommunityTemplate,
  onRun,
  onRemove,
  onPermissionsChange,
}: ExtensionsModalProps) {
  const [previewAssetId, setPreviewAssetId] = useState<number | null>(null);
  const [previewSource, setPreviewSource] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  async function toggleSourcePreview(assetId: number) {
    if (previewAssetId === assetId) {
      setPreviewAssetId(null);
      setPreviewSource("");
      setPreviewError(null);
      return;
    }
    setPreviewAssetId(assetId);
    setPreviewSource("");
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      setPreviewSource(await window.driftleaf.extensions.previewCommunityExtension(assetId));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Could not load extension source");
    } finally {
      setPreviewLoading(false);
    }
  }

  function togglePermission(
    extension: ExtensionSummary,
    permission: ExtensionPermission,
    enabled: boolean,
  ) {
    const permissions = new Set(extension.permissions);
    if (enabled) permissions.add(permission);
    else permissions.delete(permission);
    onPermissionsChange(
      extension.id,
      [...permissions],
      enabled
        ? extension.databaseIds
        : permission === "read_databases"
          ? []
          : extension.databaseIds,
    );
  }

  function toggleDatabase(extension: ExtensionSummary, databaseId: string, enabled: boolean) {
    const databaseIds = new Set(extension.databaseIds);
    if (enabled) databaseIds.add(databaseId);
    else databaseIds.delete(databaseId);
    const permissions = new Set(extension.permissions);
    if (databaseIds.size > 0) permissions.add("read_databases");
    onPermissionsChange(extension.id, [...permissions], [...databaseIds]);
  }

  return (
    <Modal open={open} onClose={onClose} title="Extensions">
      <div className="extensions-modal">
        <p>
          Extensions run in isolated windows with network access disabled. Grant only the
          capabilities you trust; permissions are encrypted with this branch.
        </p>
        <div className="extensions-modal__install">
          <Button variant="secondary" size="sm" onClick={onInstall}>
            Install JavaScript extension
          </Button>
        </div>
        <section className="extensions-modal__samples">
          <h2>Starter gallery</h2>
          <p>
            Small local examples demonstrate the extension API. Review permissions before running.
          </p>
          <div className="extensions-modal__sample-grid">
            {samples.map((sample) => (
              <article key={sample.id}>
                <strong>{sample.name}</strong>
                <p>{sample.description}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={extensions.some((extension) => extension.sampleId === sample.id)}
                  onClick={() => onInstallSample(sample.id)}
                >
                  {extensions.some((extension) => extension.sampleId === sample.id)
                    ? "Installed"
                    : "Add sample"}
                </Button>
              </article>
            ))}
          </div>
        </section>
        <section className="extensions-modal__community">
          <header>
            <div>
              <h2>Community gallery</h2>
              <p>Browse stable releases from the Driftleaf extension and template libraries.</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={communityLoading}
              onClick={onRefreshCommunity}
            >
              {communityLoading ? "Loading…" : "Refresh"}
            </Button>
          </header>
          <p className="extensions-modal__community-links">
            Want to create and share your own? Explore the community repositories:
            {" "}
            <a
              href="https://github.com/AetherAssembly/Driftleaf-Extensions"
              target="_blank"
              rel="noreferrer"
            >
              Extensions
            </a>
            {" · "}
            <a
              href="https://github.com/AetherAssembly/Driftleaf-Templates"
              target="_blank"
              rel="noreferrer"
            >
              Templates
            </a>
            .
          </p>
          {communityError && <p className="extensions-modal__error">{communityError}</p>}
          {!communityLoading && !communityError && communityItems.length === 0 && (
            <p>No released extensions or templates are available yet.</p>
          )}
          <div className="extensions-modal__community-grid">
            {communityItems.map((item) => (
              <article key={`${item.repository}-${item.assetId}`}>
                <span className="settings__eyebrow">
                  {item.kind} · {item.version}
                </span>
                <strong>{item.name}</strong>
                <small>
                  {item.repository} · {(item.size / 1024).toFixed(1)} KB
                </small>
                <details>
                  <summary>Release notes</summary>
                  <p>{item.description}</p>
                </details>
                {item.kind === "extension" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={previewLoading && previewAssetId === item.assetId}
                      onClick={() => void toggleSourcePreview(item.assetId)}
                    >
                      {previewAssetId === item.assetId ? "Hide source" : "Preview source"}
                    </Button>
                    {previewAssetId === item.assetId &&
                      (previewError ? (
                        <p className="extensions-modal__error">{previewError}</p>
                      ) : previewLoading ? (
                        <p>Loading source…</p>
                      ) : (
                        <pre className="extensions-modal__source">{previewSource}</pre>
                      ))}
                  </>
                )}
                {item.kind === "template" && (
                  <p className="extensions-modal__notice">
                    Installs as notes and databases under “Community templates” in this branch.
                  </p>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (item.kind === "extension") {
                      onInstallCommunityExtension(item.assetId);
                    } else if (
                      window.confirm(
                        `Download and import the "${item.name}" template into this encrypted branch? Its contents will be added under Community templates.`,
                      )
                    ) {
                      onInstallCommunityTemplate(item.assetId);
                    }
                  }}
                >
                  {item.kind === "extension" ? "Install extension" : "Install template"}
                </Button>
              </article>
            ))}
          </div>
        </section>
        {extensions.length === 0 ? (
          <p className="sidebar__empty">No extensions installed.</p>
        ) : (
          <ul className="extensions-modal__list">
            {extensions.map((extension) => (
              <li key={extension.id} className="extensions-modal__item">
                <strong>{extension.name}</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={extension.permissions.includes("read_notes")}
                    onChange={(event) =>
                      togglePermission(extension, "read_notes", event.target.checked)
                    }
                  />
                  Read note titles, folders, and contents
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={extension.permissions.includes("read_graph")}
                    onChange={(event) =>
                      togglePermission(extension, "read_graph", event.target.checked)
                    }
                  />
                  Read note graph and links
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={extension.permissions.includes("read_databases")}
                    onChange={(event) =>
                      togglePermission(extension, "read_databases", event.target.checked)
                    }
                  />
                  Read selected databases
                </label>
                {extension.permissions.includes("read_databases") && (
                  <div className="extensions-modal__database-list">
                    <small>Choose which databases this extension may read:</small>
                    {databases.map((database) => (
                      <label key={database.id}>
                        <input
                          type="checkbox"
                          checked={extension.databaseIds.includes(database.id)}
                          onChange={(event) =>
                            toggleDatabase(extension, database.id, event.target.checked)
                          }
                        />
                        {database.title}
                      </label>
                    ))}
                    {databases.length === 0 && <small>No databases in this branch.</small>}
                  </div>
                )}
                <div className="modal-actions">
                  <Button variant="secondary" size="sm" onClick={() => onRun(extension.id)}>
                    Run
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => onRemove(extension.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
