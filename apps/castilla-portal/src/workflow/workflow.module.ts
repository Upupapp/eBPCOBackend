import { Module } from '@nestjs/common';

import { SQL_CLIENT, SqlClient } from '../persistence/sql-client';
import { ConfirmationService } from './confirmation.service';
import { WorkflowController } from './workflow.controller';

@Module({
  controllers: [WorkflowController],
  providers: [{
    provide: ConfirmationService,
    inject: [SQL_CLIENT],
    useFactory: (db: SqlClient) => new ConfirmationService(db),
  }],
  exports: [ConfirmationService],
})
export class WorkflowModule {}
