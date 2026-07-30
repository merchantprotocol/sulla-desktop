// Barrel: re-exports types + registry, auto-registers all providers.

// Auto-register concrete providers on import
import './providers/CodexOAuth';
import './providers/GoogleOAuth';
import './providers/GrokOAuth';
import './providers/IntuitOAuth';
import './providers/OpenAIOAuth';
import './providers/RobinhoodOAuth';

export { OAuthProvider, type OAuthProviderConfig, type OAuthTokenSet } from './OAuthProvider';
export { registerOAuthProvider, getOAuthProvider, getAllOAuthProviders } from './registry';
