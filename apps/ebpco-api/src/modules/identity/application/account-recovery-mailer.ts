import { Mailer } from '../infrastructure/mailer';
import { PasswordResetTicket } from './identity.service';

/**
 * The one email this service sends today: "set your password".
 *
 * The same ticket serves two different moments that look alike from here but
 * are not: an existing officer who forgot their password, and a newly
 * approved staff account that has never had one (`unusablePasswordHash()` in
 * `access-request.service.ts`). Both redeem the same `/auth/password/reset`
 * link, so one email and one wording covers both — a new account does not
 * need to be told it is "resetting" anything it never had.
 *
 * A THIRD distinction cuts across those two: which portal the account signs
 * into. Every email here used to say "E-BPCO Admin Portal" and link to
 * `PORTAL_BASE_URL` regardless of `ticket.kind` — an applicant who reset a
 * password landed on the staff sign-in page, told the email was for an
 * account they do not have. `ticket.kind` (added alongside this fix, see
 * `identity.service.ts`) is what makes the branch below possible; before it,
 * there was nothing here to branch on.
 */

/** `<`, `&`, etc. in a name or link must not become markup in an HTML email client. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Branding {
  readonly portalName: string;
  readonly baseUrl: string;
}

export class AccountRecoveryMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly adminPortalBaseUrl: string,
    private readonly userPortalBaseUrl: string,
  ) {}

  async sendPasswordSetupLink(to: string, ticket: PasswordResetTicket): Promise<void> {
    const branding: Branding = ticket.kind === 'staff'
      ? { portalName: 'E-BPCO Admin Portal', baseUrl: this.adminPortalBaseUrl }
      : { portalName: 'E-BPCO Citizen Portal', baseUrl: this.userPortalBaseUrl };

    const link = `${branding.baseUrl}/reset-password?token=${encodeURIComponent(ticket.token)}`;
    const expiresInMinutes = Math.max(
      1, Math.round((ticket.expiresAt.getTime() - Date.now()) / 60_000),
    );
    // First name only, in the greeting — "Hi Michaela Cailing," reads like a
    // form letter. Falls back to the address when the name is not on record
    // (an account made before migration 034 recovered it — see /me's doc
    // comment in auth.controller.ts).
    const firstName = ticket.fullName?.trim().split(/\s+/)[0] ?? to;
    const greeting = escapeHtml(firstName);
    const safeLink = escapeHtml(link);
    const safePortalName = escapeHtml(branding.portalName);

    await this.mailer.send({
      to,
      subject: `Set your ${branding.portalName} password`,
      text:
        `Hi ${firstName},\n\n`
        + `Use the link below to set your password for the ${branding.portalName}.\n\n`
        + `${link}\n\n`
        + `This link works once and expires in about ${expiresInMinutes} minutes. `
        + `If you did not request this, you can ignore this email — nothing changes `
        + `on your account until the link above is used.`,
      html: `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5ea;">
      <tr>
        <td style="background:linear-gradient(180deg,#e21414,#d50000 55%,#b30000);padding:32px 24px;text-align:center;">
          <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.02em;">${safePortalName}</div>
          <div style="color:rgba(255,255,255,0.85);font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;margin-top:6px;">
            Password Reset Request
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 28px;">
          <p style="margin:0 0 16px;color:#26262b;font-size:15px;line-height:1.6;">Hi ${greeting},</p>
          <p style="margin:0 0 24px;color:#4a4a52;font-size:14px;line-height:1.6;">
            We received a request to set the password for your ${safePortalName} account.
            Click the button below to choose one. This link expires in about
            <strong>${expiresInMinutes} minutes</strong>.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
            <tr>
              <td style="border-radius:6px;background:#d50000;">
                <a href="${safeLink}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:6px;">
                  Set my password
                </a>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 8px;color:#8a8a94;font-size:12px;line-height:1.6;">
            If the button doesn't work, copy and paste this link into your browser:
          </p>
          <p style="margin:0 0 24px;word-break:break-all;">
            <a href="${safeLink}" style="color:#2563eb;font-size:12px;">${safeLink}</a>
          </p>
          <p style="margin:0;color:#8a8a94;font-size:12px;line-height:1.6;">
            If you did not request this, you can ignore this email — nothing changes on your
            account until the link above is used.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 28px;background:#fafafa;border-top:1px solid #eeeeee;text-align:center;">
          <p style="margin:0;color:#a3a3ad;font-size:11px;">© 2026 Municipality of Castilla, Sorsogon.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    });
  }
}
