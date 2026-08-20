import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { SystemPromptSectionModel } from '../../../database/models/SystemPromptSectionModel';
import { UpdateIdentitySectionWorker } from '../update_identity_section';

describe('update_identity_section tool', () => {
  const call = (input: any) => (new UpdateIdentitySectionWorker() as any)._validatedCall(input);

  afterEach(() => { jest.restoreAllMocks(); });

  it('rejects a missing id or empty content', async() => {
    expect((await call({ content: 'x' })).successBoolean).toBe(false);
    expect((await call({ id: 'user', content: '   ' })).successBoolean).toBe(false);
  });

  it('refuses to write a section that does not exist', async() => {
    jest.spyOn(SystemPromptSectionModel, 'getById').mockResolvedValue(null as any);
    const res = await call({ id: 'nope', content: 'profile' });
    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('No system-prompt section');
  });

  it('updates an existing section and reports success', async() => {
    jest.spyOn(SystemPromptSectionModel, 'getById').mockResolvedValue({ id: 'user' } as any);
    const update = jest.spyOn(SystemPromptSectionModel, 'update').mockResolvedValue({ id: 'user' } as any);
    const res = await call({ id: 'user', content: 'You are working with a direct, first-principles builder.' });
    expect(res.successBoolean).toBe(true);
    expect(update).toHaveBeenCalledWith('user', { content: 'You are working with a direct, first-principles builder.' });
  });
});
