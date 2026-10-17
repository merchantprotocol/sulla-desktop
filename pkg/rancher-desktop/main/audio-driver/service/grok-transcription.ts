import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { issueLocalBrokerContext, requireConfiguredCredentialBroker } from '@pkg/vault-broker';

export type GrokTranscriber = (wav: Buffer, language: string, filename: string, signal: AbortSignal) => Promise<string>;

/** Create a keyless Grok STT adapter. The vault builds multipart and injects the API key. */
export async function createGrokTranscriber(): Promise<GrokTranscriber> {
  const accountId = await getIntegrationService().getActiveAccountId('grok');
  if (!accountId) throw new Error('No active Grok account is configured');

  return async(wav, language, filename, signal) => {
    const ctx = await issueLocalBrokerContext({
      agentId:         'desktop-transcription',
      podId:           'desktop-main',
      credentialScope: { integration_id: 'grok', account_id: accountId },
      signal,
    });
    const broker = requireConfiguredCredentialBroker();
    const result = await broker.execute(broker.requestFor(ctx, {
      operation: 'provider.transcription',
      ref:       { integrationId: 'grok', accountId },
      url:       'https://api.x.ai/v1/stt',
      method:    'POST',
      headers:   { accept: 'application/json' },
      body: {
        audioBase64: wav.toString('base64'),
        language,
        filename,
      },
      injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
      responseType: 'json',
    }), signal);
    if (result.status < 200 || result.status >= 300) throw new Error(`Grok STT returned HTTP ${ result.status }`);
    const text = (result.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') throw new Error('Grok STT returned an invalid response');
    return text;
  };
}
