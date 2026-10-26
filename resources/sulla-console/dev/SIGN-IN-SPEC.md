<!--
  Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
  Licensed under the Sulla Fair-Code License. See LICENSE.
-->

# Sulla Server sign-in card: spec for the Keycloak `sulla` login theme

**For:** WP-F (`services/sulla-accounts/keycloak-theme/sulla`). **Source of truth:** the approved
mockup's `sign-in.html` (Sulla Files › `Projects/sulla-server-console/mockups/`). The console never
shows a password form. Every sign-in method goes to Keycloak, so this card has to be the Keycloak
login page.

**See it rendered:** `node resources/sulla-console/dev/serve.mjs --mock`, then open
`http://127.0.0.1:8790/console/sign-in.html` (light/dark with the switch at the bottom of the card).
That page is the vendored Cloud shell's own `renderSignIn()` with the server patches, so it matches
the mockup pixel for pixel.

## Stylesheets and scripts

Copy these from `resources/sulla-console/public/` into the theme's `resources/` and load them in
this order. Don't fork them; re-copy when the console is re-vendored.

| File | Why |
|---|---|
| `css/cloud/tokens.css` | Colour, radius and type tokens for every scheme, light and dark |
| `css/cloud/shell.css` | `.signin`, `.signin-card`, `.brand`, `.seg`, `.themebox`, `.signin-links` |
| `css/cloud/components.css` | `.field`, `.btn`, `.btn.pri`, `.err` |
| `js/cloud/shell/theme-boot.js` | Applies the saved theme before first paint (`localStorage['sulla_cloud_theme']`, e.g. `noir-dark`). Load it in `<head>`, not deferred |
| `js/cloud/shell/icons.js` | Sun and moon icons for the mode switch (optional: inline SVG is fine) |

The approved page loads no web fonts (it uses the token font stacks), so the theme doesn't need any.
No inline `<script>`; the theme switch handler goes in its own file. No third-party requests.

If Keycloak serves the page on the same origin as the console (`https://<host>/realms/...` through
the gateway), the saved theme carries over between the sign-in page and the console automatically.

## Markup

Keycloak's `login.ftl` should produce exactly this structure (classes are what the CSS keys on):

```html
<html lang="en" class="theme-noir-light theme-noir">   <!-- theme-boot.js swaps these classes -->
<body class="is-signin">
<div class="signin"><div class="signin-card">
  <div class="brand"><div class="mark">S</div><div><b>Sulla Server</b><span>${host}</span></div></div>
  <h1>Sign in</h1>
  <p>Use the email address your invitation was sent to.</p>

  <!-- Only when the email-code authenticator exists (later release); omit the whole .seg until then. -->
  <div class="seg" role="tablist" aria-label="Sign-in method">
    <button type="button" role="tab" class="on">Email code</button>
    <button type="button" role="tab">Password</button>
  </div>

  <form action="${url.loginAction}" method="post" novalidate>
    <label>Email<input class="field" name="username" type="email" autocomplete="email" value="${login.username!''}" required></label>
    <label>Password<input class="field" name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn pri" type="submit">Sign in</button>
  </form>
  <div class="err" role="alert">${message.summary}</div>   <!-- empty div when there is no message -->

  <p class="signin-new">No account? Ask your administrator for an invitation.</p>
  <nav class="signin-links" aria-label="Sulla links">
    <a href="https://sulladesktop.com/support.html">Help</a>
    <a href="https://sulladesktop.com/privacy.html">Privacy</a>
    <a href="https://sulladesktop.com/terms.html">Terms</a>
  </nav>

  <div class="themebox" title="Theme: the same token sets Sulla Desktop ships">
    <label class="sel"><span>Theme</span> <b data-theme-label></b>
      <select data-theme-scheme aria-label="Theme"><!-- one <option> per CloudTheme.SCHEMES --></select></label>
    <div class="seg" role="group" aria-label="Mode">
      <button type="button" data-mode="light"><span class="bi"><!-- sun --></span>Light</button>
      <button type="button" data-mode="dark"><span class="bi"><!-- moon --></span>Dark</button>
    </div>
  </div>
</div></div>
</body>
```

- `${host}` is the server's public host name (e.g. `sulla.northwind.co`), not "Sulla Cloud".
- No `style` attributes: the label weight is in `shell.css` (`.themebox [data-theme-label]`), so the
  page works under a `style-src 'self'` policy.
- Theme switch behaviour: `CloudTheme.set({ scheme })` on select change and `CloudTheme.set({ mode })`
  on the Light/Dark buttons; the active mode button gets `class="on"` and `aria-pressed="true"`.

## Must not appear

- No "Register" / "Sign up" link (`registrationAllowed=false`; accounts are invite only).
- No social or SSO buttons, no "Sign in with Apple", no phone tab.
- No "Remember me" checkbox, no locale switcher.
- No "Sulla Cloud" text anywhere.

## Other Keycloak pages that use the same card

Same `.signin-card` shell, brand block, links and theme box, with only the middle part changed:

| Page | Heading | Middle |
|---|---|---|
| `login-update-password.ftl` (invite acceptance, reset) | Set your password | New password + confirm, `Save password` |
| `login-reset-password.ftl` | Reset your password | Email, `Email me a link` |
| `login-otp.ftl` | Two-step verification | 6-digit code (`inputmode="numeric" autocomplete="one-time-code"`), `Verify and sign in` |
| `login-config-totp.ftl` | Set up two-step verification | QR code, manual key, code field |
| `info.ftl`, `error.ftl` | Message title | Message text and a `Back to sign-in` link |

## Acceptance (from BUILD-PLAN.md WP-F)

The Keycloak login page looks like the approved `sign-in.html` in light and dark, with no sign-up or
SSO links. Compare it side by side with `/console/sign-in.html` from the dev server.
