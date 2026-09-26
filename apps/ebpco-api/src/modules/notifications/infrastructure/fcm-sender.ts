import { createSign } from 'node:crypto';

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * No SDK: the Admin SDK would bring hundreds of transitive packages for two
 * HTTPS calls. The service account signs a short-lived JWT, Google's token
 * endpoint trades it for an access token (cached until shortly before it
 * expires), and each message is one POST.
 */

export interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** String values only — FCM rejects anything else in `data`. */
  readonly data: Readonly<Record<string, string>>;
}

export type PushOutcome =
  | { readonly ok: true }
  /** `gone`: the token will never work again (app uninstalled or token rotated) — drop the device. */
  | { readonly ok: false; readonly gone: boolean; readonly detail: string };

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** Android notification channel the app creates; must match the app's constant. */
export const ANDROID_CHANNEL_ID = 'ebpco_updates';

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export class FcmSender {
  private cached: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * From the base64 env value. Returns null when unset — push is then simply
   * not configured — and throws on a value that is set but unusable, so a
   * broken key fails the boot rather than every send.
   */
  static fromBase64(value: string): FcmSender | null {
    if (value.trim() === '') return null;
    const parsed = JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8')) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error('FCM_SERVICE_ACCOUNT_JSON_BASE64 is not a service-account JSON');
    }
    return new FcmSender(parsed as ServiceAccount);
  }

  get projectId(): string {
    return this.account.project_id;
  }

  private async accessToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAt > nowMs + 60_000) return this.cached.value;

    const issuedAt = Math.floor(nowMs / 1000);
    const tokenUri = this.account.token_uri ?? DEFAULT_TOKEN_URI;
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key);
    const assertion = `${unsigned}.${base64url(signature)}`;

    const response = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
    });
    if (!response.ok) {
      throw new Error(`FCM token exchange failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FCM token exchange returned no access token');
    this.cached = { value: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async send(deviceToken: string, message: PushMessage): Promise<PushOutcome> {
    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: { priority: 'HIGH', notification: { channel_id: ANDROID_CHANNEL_ID } },
          },
        }),
      },
    );
    if (response.ok) return { ok: true };

    let code = '';
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as {
        error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
      };
      code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? '';
      detail = `${detail} ${code} ${body.error?.message ?? ''}`.trim();
    } catch {
      // A non-JSON error body: the status line is all there is to report.
    }
    // UNREGISTERED: the app was uninstalled or the token rotated. A malformed
    // token is equally permanent. Anything else (quota, 5xx) is worth retrying.
    const gone = code === 'UNREGISTERED' || (response.status === 400 && /registration token/i.test(detail));
    return { ok: false, gone, detail: detail.slice(0, 300) };
  }
}
