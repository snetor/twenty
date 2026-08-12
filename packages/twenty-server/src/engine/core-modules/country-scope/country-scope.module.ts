import { Module } from '@nestjs/common';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { GlobalWorkspaceDataSourceModule } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-datasource.module';

@Module({
  imports: [GlobalWorkspaceDataSourceModule],
  providers: [CountryScopeService],
  exports: [CountryScopeService],
})
export class CountryScopeModule {}
