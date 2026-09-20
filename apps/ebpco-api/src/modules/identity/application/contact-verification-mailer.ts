import { Mailer } from '../infrastructure/mailer';

/**
 * The one email this sends: "here is your 6-digit code".
 *
 * Mirrors `account-recovery-mailer.ts`'s own shape and reasoning — same
 * escaping discipline, same plain-text-always-present rule. There is no
 * link here, only a code the applicant types back into the form they are
 * already looking at, so there is no portal-branding branch to get wrong.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class ContactVerificationMailer {
  constructor(private readonly mailer: Mailer) {}

  /** True only for a driver that actually delivers — see `Mailer.real`'s own doc comment. */
  get real(): boolean {
    return this.mailer.real;
  }

  async sendCode(to: string, code: string): Promise<void> {
    const safeCode = escapeHtml(code);

    await this.mailer.send({
      to,
      subject: `Your E-BPCO verification code: ${code}`,
      text:
        `Your E-BPCO verification code is ${code}.\n\n`
        + `Enter it on the page where you requested it to confirm this email address. `
        + `This code expires in a few minutes. If you did not request this, you can ignore this email — `
        + `nothing changes on your account until the code above is used.`,
      html: `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e5ea;">
      <tr>
        <td style="background:linear-gradient(180deg,#e21414,#d50000 55%,#b30000);padding:28px 24px;text-align:center;">
          <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;">E-BPCO</div>
          <div style="color:rgba(255,255,255,0.85);font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;margin-top:6px;">
            Verify This Email Address
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 28px;text-align:center;">
          <p style="margin:0 0 20px;color:#4a4a52;font-size:14px;line-height:1.6;">
            Enter this code on the page where you requested it:
          </p>
          <div style="margin:0 0 20px;font-size:32px;font-weight:800;letter-spacing:0.18em;color:#26262b;">
            ${safeCode}
          </div>
          <p style="margin:0;color:#8a8a94;font-size:12px;line-height:1.6;">
            If you did not request this, you can ignore this email — nothing changes on your
            account until the code above is used.
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
