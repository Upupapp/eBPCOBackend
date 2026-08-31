import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';

@Module({
  controllers: [AuditController],
  providers: [AuditRepository],
  exports: [AuditRepository],
})
export class AuditModule {}
