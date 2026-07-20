import { Modal } from "@aetherAssembly/ui";

interface MoveNoteModalProps {
  noteTitle: string;
  currentFolder: string;
  folders: string[];
  onMove: (targetFolder: string) => void;
  onClose: () => void;
}

export function MoveNoteModal({
  noteTitle,
  currentFolder,
  folders,
  onMove,
  onClose,
}: MoveNoteModalProps) {
  return (
    <Modal open onClose={onClose} title={`Move "${noteTitle || "Untitled"}"`}>
      <p className="move-note__hint">Choose a destination folder:</p>
      <div className="move-note__list">
        {folders.map((folder) => {
          const isCurrent = folder === currentFolder;
          return (
            <button
              key={folder || "root"}
              className={`move-note__folder${isCurrent ? " move-note__folder--current" : ""}`}
              disabled={isCurrent}
              onClick={() => {
                onMove(folder);
                onClose();
              }}
            >
              {folder || "/ Root"}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
