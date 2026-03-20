import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

export class ElevenLabsVoices extends SelectBoxProvider {
  readonly id = 'elevenlabs_voices';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const apiKey = context.formValues.api_key;

    if (!apiKey) {
      return this.getStaticVoices();
    }

    try {
      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });

      if (!response.ok) {
        return this.getStaticVoices();
      }

      const body = await response.json() as { voices?: { voice_id: string; name: string; category?: string }[] };

      if (body.voices && body.voices.length > 0) {
        return body.voices.map(v => ({
          value:       v.voice_id,
          label:       v.name,
          description: v.category,
        }));
      }
    } catch {
      // Fall back to static list
    }

    return this.getStaticVoices();
  }

  private getStaticVoices(): SelectOption[] {
    return [
      { value: 'Rachel',  label: 'Rachel',  description: 'premade' },
      { value: 'Drew',    label: 'Drew',    description: 'premade' },
      { value: 'Clyde',   label: 'Clyde',   description: 'premade' },
      { value: 'Paul',    label: 'Paul',    description: 'premade' },
      { value: 'Domi',    label: 'Domi',    description: 'premade' },
      { value: 'Dave',    label: 'Dave',    description: 'premade' },
      { value: 'Fin',     label: 'Fin',     description: 'premade' },
      { value: 'Sarah',   label: 'Sarah',   description: 'premade' },
    ];
  }
}
