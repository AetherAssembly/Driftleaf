import type { DriftleafApi } from "../shared/ipc";

declare global {
  interface Window {
    driftleaf: DriftleafApi;
  }
}
