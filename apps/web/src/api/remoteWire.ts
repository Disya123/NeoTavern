/**
 * Remote Product Wire backend factory (M6).
 *
 * Speaks `GET /meta`, `POST /rpc`, `POST /rpc/stream` (SSE) through
 * `HttpTransport` + `ClientSdk` + `RemoteBackend`. The pairing bearer is
 * attached as `Authorization: Bearer` and is never logged.
 */
import { ClientSdk, HttpTransport } from '@neotavern/client-sdk';
import { RemoteBackend } from '@neotavern/neobackend';

export function createRemoteBackend(baseUrl: string, token?: string): RemoteBackend {
  return new RemoteBackend({
    sdk: new ClientSdk({
      transport: new HttpTransport({
        baseUrl,
        authorization: token,
      }),
    }),
  });
}
