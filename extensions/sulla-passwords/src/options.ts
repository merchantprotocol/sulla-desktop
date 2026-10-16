import { getConfig, setConfig } from './api.js';
const input = document.querySelector<HTMLInputElement>('#url')!;
void getConfig().then((config) => { input.value = config.baseUrl; });
document.querySelector('#save')!.addEventListener('click', async () => { await setConfig({ baseUrl: input.value.trim() }); });
