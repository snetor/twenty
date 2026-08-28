import { Module } from '@nestjs/common';

import { ScopeAssignmentListener } from 'src/engine/core-modules/country-scope/listeners/scope-assignment.listener';
import { ScopePathOnCreateListener } from 'src/engine/core-modules/country-scope/listeners/scope-path-on-create.listener';
import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { GlobalWorkspaceDataSourceModule } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-datasource.module';

@Module({
  imports: [GlobalWorkspaceDataSourceModule],
  providers: [
    CountryScopeService,
    ScopeAssignmentListener,
    ScopePathOnCreateListener,
  ],
  exports: [CountryScopeService],
})
export class CountryScopeModule {}
