// Liveness file for container health checks (DWA-OPS-007): touched while a Slack connection is up.

export interface HealthFileDeps {
  /** Writes the file; errors are reported, never thrown. */
  touch: () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}

/** Touches the file at once and then every `everyMs` while at least one connection is open. */
export class HealthFile {
  private timer: unknown;

  constructor(
    private readonly deps: HealthFileDeps,
    readonly everyMs = 15_000,
  ) {}

  onConnectedChange(open: number): void {
    if (open > 0 && this.timer === undefined) {
      this.deps.touch();
      this.timer = this.deps.setInterval(() => { this.deps.touch(); }, this.everyMs);
    } else if (open === 0) {
      this.stop();
    }
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.deps.clearInterval(this.timer);
    this.timer = undefined;
  }
}
