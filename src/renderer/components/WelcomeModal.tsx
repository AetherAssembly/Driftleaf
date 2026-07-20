import { Button, Modal } from "@aetherAssembly/ui";

interface WelcomeModalProps {
  open: boolean;
  onClose: () => void;
}

// Shown once per device on first unlock (gated by localStorage in App.tsx). A "Welcome to
// Driftleaf" note with the fuller reference (shortcuts, markdown syntax, recovery) is also
// auto-created per vault in src/main/vault.ts's createVault() — this modal is just the
// at-a-glance version.
export function WelcomeModal({ open, onClose }: WelcomeModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Welcome to Driftleaf">
      <ul className="welcome-modal__points">
        <li>
          <strong>Encrypted at rest.</strong> Notes are encrypted with AES-256-GCM using
          your passphrase. Even we can&rsquo;t read them without it.
        </li>
        <li>
          <strong>Local-first.</strong> Your notes live on this device only — no cloud
          sync, no servers, no tracking.
        </li>
        <li>
          <strong>Yours alone.</strong> Your passphrase can&rsquo;t be reset. Write it
          down and keep it safe.
        </li>
      </ul>
      <p className="welcome-modal__hint">
        A &ldquo;Welcome to Driftleaf&rdquo; note with shortcuts and markdown syntax is
        already in your vault.
      </p>
      <div className="modal-actions">
        <Button variant="primary" size="sm" onClick={onClose}>
          Got it
        </Button>
      </div>
    </Modal>
  );
}
