import { Injectable, Logger } from '@nestjs/common';

import { In, type ObjectLiteral } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import {
  applyCountryCodeToRecords,
  collectCountryCodeFkIds,
  COUNTRY_CODE_FIELD,
  type CountryCodeRecord,
  getCountryCodeDerivation,
} from 'src/engine/core-modules/country-code-derivation/utils/derive-country-code.util';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { buildFieldMapsFromFlatObjectMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/build-field-maps-from-flat-object-metadata.util';
import { buildObjectIdByNameMaps } from 'src/engine/metadata-modules/flat-object-metadata/utils/build-object-id-by-name-maps.util';
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
//
// Garde-fou : ne fait RIEN si l'objet ne porte pas de champ `countryCode` dans le
// workspace courant (cas des workspaces standard sans cloisonnement) — comme le
// hook actor qui ne s'active que si le champ existe. La lecture de la relation est
// défensive : un échec n'empêche jamais l'écriture (countryCode simplement non
// posé → rattrapé par l'audit backfill).
@Injectable()
export class CountryCodeFromRelationService {
  private readonly logger = new Logger(CountryCodeFromRelationService.name);

  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
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

    const hasCountryCodeField = await this.objectHasCountryCodeField(
      objectMetadataNameSingular,
      authContext.workspace.id,
    );

    if (!hasCountryCodeField) {
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

    try {
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
    } catch (error) {
      // Ne jamais casser l'écriture : on laisse countryCode non posé (l'audit
      // backfill détecte les orphelins), plutôt que de propager l'erreur.
      this.logger.warn(
        `Country code derivation skipped for ${objectMetadataNameSingular}: ${
          error instanceof Error ? error.message : error
        }`,
      );

      return clonedRecords;
    }
  }

  // True si l'objet porte un champ `countryCode` dans le workspace courant.
  // Lecture des flat maps par workspaceId (sans contexte ORM), comme le service
  // actor — pas d'accès base, donc sûr depuis un pre-query hook.
  private async objectHasCountryCodeField(
    objectMetadataNameSingular: string,
    workspaceId: string,
  ): Promise<boolean> {
    const { flatObjectMetadataMaps, flatFieldMetadataMaps } =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        {
          workspaceId,
          flatMapsKeys: ['flatObjectMetadataMaps', 'flatFieldMetadataMaps'],
        },
      );

    const { idByNameSingular } = buildObjectIdByNameMaps(
      flatObjectMetadataMaps,
    );
    const objectId = idByNameSingular[objectMetadataNameSingular];

    if (!isDefined(objectId)) {
      return false;
    }

    const objectMetadata = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: objectId,
      flatEntityMaps: flatObjectMetadataMaps,
    });

    if (!isDefined(objectMetadata)) {
      return false;
    }

    const { fieldIdByName } = buildFieldMapsFromFlatObjectMetadata(
      flatFieldMetadataMaps,
      objectMetadata,
    );

    return isDefined(fieldIdByName[COUNTRY_CODE_FIELD]);
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
