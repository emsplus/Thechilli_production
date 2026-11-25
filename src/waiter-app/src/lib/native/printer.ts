/**
 * SEAM ONLY. There is no implementation in this repo and none is registered anywhere.
 *
 * Contract for a future Capacitor plugin that drives a hardware KOT/bill printer (ESC/POS over Bluetooth Classic/SPP,
 * BLE, or LAN). When one exists, the app should obtain it via a single `getPrinter(): Printer | null` factory and fall
 * back to server-side/cashier printing when null. See docs/ANDROID.md "Printer seam".
 */
export interface PrinterDevice {
  /** Stable identifier (Bluetooth MAC address or host:port). */
  id: string;
  name: string;
  transport: "bluetooth-classic" | "ble" | "lan";
}

export type PrinterStatus = "disconnected" | "connecting" | "ready" | "paper-out" | "cover-open" | "error";

export interface PrintJob {
  /** Idempotency key (reuse the queue op_id / KOT id) so a retry never double-prints. */
  jobId: string;
  /** Raw ESC/POS bytes already rendered by the caller. The plugin does not format receipts. */
  data: Uint8Array;
  copies?: number;
}

export interface Printer {
  /** Paired/discoverable devices. Must request the Android 12+ BLUETOOTH_CONNECT/SCAN runtime permissions. */
  listDevices(): Promise<PrinterDevice[]>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  status(): Promise<PrinterStatus>;
  /** Resolves once bytes are flushed to the printer. Rejects with a typed reason; never silently drops a job. */
  print(job: PrintJob): Promise<void>;
  /** Subscribe to status changes (paper out, disconnect). Returns an unsubscribe function. */
  onStatus(cb: (s: PrinterStatus) => void): () => void;
}
