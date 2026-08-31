import { Controller, Get, Query } from '@nestjs/common';

import { ProblemException } from '../http/problem';
import { SearchRepository, SearchResult } from './search.repository';
import { POLICIES, Cacheable } from '../http/cache';

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchRepository) {}

  @Cacheable(POLICIES.query, () => 'search')
  @Get()
  async query(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('facet') facet?: string,
    @Query('limit') limit?: string,
  ): Promise<{ results: SearchResult[]; total: number }> {
    if (type !== undefined && type !== 'office' && type !== 'permit') {
      throw ProblemException.badRequest("'type' must be 'office' or 'permit'.");
    }
    const take = limit === undefined ? DEFAULT_RESULTS : Number(limit);
    if (!Number.isInteger(take) || take < 1) {
      throw ProblemException.badRequest("'limit' must be a whole number of at least 1.");
    }
    if ((q ?? '').trim() === '' && type === undefined && facet === undefined) {
      // A bare /search is not "everything"; it is a client that forgot to send
      // the query. Returning the whole catalogue would look like it worked.
      throw ProblemException.badRequest("Provide a query term 'q', a 'type', or a 'facet'.");
    }

    const results = await this.search.search({
      ...(q === undefined ? {} : { term: q }),
      ...(type === undefined ? {} : { entityType: type }),
      ...(facet === undefined ? {} : { facet }),
      limit: Math.min(take, MAX_RESULTS),
    });
    return { results, total: results.length };
  }
}
