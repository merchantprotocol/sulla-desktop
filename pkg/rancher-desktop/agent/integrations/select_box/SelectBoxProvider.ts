export interface SelectOption {
  value:        string;
  label:        string;
  description?: string;
}

export interface SelectBoxContext {
  integrationId: string;
  accountId:     string;
  /** Current form values for sibling properties (keyed by property key) */
  formValues:    Record<string, string>;
}

/**
 * Base class for select box providers.
 * Each subclass resolves a list of SelectOption[] given the current form context.
 */
export abstract class SelectBoxProvider {
  abstract readonly id: string;

  /**
   * Return the options for this select box.
   * Receives the current integration context including any sibling form values
   * so the provider can use credentials to call an API if needed.
   */
  abstract getOptions(context: SelectBoxContext): Promise<SelectOption[]>;
}
