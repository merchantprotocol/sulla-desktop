/**
 * Friendly date formatting utility
 * Source: https://stackoverflow.com/a/7641812
 * Posted by alex, modified by community. See post 'Timeline' for change history
 * Retrieved 2026-02-05, License - CC BY-SA 3.0
 */

/**
 * Format a date to fuzzy time relative to now
 * @param dateInput - Date object, timestamp, or date string
 * @returns Formatted fuzzy time string
 */
export function formatFuzzyTime(dateInput: Date | number | string): string {
  const date = new Date(dateInput);
  const now = new Date();

  // Handle invalid dates
  if (isNaN(date.getTime())) {
    return 'Unknown time';
  }

  // Make a fuzzy time
  const delta = Math.round((now.getTime() - date.getTime()) / 1000);

  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  const year = day * 365;

  let fuzzy;

  if (delta < 30) {
    fuzzy = 'just now';
  } else if (delta < minute) {
    fuzzy = delta + ' seconds ago';
  } else if (delta < 2 * minute) {
    fuzzy = 'a minute ago';
  } else if (delta < hour) {
    fuzzy = Math.floor(delta / minute) + ' minutes ago';
  } else if (Math.floor(delta / hour) == 1) {
    fuzzy = '1 hour ago';
  } else if (delta < day) {
    fuzzy = Math.floor(delta / hour) + ' hours ago';
  } else if (delta < day * 2) {
    fuzzy = 'yesterday';
  } else if (delta < week) {
    fuzzy = Math.floor(delta / day) + ' days ago';
  } else if (delta < week * 2) {
    fuzzy = 'last week';
  } else if (delta < month) {
    fuzzy = Math.floor(delta / week) + ' weeks ago';
  } else if (delta < month * 2) {
    fuzzy = 'last month';
  } else if (delta < year) {
    fuzzy = Math.floor(delta / month) + ' months ago';
  } else if (delta < year * 2) {
    fuzzy = 'last year';
  } else {
    fuzzy = Math.floor(delta / year) + ' years ago';
  }

  return fuzzy;
}

/**
 * Format a date to short fuzzy time (more concise)
 * @param dateInput - Date object, timestamp, or date string
 * @returns Short formatted fuzzy time string
 */
export function formatShortFuzzyTime(dateInput: Date | number | string): string {
  const date = new Date(dateInput);
  const now = new Date();

  // Handle invalid dates
  if (isNaN(date.getTime())) {
    return 'Unknown';
  }

  const delta = Math.round((now.getTime() - date.getTime()) / 1000);

  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  const year = day * 365;

  if (delta < 30) {
    return 'just now';
  } else if (delta < minute) {
    return `${ delta }s ago`;
  } else if (delta < hour) {
    return `${ Math.floor(delta / minute) }m ago`;
  } else if (delta < day) {
    return `${ Math.floor(delta / hour) }h ago`;
  } else if (delta < day * 2) {
    return 'yesterday';
  } else if (delta < week) {
    return `${ Math.floor(delta / day) }d ago`;
  } else if (delta < month) {
    return `${ Math.floor(delta / week) }w ago`;
  } else if (delta < year) {
    return `${ Math.floor(delta / month) }mo ago`;
  } else {
    return `${ Math.floor(delta / year) }y ago`;
  }
}
