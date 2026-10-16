import { SerialQueue } from "../../shared/serial-queue";

// Entries survive failures and component unmounts. An acknowledgement only
// removes the revision actually written, never a newer edit for the same key.
export class DraftWrites {
  private drafts = new Map<string, () => Promise<void>>();
  private queue = new SerialQueue();

  set(key: string, write: () => Promise<void>): void {
    this.drafts.set(key, write);
  }

  remove(key: string): void {
    this.drafts.delete(key);
  }

  flush(): Promise<void> {
    return this.queue.run(async () => {
      while (this.drafts.size) {
        const [key, write] = this.drafts.entries().next().value!;
        await write();
        if (this.drafts.get(key) === write) this.drafts.delete(key);
      }
    });
  }
}

export const draftWrites = new DraftWrites();
