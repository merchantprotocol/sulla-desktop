import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';

import { CustomAgentDefinitions } from '../customAgentDefinitions';

describe('CustomAgentDefinitions', () => {
  let root: string;
  let service: CustomAgentDefinitions;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-agents-'));
    service = new CustomAgentDefinitions(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('updates name, model, and prompt without changing other config keys', () => {
    const dir = path.join(root, 'careful-worker');
    const original = {
      name:               'Careful Worker',
      description:        'Keeps its config',
      type:               'worker',
      provider:           'codex',
      model:              'old-model',
      tools:              ['exec'],
      skills:             ['review'],
      injectObservations: true,
      custom:             { retries: 4 },
    };

    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.yaml'), YAML.stringify(original));
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'Old prompt');

    service.update('careful-worker', { name: 'Renamed Worker', model: 'new-model', prompt: 'New prompt' });

    const updated = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8'));
    expect(updated).toEqual({ ...original, name: 'Renamed Worker', model: 'new-model' });
    expect(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf-8')).toBe('New prompt');
  });

  it('creates a safe unique slug with worker defaults and can delete it', () => {
    const first = service.create({ name: 'My New Agent!', model: 'gpt-6-sol', provider: 'codex', prompt: 'Ship it.' });
    const second = service.create({ name: 'My New Agent!', model: 'gpt-6-sol', provider: 'codex', prompt: 'Again.' });

    expect(first.id).toBe('my-new-agent');
    expect(second.id).toBe('my-new-agent-2');
    expect(YAML.parse(fs.readFileSync(path.join(first.path, 'config.yaml'), 'utf-8'))).toMatchObject({
      id:       'my-new-agent',
      type:     'worker',
      provider: 'codex',
      model:    'gpt-6-sol',
      tools:    ['exec', 'file_search'],
      skills:   [],
    });
    expect(service.delete(first.id)).toBe(true);
    expect(service.get(first.id)).toBeNull();
  });
});
