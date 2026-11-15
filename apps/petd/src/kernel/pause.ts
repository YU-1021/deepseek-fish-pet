/** 暂停门：用户点「暂停」后，聊天、自主任务、电脑操作都停下来，恢复后继续。 */
export interface PauseStatus {
  paused: boolean;
  reason: string | null;
  changedAt: number;
}

export class PauseGate {
  private pausedFlag = false;
  private reasonValue: string | null = null;
  private changedAtValue = Date.now();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  pause(reason = '用户暂停了运行'): PauseStatus {
    if (!this.pausedFlag) {
      this.pausedFlag = true;
      this.reasonValue = reason;
      this.changedAtValue = this.now();
    }
    return this.status();
  }

  resume(): PauseStatus {
    if (this.pausedFlag) {
      this.pausedFlag = false;
      this.reasonValue = null;
      this.changedAtValue = this.now();
    }
    return this.status();
  }

  status(): PauseStatus {
    return { paused: this.pausedFlag, reason: this.reasonValue, changedAt: this.changedAtValue };
  }
}
