import { Module } from '@nestjs/common';

import { StaffBusinessesController } from './staff-businesses.controller';
import { BusinessesController } from './businesses.controller';

/**
 * An applicant's registered businesses.
 *
 * No providers: the controller reads and writes two queries with no rule beyond
 * ownership, and a service whose only method wraps an INSERT adds a layer
 * without adding a decision.
 */
@Module({ controllers: [BusinessesController, StaffBusinessesController] })
export class BusinessesModule {}
