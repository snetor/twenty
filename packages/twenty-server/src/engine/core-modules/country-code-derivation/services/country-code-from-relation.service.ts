import { Injectable } from '@nestjs/common';

import { In, type ObjectLiteral } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  applyCountryCodeToRecords,
  collectCountryCodeFkIds,
  type CountryCodeRecord,
  getCountryCodeDerivation,
} from 'src/engine/core-modules/country-code-derivation/utils/derive-country-code.util';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

export type InjectCountryCodeParams = {
  records: CountryCodeRecord[];
  objectMetadataNameSingular: string;
  authContext: WorkspaceAuthContext;
};

// Dérive `countryCode` à l'écriture (create/update, UI comme API) en résolvant
// la relation pays côté base : company depuis sa relation `country` (isoCode),
// enfants (person/opportunity/clientProduct/visit) depuis le `countryCode` de
// leur company parente. Synchrone (pre-query hook) : pas de fenêtre d'invisibilité.
@Injectable()
export class CountryCodeFromRelationService {
  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  async injectCountryCode({
    records,
    objectMetadataNameSingular,
    authContext,
  }: InjectCountryCodeParams): Promise<CountryCodeRecord[]> {
    const derivation = getCountryCodeDerivation(objectMetadataNameSingular);

    if (!isDefined(derivation)) {
      return records;
    }

    const clonedRecords = structuredClone(records);
    const fkIds = collectCountryCodeFkIds(
      objectMetadataNameSingular,
      clonedRecords,
    );

    if (fkIds.length === 0) {
      return clonedRecords;
    }

    const countryCodeByFkId =
      await this.globalWorkspaceOrmManager.executeInWorkspaceContext(
        () =>
          this.resolveCountryCodeByFkId(
            derivation.kind,
            authContext.workspace.id,
            fkIds,
          ),
        authContext,
      );

    return applyCountryCodeToRecords(
      objectMetadataNameSingular,
      clonedRecords,
      countryCodeByFkId,
    );
  }

  private async resolveCountryCodeByFkId(
    kind: 'self' | 'parent',
    workspaceId: string,
    fkIds: string[],
  ): Promise<Map<string, string | null>> {
    if (kind === 'self') {
      // company.countryId -> country.isoCode
      const countryRepository =
        await this.globalWorkspaceOrmManager.getRepository<
          ObjectLiteral & { id: string; isoCode?: string | null }
        >(workspaceId, 'country');
      const countries = await countryRepository.find({
        where: { id: In(fkIds) },
      });

      return new Map(
        countries.map((country) => [
          country.id,
          isDefined(country.isoCode) && country.isoCode.length > 0
            ? country.isoCode.toUpperCase()
            : null,
        ]),
      );
    }

    // (person|opportunity).companyId / (clientProduct|visit).clientId -> company.countryCode
    const companyRepository =
      await this.globalWorkspaceOrmManager.getRepository<
        ObjectLiteral & { id: string; countryCode?: string | null }
      >(workspaceId, 'company');
    const companies = await companyRepository.find({
      where: { id: In(fkIds) },
    });

    return new Map(
      companies.map((company) => [company.id, company.countryCode ?? null]),
    );
  }
}
