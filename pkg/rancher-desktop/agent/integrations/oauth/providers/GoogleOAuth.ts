// Google OAuth 2.0 provider — covers Gmail, Google Calendar, Google Drive, etc.

import { OAuthProvider, type OAuthProviderConfig } from '../OAuthProvider';
import { registerOAuthProvider } from '../registry';

class GoogleOAuthProvider extends OAuthProvider {
  readonly config: OAuthProviderConfig = {
    id:            'google',
    name:          'Google',
    authorizeUrl:  'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:      'https://oauth2.googleapis.com/token',
    revokeUrl:     'https://oauth2.googleapis.com/revoke',
    scopes:        [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    scopeSeparator:       ' ',
    clientAuthMethod:     'body',
    extraAuthorizeParams: {
      access_type: 'offline',
      prompt:      'consent',
    },
    refreshBufferSeconds: 300,
  };
}

const instance = new GoogleOAuthProvider();
registerOAuthProvider(instance);

export default instance;
