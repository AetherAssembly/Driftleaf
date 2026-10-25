// Shared extension data boundary. Hosts authenticate the sender and retain these
// contexts privately; a renderer must never choose its own context or generation.
import type { ExtensionPermission } from "../shared/ipc";
import type { DriftleafService } from "./service";
import * as vaultModule from "./vault";
import * as searchModule from "./search";

export interface ExtensionContext {
  extensionId: string;
  generation: number;
}

export function createExtensionAccess<Sender>(
  service: DriftleafService,
  contextForSender: (sender: Sender) => ExtensionContext | undefined,
) {
  function requireContext(sender: Sender, permission: ExtensionPermission) {
    const context = contextForSender(sender);
    const vault = service.__internal.currentVault();
    if (!context || !vault || context.generation !== service.__internal.generation()) {
      throw new Error("This window is not an active Driftleaf extension");
    }
    const extension = vaultModule.getExtension(vault, context.extensionId);
    if (!extension) throw new Error("This extension was removed");
    if (!extension.permissions.includes(permission)) {
      throw new Error(`This extension has not been granted ${permission.replace("_", " ")} access`);
    }
    return { vault, extension };
  }

  // Authenticate and re-read grants inside the service queue, so a queued lock,
  // removal or revocation takes effect before the next extension request runs.
  return {
    listNotes: (sender: Sender) =>
      service.__internal.runSerializedCommand(() => {
        const { vault } = requireContext(sender, "read_notes");
        return vaultModule.listNotes(vault).map(({ id, title, folderPath, updatedAt }) => ({
          id,
          title,
          folderPath,
          updatedAt,
        }));
      }),
    readNote: (sender: Sender, id: string) =>
      service.__internal.runSerializedCommand(() => {
        const { vault } = requireContext(sender, "read_notes");
        return vaultModule.readNote(vault, id);
      }),
    graph: (sender: Sender) =>
      service.__internal.runSerializedCommand(() => {
        requireContext(sender, "read_graph");
        const index = service.__internal.currentIndex();
        if (!index) throw new Error("No vault is unlocked");
        return searchModule.buildNoteGraph(index);
      }),
    listDatabases: (sender: Sender) =>
      service.__internal.runSerializedCommand(async () => {
        const { vault, extension } = requireContext(sender, "read_databases");
        return (await vaultModule.listDatabases(vault)).filter((database) =>
          extension.databaseIds.includes(database.id),
        );
      }),
    readDatabase: (sender: Sender, id: string) =>
      service.__internal.runSerializedCommand(async () => {
        const { vault, extension } = requireContext(sender, "read_databases");
        if (!extension.databaseIds.includes(id)) {
          throw new Error("This extension has not been granted access to that database");
        }
        const data = await vaultModule.readDatabase(vault, id);
        const relationSafePropertyIds = new Set(
          data.properties
            .filter(
              (property) =>
                property.type !== "relation" ||
                !property.relationDatabaseId ||
                extension.databaseIds.includes(property.relationDatabaseId),
            )
            .map((property) => property.id),
        );
        const permittedPropertyIds = new Set(
          data.properties
            .filter((property) => {
              if (
                property.type === "rollup" &&
                property.rollupRelationPropertyId &&
                !relationSafePropertyIds.has(property.rollupRelationPropertyId)
              ) {
                return false;
              }
              return relationSafePropertyIds.has(property.id);
            })
            .map((property) => property.id),
        );
        return {
          ...data,
          properties: data.properties.filter((property) => permittedPropertyIds.has(property.id)),
          rows: data.rows.map((row) => ({
            ...row,
            values: Object.fromEntries(
              Object.entries(row.values).filter(([propertyId]) =>
                permittedPropertyIds.has(propertyId),
              ),
            ),
          })),
        };
      }),
  };
}
