import { Brackets, type ObjectLiteral } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import { GraphqlQueryFilterFieldParser } from 'src/engine/api/graphql/graphql-query-runner/graphql-query-parsers/graphql-query-filter/graphql-query-filter-field.parser';
import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { buildFieldMapsFromFlatObjectMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/build-field-maps-from-flat-object-metadata.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-select-query-builder';

// Cloisonnement par pays (AGPL, autonome). Branché au choke-point ORM unique
// `WorkspaceSelectQueryBuilder.validatePermissions()`, après les checks object-level.
// N'importe ni ne réutilise le code Enterprise (`apply-row-level-permission-predicates.util.ts`),
// qui n'est qu'un patron de forme.

const ALL_COUNTRIES = '*';
const COUNTRY_FIELD = 'countryCode';
const MEMBER_SCOPE_FIELD = 'allowedCountries';

type ApplyCountryPermissionFilterArgs<T extends ObjectLiteral> = {
  queryBuilder: WorkspaceSelectQueryBuilder<T>;
  objectMetadata: FlatObjectMetadata;
  internalContext: WorkspaceInternalContext;
  authContext: WorkspaceAuthContext;
};

export const applyCountryPermissionFilter = <T extends ObjectLiteral>({
  queryBuilder,
  objectMetadata,
  internalContext,
  authContext,
}: ApplyCountryPermissionFilterArgs<T>): void => {
  // 1. Bypass : seul un contexte utilisateur est filtré.
  //    Clé API serveur (ingestion) / contexte système ne sont JAMAIS filtrés.
  if (!isUserAuthContext(authContext)) {
    return;
  }

  // 2. Scope de l'utilisateur courant, lu sur le champ custom hydraté du workspaceMember.
  const raw = Object.entries(authContext.workspaceMember).find(
    ([key]) => key === MEMBER_SCOPE_FIELD,
  )?.[1] as string | undefined;

  if (raw === ALL_COUNTRIES) {
    return; // « tous pays » (managers de zone large / ExCom / admins) : pas de filtre
  }

  const allowed = (raw ?? '')
    .split(';')
    .map((iso) => iso.trim().toUpperCase())
    .filter((iso) => iso.length > 0);

  // 3. Objet concerné ? Cloisonné ssi il porte un champ `countryCode`.
  //    Sinon (objets système, métadonnées, mission*) : pas de filtre.
  //    (* mission = différé itération 2, cf. COUNTRY_FILTER_SPIKE.md)
  const { fieldIdByName } = buildFieldMapsFromFlatObjectMetadata(
    internalContext.flatFieldMetadataMaps,
    objectMetadata,
  );

  if (!isDefined(fieldIdByName[COUNTRY_FIELD])) {
    return;
  }

  // 4. Injection (default-deny si `allowed` est vide).
  injectCountryWhere(queryBuilder, objectMetadata, internalContext, allowed);
};

const injectCountryWhere = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
  objectMetadata: FlatObjectMetadata,
  internalContext: WorkspaceInternalContext,
  allowed: string[],
): void => {
  // parseKeyFilter (Enterprise, privé) délègue son default case à
  // GraphqlQueryFilterFieldParser.parse — on appelle directement le parser public.
  // Il ne sert que la surface de jointure, on élargit donc à ObjectLiteral.
  const outerQueryBuilder =
    queryBuilder as WorkspaceSelectQueryBuilder<ObjectLiteral>;

  const condition = new Brackets((qb) => {
    if (allowed.length === 0) {
      qb.where('1 = 0'); // default-deny : un sales sans pays ne voit rien
      return;
    }

    const fieldParser = new GraphqlQueryFilterFieldParser(
      objectMetadata,
      internalContext.flatFieldMetadataMaps,
    );

    // `countryCode IN (:...allowed)` via le field parser (gère l'alias + les params)
    fieldParser.parse(
      qb,
      outerQueryBuilder,
      objectMetadata.nameSingular,
      COUNTRY_FIELD,
      { in: allowed },
      true,
      false,
    );
  });

  if (queryBuilder.expressionMap.wheres.length === 0) {
    queryBuilder.where(condition);
  } else {
    queryBuilder.andWhere(condition);
  }
};
