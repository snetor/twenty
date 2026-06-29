import { Module } from '@nestjs/common';

import { CountryCodeCreateManyPreQueryHook } from 'src/engine/core-modules/country-code-derivation/query-hooks/country-code.create-many.pre-query-hook';
import { CountryCodeCreateOnePreQueryHook } from 'src/engine/core-modules/country-code-derivation/query-hooks/country-code.create-one.pre-query-hook';
import { CountryCodeUpdateManyPreQueryHook } from 'src/engine/core-modules/country-code-derivation/query-hooks/country-code.update-many.pre-query-hook';
import { CountryCodeUpdateOnePreQueryHook } from 'src/engine/core-modules/country-code-derivation/query-hooks/country-code.update-one.pre-query-hook';
import { CountryCodeFromRelationService } from 'src/engine/core-modules/country-code-derivation/services/country-code-from-relation.service';
import { WorkspaceManyOrAllFlatEntityMapsCacheModule } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.module';
import { GlobalWorkspaceDataSourceModule } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-datasource.module';

@Module({
  imports: [
    GlobalWorkspaceDataSourceModule,
    WorkspaceManyOrAllFlatEntityMapsCacheModule,
  ],
  providers: [
    CountryCodeFromRelationService,
    CountryCodeCreateOnePreQueryHook,
    CountryCodeCreateManyPreQueryHook,
    CountryCodeUpdateOnePreQueryHook,
    CountryCodeUpdateManyPreQueryHook,
  ],
  exports: [
    CountryCodeFromRelationService,
    CountryCodeCreateOnePreQueryHook,
    CountryCodeCreateManyPreQueryHook,
    CountryCodeUpdateOnePreQueryHook,
    CountryCodeUpdateManyPreQueryHook,
  ],
})
export class CountryCodeDerivationModule {}
