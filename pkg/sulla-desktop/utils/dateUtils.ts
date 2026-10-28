// SPDX-License-Identifier: GPL-2.0-or-later
import dayjs from 'dayjs';

export function currentTime(): string {
  const date = dayjs(Date.now());

  return date.format('YYYY-MM-DD HH:mm');
}
