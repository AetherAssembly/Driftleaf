import { Button, Modal } from "@aetherAssembly/ui";
import type {
  DatabaseMeta,
  ExtensionPermission,
  ExtensionSample,
  ExtensionSummary,
} from "../../shared/ipc";

interface ExtensionsModalProps {
  open: boolean;
  extensions: ExtensionSummary[];
  samples: ExtensionSample[];
  databases: DatabaseMeta[];
  onClose: () => void;
  onInstall: () => void;
  onInstallSample: (sampleId: string) => void;
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
  databases,
  onClose,
  onInstall,
  onInstallSample,
  onRun,
  onRemove,
  onPermissionsChange,
}: ExtensionsModalProps) {
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
      enabled ? extension.databaseIds : permission === "read_databases" ? [] : extension.databaseIds,
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
      <p>
        Extensions run in isolated windows with network access disabled. Grant only the
        capabilities you trust; permissions are encrypted with this vault.
      </p>
      <div className="extensions-modal__install">
        <Button variant="secondary" size="sm" onClick={onInstall}>
          Install JavaScript extension
        </Button>
      </div>
      <section className="extensions-modal__samples">
        <h2>Starter gallery</h2>
        <p>Small local examples demonstrate the extension API. Review permissions before running.</p>
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
                  {databases.length === 0 && <small>No databases in this vault.</small>}
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
    </Modal>
  );
}
