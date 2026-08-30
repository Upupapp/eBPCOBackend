import { Module } from '@nestjs/common';

import { SQL_CLIENT } from '../../persistence/persistence.module';
import { SqlClient } from '../../persistence/sql-client';
import { PermitService } from './application/permit.service';

/**
 * The document at the end of the process, and its handover.
 *
 * Its own module rather than a corner of applications: a permit outlives the
 * application that produced it -- it is checked on site, quoted in a complaint,
 * and superseded by a later one -- and the things that will attach to it next
 * (revocation, amendment, an inspection against its conditions) belong beside
 * it rather than inside the lifecycle.
 */
@Module({
  providers: [
    {
      provide: PermitService,
      inject: [SQL_CLIENT],
      useFactory: (db: SqlClient) => new PermitService(db),
    },
  ],
  exports: [PermitService],
})
export class PermitsModule {}
