// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** `backup --watch`: one coherent backup every night at 02:00 local time. */
export class NightlyBackupSchedule {
  constructor(
    private readonly runBackup:()=>Promise<unknown>,
    private readonly clock:()=>Date = () => new Date(),
    private readonly sleep:(milliseconds:number)=>Promise<void> = milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
  ) {}

  /** The next 02:00 local strictly after `now`. */
  static nextRun(now:Date):Date {
    const next = new Date(now); next.setHours(2, 0, 0, 0); if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  async forever():Promise<never> {
    for (;;) {
      const now = this.clock(); const next = NightlyBackupSchedule.nextRun(now);
      await this.sleep(next.getTime() - now.getTime()); await this.runBackup();
    }
  }
}
