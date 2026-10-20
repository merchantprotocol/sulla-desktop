/** @jest-environment node */
import { describe, expect, test } from '@jest/globals';

import { selectSullaPostgresImage, SULLA_POSTGRES_FALLBACK_IMAGE } from '../sullaPostgresImage';

const preferred = 'ghcr.io/merchantprotocol/sulla-postgres:latest';

function fakeVm(state: { present: boolean; pullable: boolean }) {
  const commands: string[][] = [];
  const lines: string[] = [];
  const run = (...command: string[]) => {
    commands.push(command);
    if (command.includes('inspect')) return state.present ? Promise.resolve('sha256:x') : Promise.reject(new Error('No such image'));
    if (command.includes('pull')) return state.pullable ? Promise.resolve('') : Promise.reject(new Error('dial tcp: lookup ghcr.io: no such host\nmore'));

    return Promise.resolve('');
  };

  return { run, commands, lines, log: { log: (line: string) => { lines.push(line) } } };
}

describe('selectSullaPostgresImage', () => {
  test('an image already in the VM is used without a pull', async() => {
    const vm = fakeVm({ present: true, pullable: false });

    await expect(selectSullaPostgresImage({ preferred, run: vm.run, log: vm.log })).resolves.toEqual({ image: preferred, vector: true, source: 'local' });
    expect(vm.commands).toEqual([['docker', 'image', 'inspect', '--format', '{{.Id}}', preferred]]);
    expect(vm.lines).toEqual([]);
  });

  test('a missing image is pulled (bounded by a timeout) before use', async() => {
    const vm = fakeVm({ present: false, pullable: true });

    await expect(selectSullaPostgresImage({ preferred, run: vm.run, log: vm.log })).resolves.toEqual({ image: preferred, vector: true, source: 'pulled' });
    expect(vm.commands[1]).toEqual(['timeout', '300', 'docker', 'pull', preferred]);
  });

  test('any pull failure falls back to the stock image and logs exactly one line', async() => {
    const vm = fakeVm({ present: false, pullable: false });

    await expect(selectSullaPostgresImage({ preferred, run: vm.run, log: vm.log })).resolves.toEqual({ image: SULLA_POSTGRES_FALLBACK_IMAGE, vector: false, source: 'fallback' });
    expect(SULLA_POSTGRES_FALLBACK_IMAGE).toBe('postgres:16-alpine');
    expect(vm.lines).toHaveLength(1);
    expect(vm.lines[0]).toContain('no such host');
    expect(vm.lines[0]).not.toContain('more');
  });

  test('an override equal to the fallback image is used directly', async() => {
    const vm = fakeVm({ present: false, pullable: false });

    await expect(selectSullaPostgresImage({ preferred: 'postgres:16-alpine', run: vm.run, log: vm.log })).resolves.toEqual({ image: 'postgres:16-alpine', vector: false, source: 'local' });
    expect(vm.commands).toEqual([]);
  });
});
