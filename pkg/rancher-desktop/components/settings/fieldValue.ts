/** The current value of the input, select or textarea that fired `event`. */
export function fieldValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}
