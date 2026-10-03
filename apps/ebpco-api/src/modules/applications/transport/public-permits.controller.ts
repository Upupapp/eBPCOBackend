import { Controller, Get, HttpCode, HttpStatus, Inject, Param } from '@nestjs/common';

import { ProblemException } from '../../../common/problem/problem';
import { SQL_CLIENT } from '../../../persistence/persistence.module';
import { SqlClient } from '../../../persistence/sql-client';
import { Public } from '../../identity/transport/guards/public.decorator';

/**
 * Where the QR code on every generated permit points.
 *
 * Public, because the person scanning is a buyer, an inspector or a bank --
 * never the holder. It answers exactly one question -- "did the Municipality
 * issue this permit number?" -- with what is printed on the permit's face
 * anyway: type, number, the business or project, the issue date, and whether
 * it has been released. Never the owner's name, address or contact details.
 *
 * It does NOT say "valid". The system records no revocation or suspension, so
 * it cannot know that a permit is still in force; saying so would be a claim
 * it cannot back. The page tells the reader to confirm standing with the
 * Office of the Municipal Engineer.
 *
 * Until 2026-09-27 the verification page looked the number up in the
 * visitor's own browser data, so a stranger scanning a real permit was told
 * "No record for this permit number" (found live).
 */
@Controller('public/permits')
export class PublicPermitsController {
  constructor(@Inject(SQL_CLIENT) private readonly db: SqlClient) {}

  @Public()
  @Get(':permitNumber')
  @HttpCode(HttpStatus.OK)
  async verify(@Param('permitNumber') permitNumber: string): Promise<Record<string, unknown>> {
    const number = permitNumber.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,40}$/.test(number)) throw ProblemException.notFound('No permit with this number is on record.');

    const found = await this.db.query<{
      permit_number: string; issued_date: Date; permit_type: string;
      business_name: string | null; release_status: string | null; released_at: Date | null;
      archived_at: Date | null; expires_on: string | null; approving_office: string | null;
    }>(
      `select g.permit_number, g.issued_date, a.permit_type, b.name as business_name,
              r.status as release_status, r.released_at, a.archived_at,
              to_char(g.expires_on, 'YYYY-MM-DD') as expires_on, g.approving_office
         from generated_permits g
         join applications a on a.id = g.application_id
         left join businesses b on b.id = a.business_id
         left join permit_releases r on r.application_id = g.application_id
        where upper(g.permit_number) = $1`,
      [number],
    );
    const row = found.rows[0];
    if (row === undefined || row.archived_at !== null) {
      throw ProblemException.notFound('No permit with this number is on record.');
    }
    return {
      permitNumber: row.permit_number,
      permitType: row.permit_type,
      businessName: row.business_name,
      issuedDate: row.issued_date.toISOString(),
      released: row.release_status === 'Released',
      releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
      // So a scanned permit can be checked for still being in force (TC-04).
      expiresOn: row.expires_on,
      approvingOffice: row.approving_office,
    };
  }
}
