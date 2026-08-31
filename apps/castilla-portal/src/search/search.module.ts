import { Module } from '@nestjs/common';

import { SearchController } from './search.controller';
import { SearchIndexer } from './search-indexer';
import { SearchRepository } from './search.repository';

@Module({
  controllers: [SearchController],
  providers: [SearchRepository, SearchIndexer],
  exports: [SearchRepository, SearchIndexer],
})
export class SearchModule {}
