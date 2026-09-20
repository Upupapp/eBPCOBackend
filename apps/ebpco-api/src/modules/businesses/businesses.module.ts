import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { ComplianceModule } from '../compliance/compliance.module';
import { StaffBusinessesController } from './staff-businesses.controller';
import { StaffBusinessRegistrationService } from './staff-business-registration.service';
import { BusinessesController } from './businesses.controller';

/**
 * An applicant's registered businesses.
 *
 * The self-service controller reads and writes two queries with no rule
 * beyond ownership, and a service whose only method wraps an INSERT adds a
 * layer without adding a decision -- so it stays providerless. Staff-side
 * registration is different: it resolves (or creates) the owner's account
 * and applicant record before the business can be inserted at all, the same
 * multi-step transaction `SubmissionService.fileOnBehalf` needed, which is
 * why that one gets a real provider.
 */
@Module({
  imports: [ComplianceModule],
  controllers: [BusinessesController, StaffBusinessesController],
  providers: [
    {
      provide: StaffBusinessRegistrationService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new StaffBusinessRegistrationService(db),
    },
  ],
})
export class BusinessesModule {}
