# Brokered browser access

Node functions cannot launch processes or access Electron directly. A function that needs rendered public pages can opt into Desktop's invocation-scoped browser broker:

```yaml
spec:
  runtime: node
  entrypoint: index.mjs::handler
  permissions:
    browser:
      enabled: true
      allowedOrigins:
        - https://www.hgtv.com
        - https://www.foodnetwork.com
```

`browser: true` is also accepted when the function genuinely needs arbitrary HTTP(S) origins. Prefer `allowedOrigins`; entries are exact origins (scheme, host, and optional port). This is an important security boundary: DNS can change between validation and the browser's network connection, so an explicit list of trusted origins materially reduces the residual DNS-rebinding window. Use unrestricted `browser: true` only when the function cannot know its public origins in advance.

Desktop injects `SULLA_BROWSER_HOST_URL` and `SULLA_BROWSER_TOKEN` only for the duration of an authorized invocation. Import or bundle [`SullaBrowserClient.mjs`](examples/SullaBrowserClient.mjs):

```js
import { SullaBrowserClient } from './SullaBrowserClient.mjs';

export async function handler({ url }) {
  const browser = new SullaBrowserClient();
  const { tabId } = await browser.open(url);
  try {
    return await browser.evaluate(tabId, `return {
      url: location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 50000),
      links: [...document.querySelectorAll('a[href]')].map(a => ({ url: a.href, label: a.innerText }))
    }`);
  } finally {
    await browser.close(tabId);
  }
}
```

The broker exposes only open-and-wait, JavaScript evaluation returning JSON, and close. Desktop also closes every tab owned by the invocation when it finishes, fails, or times out. Tokens are short-lived and cannot operate on another invocation's tabs.
