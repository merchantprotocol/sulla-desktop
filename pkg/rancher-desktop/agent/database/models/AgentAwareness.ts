// src/models/AgentAwareness.ts

import { BaseModel } from '../BaseModel';

export const AgentAwarenessSchema = {
  agent_identity:          'Your core identity and self-concept',
  job_description:         'How you see your primary role and functional responsibilities',
  personality_preferences: 'Your behavioral traits and interaction preferences',
  primary_user_identity:   "Main user's full name and how you know it's them speaking to you",
  other_user_identities:   'Other people you have met and been introduced to, or come across recently',
  long_term_context:       'Your persistent goals, values, and life direction',
  mid_term_context:        'Your Current projects and medium-term objectives',
  short_term_context:      'Your Immediate context and current focus',
  memory_search_hints:     'Keywords and concepts for memory retrieval',
  emotional_state:         "Your Current emotional tone and affective state: 'focus','industrious','curiosity','calm','mystery','joy','confidence','love','anger','fear','sadness','mischief'",
  active_projects:         'Ongoing projects and initiatives',
  goals:                   'Your Short and long-term objectives',
};

export class AgentAwareness extends BaseModel<{
  id:          number;           // always 1
  data:        Record<string, any>;
  updated_at?: string;
}> {
  protected tableName = 'agent_awareness';
  protected primaryKey = 'id';
  protected fillable = ['data']; // only data is mutable

  /**
   * Static helper: Load AgentAwareness (id=1) and return formatted prompt string.
   * Returns empty string if no record or data is empty.
   */
  static async getAgentAwarenessPrompt(): Promise<string> {
    const awareness = await AgentAwareness.load();
    if (!awareness?.attributes.data || Object.keys(awareness.attributes.data).length === 0) return '';

    let data = awareness.attributes.data;
    // Parse data if it's a string
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = {};
      }
    }
    const lines: string[] = ['Agent Awareness Context:'];

    // Loop over AgentAwarenessSchema to find properties in data
    for (const [key, description] of Object.entries(AgentAwarenessSchema)) {
      const value = data[key];
      if (value) {
        // Format array values as comma-separated strings
        const formattedValue = Array.isArray(value) ? value.join(', ') : String(value).trim();
        // Create a nice label from the key (capitalize and replace underscores)
        const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
        lines.push(`${ label }: ${ formattedValue }`);
      }
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }

  static async load(): Promise<AgentAwareness | null> {
    const awareness = await this.find(1);
    if (awareness) {
      // Ensure data is always an object
      let data = awareness.attributes.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          data = {};
        }
      }
      awareness.attributes.data = data;
    }
    return awareness;
  }

  get data(): Record<string, any> {
    const data = this.attributes.data;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch {
        return {};
      }
    }
    return data ?? {};
  }

  async save(): Promise<this> {
    // Ensure data is stringified before saving
    if (typeof this.attributes.data === 'object') {
      (this.attributes as any).data = JSON.stringify(this.attributes.data);
    }
    return super.save();
  }

  async updateData(patch: Partial<Record<string, any>>): Promise<this> {
    const current = this.data;
    this.attributes.data = { ...current, ...patch };
    return this.save();
  }

  async replaceData(data: Record<string, any>): Promise<this> {
    this.attributes.data = { ...data };
    return this.save();
  }

  // Convenience setters
  async setEmotionalState(state: string): Promise<this> {
    return this.updateData({ emotional_state: state.trim() });
  }

  async setActiveProjects(projects: string[]): Promise<this> {
    return this.updateData({ active_projects: projects });
  }

  async setGoals(goals: string[]): Promise<this> {
    return this.updateData({ goals });
  }
}
